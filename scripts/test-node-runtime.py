"""Isolated archive/receipt checks; no host installation or external requests."""
import hashlib
import importlib.util
import io
from pathlib import Path
import platform
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proser_runtime', Path(__file__).with_name('install-node-runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class Response(io.BytesIO):
    url = f'https://nodejs.org/dist/v{runtime.VERSION}/node-v{runtime.VERSION}-linux-x64.tar.xz'


def archive(unsafe=False):
    result = io.BytesIO()
    release = f'node-v{runtime.VERSION}-linux-x64'
    with tarfile.open(fileobj=result, mode='w:xz') as output:
        for name, contents, mode in [('bin/node', b"#!/bin/sh\nprintf 'v24.22.3\\n'\n", 0o755), ('LICENSE', b'Isolated runtime test fixture\n', 0o644)]:
            entry = tarfile.TarInfo(f'{release}/{name}'); entry.size = len(contents); entry.mode = mode
            output.addfile(entry, io.BytesIO(contents))
        if unsafe:
            entry = tarfile.TarInfo(f'{release}/../escape'); entry.size = 1
            output.addfile(entry, io.BytesIO(b'x'))
    return result.getvalue()


class RuntimeChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='proser-runtime-fixture-')
        self.prefix = Path(self.temporary.name) / 'runtime'

    def tearDown(self):
        self.temporary.cleanup()

    def install(self, data=None, expected=None):
        data = archive() if data is None else data
        expected = hashlib.sha256(data).hexdigest() if expected is None else expected
        with patch.dict(runtime.DIGESTS, {platform.machine(): ('x64', expected)}), patch.object(runtime.urllib.request, 'urlopen', return_value=Response(data)) as transport:
            result = runtime.install(self.prefix)
            return result, expected, transport.call_count

    def test_install_is_immutable_idempotent_and_rejects_modified_tree_before_execution(self):
        target, expected, calls = self.install()
        self.assertEqual(calls, 1)
        with patch.dict(runtime.DIGESTS, {platform.machine(): ('x64', expected)}), patch.object(runtime.urllib.request, 'urlopen') as transport:
            self.assertEqual(runtime.install(self.prefix, check_only=True), target)
            transport.assert_not_called()
        (target / 'LICENSE').write_text('Modified fixture\n')
        with self.assertRaisesRegex(RuntimeError, 'pinned receipt'):
            runtime.verify(target, expected)

    def test_archive_checksum_mismatch_leaves_no_installed_runtime(self):
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            self.install(expected='0' * 64)
        self.assertFalse((self.prefix / f'node-v{runtime.VERSION}').exists())

    def test_archive_paths_cannot_escape_even_with_an_exact_fixture_checksum(self):
        with self.assertRaisesRegex(RuntimeError, 'Unsafe runtime archive'):
            self.install(data=archive(unsafe=True))
        self.assertFalse((Path(self.temporary.name) / 'escape').exists())

    def test_receipts_cannot_be_writable_by_other_actors(self):
        target, expected, _ = self.install()
        (target / 'INSTALLATION.json').chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, 'receipt ownership'):
            runtime.verify(target, expected)

    def test_prefix_cannot_be_owned_through_a_symlink_or_shared_writes(self):
        self.prefix.mkdir(mode=0o777); self.prefix.chmod(0o777)
        with self.assertRaisesRegex(RuntimeError, 'protected'):
            runtime.install(self.prefix)


if __name__ == '__main__':
    unittest.main()
