#!/usr/bin/env python3
"""Fixed host-side Proser Factory code-only release with a retained PostgreSQL dump."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

BASE = Path('/opt/proser-factory')
PROTECTED = ('package.json', 'package-lock.json', 'prisma.config.ts',
             'prisma/schema.prisma', 'prisma/migrations',
             'deploy/proser-factory.service', 'deploy/proser-worker.service')
UNITS = ('proser-factory.service', 'proser-worker.service')
RELEASE = re.compile(r'[a-z0-9][a-z0-9-]{7,79}\Z')


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=kwargs.pop('timeout', 120), **kwargs)


def sha_file(file):
    digest = hashlib.sha256()
    with file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root, names):
    digest = hashlib.sha256()
    def visit(relative):
        item = root / relative
        if item.is_symlink() or not item.exists():
            raise ValueError(f'Protected path absent or aliased: {relative}')
        if item.is_dir():
            digest.update(b'dir\0' + str(relative).encode() + b'\0')
            for child in sorted(item.iterdir(), key=lambda entry: entry.name):
                visit(relative / child.name)
        elif item.is_file():
            digest.update(b'file\0' + str(relative).encode() + b'\0')
            digest.update(str(item.stat().st_size).encode() + b'\0')
            digest.update(sha_file(item).encode() + b'\0')
        else:
            raise ValueError(f'Unsupported protected path: {relative}')
    for name in PROTECTED if names is None else names:
        visit(Path(name))
    return digest.hexdigest()


def dist_digest(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Factory dist absent or aliased')
    digest = hashlib.sha256()
    for item in sorted(directory.rglob('*')):
        if item.is_symlink() or not (item.is_file() or item.is_dir()):
            raise ValueError('Factory dist contains a link or unexpected file')
        relative = item.relative_to(directory).as_posix()
        digest.update((('dir' if item.is_dir() else 'file') + '\0' + relative + '\0').encode())
        if item.is_file():
            digest.update(str(item.stat().st_size).encode() + b'\0' + sha_file(item).encode() + b'\0')
    return digest.hexdigest()


def write_once(file, record):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = file.with_name(f'{file.name}.{os.getpid()}.new')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(record, output, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, file)
        descriptor = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def write_revision(file, revision):
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Factory revision is invalid')
    stat = file.stat()
    temporary = file.with_name(f'{file.name}.{os.getpid()}.new')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.st_mode & 0o777)
    try:
        os.fchown(descriptor, stat.st_uid, stat.st_gid)
        with os.fdopen(descriptor, 'w') as output:
            output.write(f'{revision}\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, file)
        descriptor = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def read_record(file):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 32_768:
        raise ValueError('Release receipt missing or unsafe')
    return json.loads(file.read_text())


def active():
    return all(subprocess.run(['systemctl', 'is-active', '--quiet', unit], timeout=10).returncode == 0 for unit in UNITS)


def units_digest():
    return hashlib.sha256(b''.join(run(['systemctl', 'cat', unit]).stdout for unit in UNITS)).hexdigest()


def migrations():
    local = {item.name for item in (BASE / 'prisma/migrations').iterdir() if item.is_dir()}
    sql = ('SELECT migration_name FROM "_prisma_migrations" '
           'WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;')
    applied = set(run(['docker', 'exec', 'proser-postgres', 'psql', '-U', 'proser', '-d', 'proser',
                       '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.decode().splitlines())
    unresolved = run(['docker', 'exec', 'proser-postgres', 'psql', '-U', 'proser', '-d', 'proser',
                      '-tA', '-v', 'ON_ERROR_STOP=1', '-c',
                      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;']).stdout.strip()
    if not local or local != applied or unresolved != b'0':
        raise ValueError(f'Prisma migration gate failed: pending={len(local - applied)}, unexpected={len(applied - local)}, unresolved={unresolved.decode()}')
    return hashlib.sha256('\n'.join(sorted(applied)).encode()).hexdigest()


def probe():
    for unit in UNITS:
        if subprocess.run(['systemctl', 'is-active', '--quiet', unit], timeout=10).returncode != 0:
            raise ValueError(f'{unit} is inactive')
    last = None
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3001/health', timeout=3) as response:
                health = json.load(response)
            with urllib.request.urlopen('http://127.0.0.1:3001/api/readiness', timeout=3) as response:
                readiness = json.load(response)
            if (health.get('status') == 'ok' and
                health.get('services', {}).get('database', {}).get('status') == 'healthy' and
                health.get('services', {}).get('redis', {}).get('status') == 'healthy' and
                readiness.get('data', {}).get('ready') is True):
                break
        except Exception as error:
            last = error
        time.sleep(1)
    else:
        raise ValueError(f'Factory database/Redis readiness failed: {type(last).__name__}')
    try:
        urllib.request.urlopen('http://127.0.0.1:3001/api/models', timeout=3)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise ValueError('Factory anonymous models gate differs') from error
    else:
        raise ValueError('Factory anonymous models gate is open')
    return ['factory-db-and-redis-ready=200', 'factory-anonymous-models=401']


def safe_extract(archive, destination):
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        if not members or any(not (member.isfile() or member.isdir()) or
                              not (member.name == 'dist' or member.name.startswith('dist/')) or
                              '..' in Path(member.name).parts for member in members):
            raise ValueError('Factory artifact contains an unsafe entry')
        bundle.extractall(destination, filter='data')
    if not (destination / 'dist/index.js').is_file():
        raise ValueError('Factory artifact lacks dist/index.js')


def database_dump(folder):
    target = folder / 'proser-before.dump'
    with target.open('xb') as output:
        subprocess.run(['docker', 'exec', 'proser-postgres', 'pg_dump', '-U', 'proser', '-d', 'proser', '-Fc'],
                       stdout=output, stderr=subprocess.PIPE, check=True, timeout=180)
        output.flush()
        os.fsync(output.fileno())
    target.chmod(0o600)
    with target.open('rb') as source:
        run(['docker', 'exec', '-i', 'proser-postgres', 'pg_restore', '--list'], stdin=source, timeout=60)
    return {'path': str(target), 'sha256': sha_file(target), 'bytes': target.stat().st_size,
            'validation': 'pg_restore-list'}


def execute(mode, release_id, expected, archive):
    if not RELEASE.fullmatch(release_id):
        raise ValueError('Unsafe Factory release ID')
    if BASE.is_symlink() or not BASE.is_dir():
        raise ValueError('Factory install root is absent or aliased')
    dist = BASE / 'dist'
    revision_file = BASE / 'REVISION'
    prior_revision = revision_file.read_text().strip()
    protected = tree_digest(BASE, None)
    unit_hash = units_digest()
    current = dist_digest(dist)
    migration_hash = migrations()
    folder = BASE / 'checkpoints' / f'council-{release_id}'
    if mode == 'status':
        if not active():
            raise ValueError('Factory services are inactive')
        flows = probe()
        return {'protectedDigest': protected, 'unitDigest': unit_hash, 'currentDigest': current,
                'migrationDigest': migration_hash, 'installedRevision': prior_revision,
                'health': 'passed', 'functionalFlows': flows}
    if mode == 'deploy':
        if folder.exists() or folder.is_symlink():
            if (folder / 'deployed.json').exists():
                receipt = read_record(folder / 'deployed.json')
                if current == receipt['candidateDigest'] and prior_revision == receipt['sourceSha']:
                    return receipt
            raise ValueError('Factory release already started; inspect its exact intent and live state')
        if not active() or (protected, unit_hash, current, migration_hash, prior_revision) != tuple(expected[key] for key in
            ('protectedDigest', 'unitDigest', 'priorDigest', 'migrationDigest', 'priorRevision')):
            raise ValueError('Factory code, schema, migration, revision, or service state drifted')
        if not archive or sha_file(Path(archive)) != expected['artifactSha256']:
            raise ValueError('Factory artifact digest differs')
        run(['node', str(dist / 'lib/redis/persistencePreflight.js')], cwd=BASE, timeout=90)
        folder.mkdir(mode=0o700, parents=True)
        safe_extract(Path(archive), folder)
        if dist_digest(folder / 'dist') != expected['candidateDigest']:
            raise ValueError('Factory staged dist digest differs')
        backup = database_dump(folder)
        intent = {'schema': 1, 'releaseId': release_id, 'sourceSha': expected['sourceSha'],
                  'priorRevision': prior_revision, 'priorDigest': current,
                  'candidateDigest': expected['candidateDigest'], 'artifactSha256': expected['artifactSha256'],
                  'protectedDigest': protected, 'unitDigest': unit_hash, 'migrationDigest': migration_hash,
                  'databaseBackup': backup, 'databaseRestored': False,
                  'redisPersistencePreflight': 'passed', 'startedAt': int(time.time())}
        write_once(folder / 'intent.json', intent)
        try:
            for unit in UNITS:
                run(['systemctl', 'stop', unit], timeout=60)
            os.replace(dist, folder / 'previous-dist')
            os.replace(folder / 'dist', dist)
            write_revision(revision_file, expected['sourceSha'])
            for unit in UNITS:
                run(['systemctl', 'start', unit], timeout=60)
            flows = probe()
            if dist_digest(dist) != expected['candidateDigest'] or migrations() != migration_hash:
                raise ValueError('Factory installed code or migration state drifted')
        except Exception as error:
            recovery = {'state': 'unknown', 'databaseRestored': False}
            if (folder / 'previous-dist').exists():
                try:
                    for unit in UNITS:
                        subprocess.run(['systemctl', 'stop', unit], timeout=60, check=False)
                    if dist.exists():
                        os.replace(dist, folder / 'failed-dist')
                    os.replace(folder / 'previous-dist', dist)
                    write_revision(revision_file, prior_revision)
                    for unit in UNITS:
                        run(['systemctl', 'start', unit], timeout=60)
                    recovery = {'state': 'prior-code-restored', 'databaseRestored': False,
                                'functionalFlows': probe()}
                except Exception as recovery_error:
                    recovery = {'state': 'unknown', 'databaseRestored': False,
                                'reason': type(recovery_error).__name__}
            write_once(folder / 'failed.json', {'status': 'failed', 'releaseId': release_id,
                                                'reason': type(error).__name__, 'recovery': recovery,
                                                'databaseBackup': backup})
            raise
        receipt = {**intent, 'status': 'deployed', 'installedDigest': expected['candidateDigest'],
                   'installedRevision': expected['sourceSha'], 'health': 'passed', 'functionalFlows': flows}
        write_once(folder / 'deployed.json', receipt)
        return receipt
    if mode == 'rollback':
        receipt = read_record(folder / 'deployed.json')
        if (folder / 'rolled-back.json').exists():
            return read_record(folder / 'rolled-back.json')
        previous = folder / 'previous-dist'
        if (prior_revision != receipt['sourceSha'] or current != receipt['candidateDigest'] or
            dist_digest(previous) != receipt['priorDigest'] or
            (protected, unit_hash, migration_hash) != tuple(receipt[key] for key in
             ('protectedDigest', 'unitDigest', 'migrationDigest')) or not active() or
            sha_file(Path(receipt['databaseBackup']['path'])) != receipt['databaseBackup']['sha256']):
            raise ValueError('Factory rollback held: candidate, backup, schema, migration, or services drifted')
        write_once(folder / 'rollback-intent.json', {'releaseId': release_id, 'startedAt': int(time.time())})
        for unit in UNITS:
            run(['systemctl', 'stop', unit], timeout=60)
        os.replace(dist, folder / 'candidate-dist')
        os.replace(previous, dist)
        write_revision(revision_file, receipt['priorRevision'])
        for unit in UNITS:
            run(['systemctl', 'start', unit], timeout=60)
        flows = probe()
        if dist_digest(dist) != receipt['priorDigest'] or migrations() != migration_hash:
            raise ValueError('Factory rollback outcome requires reconciliation')
        result = {'schema': 1, 'releaseId': release_id, 'status': 'rolled-back',
                  'installedRevision': receipt['priorRevision'], 'restoredDigest': receipt['priorDigest'],
                  'databaseRestored': False, 'databaseBackup': receipt['databaseBackup'],
                  'health': 'passed', 'functionalFlows': flows}
        write_once(folder / 'rolled-back.json', result)
        return result
    raise ValueError('Unknown Factory release mode')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('local', 'status', 'deploy', 'rollback'))
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--base', default='')
    parser.add_argument('--expected', default='')
    parser.add_argument('--archive', default='')
    args = parser.parse_args()
    try:
        if args.mode == 'local':
            source = Path(args.base)
            if not source.is_absolute():
                raise ValueError('Local Factory source must be absolute')
            print(json.dumps({'protectedDigest': tree_digest(source, None),
                              'candidateDigest': dist_digest(source / 'dist')}, sort_keys=True))
        else:
            if os.geteuid() != 0:
                raise ValueError('Root is required for the host-side Factory release')
            lock = Path('/run/lock/proser-factory-council-code.lock')
            with lock.open('a+') as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                print(json.dumps(execute(args.mode, args.release_id,
                    json.loads(args.expected) if args.expected else {}, args.archive or None), sort_keys=True))
    except Exception as error:
        print(str(error)[:800], file=sys.stderr)
        raise SystemExit(2)
