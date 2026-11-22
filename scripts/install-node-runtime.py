#!/usr/bin/env python3
"""Install an immutable official Node runtime without replacing host-wide Node."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = '24.22.1'
DIGESTS = {
    'x86_64': ('x64', '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6'),
    'aarch64': ('arm64', 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e'),
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def tree_digest(target):
    manifest = []
    owner = target.stat().st_uid
    for entry in sorted(target.rglob('*')):
        if entry == target / 'INSTALLATION.json':
            continue
        relative = entry.relative_to(target).as_posix()
        info = entry.lstat()
        if info.st_uid != owner or not entry.is_symlink() and info.st_mode & 0o022:
            raise RuntimeError('Runtime entry is writable outside its installer owner.')
        if entry.is_symlink():
            manifest.append([relative, 'link', os.readlink(entry)])
        elif entry.is_file():
            manifest.append([relative, 'file', entry.stat().st_mode & 0o777, digest(entry)])
        elif entry.is_dir():
            manifest.append([relative, 'directory', entry.stat().st_mode & 0o777])
        else:
            raise RuntimeError('Unexpected installed runtime entry.')
    return hashlib.sha256(json.dumps(manifest, separators=(',', ':')).encode()).hexdigest()


def verify(target, archive_sha256):
    if target.is_symlink() or target.stat().st_uid != target.parent.stat().st_uid or target.stat().st_mode & 0o022:
        raise RuntimeError('Installed runtime ownership or directory permissions are unsafe.')
    receipt_path = target / 'INSTALLATION.json'
    if receipt_path.is_symlink() or receipt_path.stat().st_uid != target.stat().st_uid or receipt_path.stat().st_mode & 0o022:
        raise RuntimeError('Installed runtime receipt ownership is unsafe.')
    receipt = json.loads(receipt_path.read_text())
    node = target / 'bin/node'
    if receipt.get('version') != VERSION or receipt.get('archiveSha256') != archive_sha256 or receipt.get('nodeSha256') != digest(node) or receipt.get('treeSha256') != tree_digest(target):
        raise RuntimeError('Installed runtime does not match its pinned receipt; leave it fenced for repair.')
    if subprocess.check_output([str(node), '--version'], text=True).strip() != f'v{VERSION}':
        raise RuntimeError('Installed runtime reports a different version.')


def install(prefix, check_only=False):
    arch, archive_sha256 = DIGESTS[platform.machine()]
    target = prefix / f'node-v{VERSION}'
    if prefix.exists() and (prefix.is_symlink() or prefix.stat().st_mode & 0o022):
        raise RuntimeError('Runtime prefix must be a directory protected from other writers.')
    if target.exists():
        verify(target, archive_sha256)
        return target
    if check_only:
        raise RuntimeError('Pinned runtime has not been installed.')
    prefix.mkdir(mode=0o755, parents=True, exist_ok=True)
    release = f'node-v{VERSION}-linux-{arch}'
    url = f'https://nodejs.org/dist/v{VERSION}/{release}.tar.xz'
    with tempfile.TemporaryDirectory(prefix='.node-install-', dir=prefix) as temporary:
        staging = Path(temporary)
        archive = staging / 'node.tar.xz'
        request = urllib.request.Request(url, headers={'User-Agent': 'Proser-runtime-installer/1'})
        with urllib.request.urlopen(request, timeout=60) as response, archive.open('xb') as output:
            if response.url != url:
                raise RuntimeError('Unexpected runtime archive redirect.')
            length = 0
            while chunk := response.read(1024 * 1024):
                length += len(chunk)
                if length > 100 * 1024 * 1024:
                    raise RuntimeError('Runtime archive exceeds the expected size bound.')
                output.write(chunk)
        if digest(archive) != archive_sha256:
            raise RuntimeError('Official runtime archive checksum differs from the pinned release.')
        with tarfile.open(archive, 'r:xz') as bundle:
            entries = bundle.getmembers()
            if len(entries) > 10000 or sum(entry.size for entry in entries) > 512 * 1024 * 1024:
                raise RuntimeError('Runtime archive exceeds the expanded size bounds.')
            for entry in entries:
                parts = PurePosixPath(entry.name).parts
                if not parts or parts[0] != release or '..' in parts or entry.name.startswith('/') or not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()):
                    raise RuntimeError('Unsafe runtime archive entry.')
            bundle.extractall(staging, filter='data')
        extracted = staging / release
        extracted.chmod(0o755)
        for entry in extracted.rglob('*'):
            if not entry.is_symlink():
                entry.chmod(entry.stat().st_mode & 0o755)
        receipt = {'schemaVersion': 1, 'version': VERSION, 'architecture': arch, 'source': url, 'archiveSha256': archive_sha256, 'nodeSha256': digest(extracted / 'bin/node'), 'treeSha256': tree_digest(extracted)}
        (extracted / 'INSTALLATION.json').write_text(json.dumps(receipt, sort_keys=True) + '\n')
        (extracted / 'INSTALLATION.json').chmod(0o644)
        verify(extracted, archive_sha256)
        try:
            os.rename(extracted, target)
        except OSError as error:
            if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            verify(target, archive_sha256)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, default=Path('/opt/proser-runtime'))
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if not args.prefix.is_absolute():
        parser.error('The runtime prefix must be absolute.')
    print(json.dumps({'runtime': str(install(args.prefix, args.check_only)), 'version': VERSION}, sort_keys=True))
