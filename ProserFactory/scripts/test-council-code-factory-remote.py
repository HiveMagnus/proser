#!/usr/bin/env python3
"""Focused code-only Factory release and rollback contract tests."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('council-code-factory-remote.py')
SPEC = importlib.util.spec_from_file_location('factory_release', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FactoryReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name) / 'factory'
        self.base.mkdir()
        for name in MODULE.PROTECTED:
            file = self.base / name
            if name == 'prisma/migrations':
                file.mkdir(parents=True)
                (file / '20260901_test').mkdir()
                (file / '20260901_test/migration.sql').write_text('SELECT 1;')
            else:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(name)
        (self.base / 'dist').mkdir()
        (self.base / 'dist/index.js').write_text('prior')
        (self.base / 'REVISION').write_text('a' * 40 + '\n')
        self.archive = Path(self.temporary.name) / 'dist.tgz'
        with tarfile.open(self.archive, 'w:gz') as bundle:
            payload = b'candidate'
            entry = tarfile.TarInfo('dist/index.js')
            entry.size = len(payload)
            bundle.addfile(entry, io.BytesIO(payload))
        self.candidate = Path(self.temporary.name) / 'candidate'
        self.candidate.mkdir()
        MODULE.safe_extract(self.archive, self.candidate)
        self.expected = {'sourceSha': 'b' * 40, 'priorRevision': 'a' * 40,
                         'protectedDigest': MODULE.tree_digest(self.base, None),
                         'unitDigest': 'c' * 64, 'migrationDigest': 'd' * 64,
                         'priorDigest': MODULE.dist_digest(self.base / 'dist'),
                         'candidateDigest': MODULE.dist_digest(self.candidate / 'dist'),
                         'artifactSha256': MODULE.sha_file(self.archive)}
        self.patches = [patch.object(MODULE, 'BASE', self.base),
                        patch.object(MODULE, 'units_digest', return_value='c' * 64),
                        patch.object(MODULE, 'migrations', return_value='d' * 64),
                        patch.object(MODULE, 'active', return_value=True),
                        patch.object(MODULE, 'probe', return_value=['factory-db-and-redis-ready=200', 'factory-anonymous-models=401']),
                        patch.object(MODULE, 'run', return_value=None),
                        patch.object(MODULE, 'database_dump', side_effect=self.dump)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def dump(self, folder):
        file = folder / 'proser-before.dump'
        file.write_bytes(b'valid-test-dump')
        return {'path': str(file), 'sha256': MODULE.sha_file(file), 'bytes': file.stat().st_size,
                'validation': 'pg_restore-list'}

    def test_exact_code_and_database_rollback_without_schema_change(self):
        deployed = MODULE.execute('deploy', 'factory-canary', self.expected, str(self.archive))
        self.assertEqual(deployed['status'], 'deployed')
        self.assertEqual((self.base / 'REVISION').read_text().strip(), 'b' * 40)
        self.assertEqual(MODULE.execute('deploy', 'factory-canary', self.expected, str(self.archive)), deployed)
        restored = MODULE.execute('rollback', 'factory-canary', {}, None)
        self.assertEqual(restored['status'], 'rolled-back')
        self.assertFalse(restored['databaseRestored'])
        self.assertEqual(restored['restoredDigest'], self.expected['priorDigest'])
        self.assertEqual((self.base / 'REVISION').read_text().strip(), 'a' * 40)

    def test_migration_drift_blocks_activation(self):
        with patch.object(MODULE, 'migrations', return_value='changed'):
            with self.assertRaisesRegex(ValueError, 'drifted'):
                MODULE.execute('deploy', 'factory-canary', self.expected, str(self.archive))
        self.assertFalse((self.base / 'checkpoints/council-factory-canary').exists())

    def test_redis_persistence_failure_blocks_before_backup_or_stop(self):
        with patch.object(MODULE, 'run', side_effect=RuntimeError('Redis snapshot failed')):
            with self.assertRaisesRegex(RuntimeError, 'Redis snapshot failed'):
                MODULE.execute('deploy', 'factory-canary', self.expected, str(self.archive))
        self.assertFalse((self.base / 'checkpoints/council-factory-canary').exists())
        self.assertEqual((self.base / 'REVISION').read_text().strip(), 'a' * 40)

    def test_rollback_rejects_digest_drift_and_preserves_dump(self):
        MODULE.execute('deploy', 'factory-canary', self.expected, str(self.archive))
        (self.base / 'dist/index.js').write_text('unexpected')
        with self.assertRaisesRegex(ValueError, 'rollback held'):
            MODULE.execute('rollback', 'factory-canary', {}, None)
        self.assertTrue((self.base / 'checkpoints/council-factory-canary/proser-before.dump').exists())

    def test_failed_post_swap_probe_restores_prior_code_and_preserves_dump(self):
        calls = 0
        def flaky_probe():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ValueError('candidate probe failed')
            return ['factory-db-and-redis-ready=200', 'factory-anonymous-models=401']
        with patch.object(MODULE, 'probe', side_effect=flaky_probe), \
             patch.object(MODULE.subprocess, 'run'):
            with self.assertRaisesRegex(ValueError, 'candidate probe failed'):
                MODULE.execute('deploy', 'factory-canary', self.expected, str(self.archive))
        folder = self.base / 'checkpoints/council-factory-canary'
        self.assertEqual(MODULE.dist_digest(self.base / 'dist'), self.expected['priorDigest'])
        self.assertEqual((self.base / 'REVISION').read_text().strip(), 'a' * 40)
        self.assertEqual(MODULE.read_record(folder / 'failed.json')['recovery']['state'], 'prior-code-restored')
        self.assertTrue((folder / 'proser-before.dump').exists())

    def test_artifact_rejects_link_and_outside_path(self):
        unsafe = Path(self.temporary.name) / 'unsafe.tgz'
        with tarfile.open(unsafe, 'w:gz') as bundle:
            entry = tarfile.TarInfo('dist/outside')
            entry.type = tarfile.SYMTYPE
            entry.linkname = '/etc/passwd'
            bundle.addfile(entry)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            MODULE.safe_extract(unsafe, self.base)


if __name__ == '__main__':
    unittest.main()
