#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('document_release', Path(__file__).with_name('check-document-release-proof.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
BASE = '1' * 40
TARGET = '2' * 40
HASH = 'a' * 64
MANIFEST = json.loads((module.FACTORY / 'deploy/document-authority/reviewed-schema.json').read_text())


class ReviewedSchemaTests(unittest.TestCase):
    def git(self, *args):
        if args[0] == 'diff':
            paths = [('M', 'ProserFactory/prisma/schema.prisma'), ('M', 'ProserFactory/prisma/migrations/migration_lock.toml')] + [('A', 'ProserFactory/' + p) for p in MANIFEST['migrations']]
            return ('\0'.join(value for pair in paths for value in pair) + '\0').encode()
        if args[0] == 'show':
            revision, path = args[1].split(':', 1)
            if revision == BASE:
                return b'# retained provider\nprovider = "postgresql"\n'
            return (module.ROOT / path).read_bytes()
        return b''

    def test_exact_closed_schema_set(self):
        with patch.object(module, 'git', self.git):
            self.assertEqual(len(module.assess_schema(BASE, TARGET, MANIFEST)), 13)

    def test_rewritten_old_migration_rejected(self):
        def altered(*args):
            if args[0] == 'diff':
                return b'M\0ProserFactory/prisma/migrations/old/migration.sql\0'
            return self.git(*args)
        with patch.object(module, 'git', altered):
            with self.assertRaisesRegex(ValueError, 'rewritten'):
                module.assess_schema(BASE, TARGET, MANIFEST)

    def test_unknown_new_migration_rejected(self):
        def altered(*args):
            if args[0] == 'diff':
                return b'A\0ProserFactory/prisma/migrations/unknown/migration.sql\0'
            return self.git(*args)
        with patch.object(module, 'git', altered):
            with self.assertRaisesRegex(ValueError, 'Unknown'):
                module.assess_schema(BASE, TARGET, MANIFEST)

    def test_changed_exact_sql_rejected(self):
        def altered(*args):
            if args[0] == 'show' and args[1].endswith('20261005230000_legacy_schema_alignment/migration.sql'):
                return b'SELECT 1;'
            return self.git(*args)
        with patch.object(module, 'git', altered):
            with self.assertRaisesRegex(ValueError, 'bytes differ'):
                module.assess_schema(BASE, TARGET, MANIFEST)

    def test_changed_provider_rejected(self):
        def altered(*args):
            if args[0] == 'show' and args[1].startswith(BASE + ':'):
                return b'provider = "sqlite"\n'
            return self.git(*args)
        with patch.object(module, 'git', altered):
            with self.assertRaisesRegex(ValueError, 'provider differs'):
                module.assess_schema(BASE, TARGET, MANIFEST)


class ProofBoundaryTests(unittest.TestCase):
    def test_evidence_private_bytes_and_exact_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'evidence.json'
            path.write_text('{"verified":true}')
            path.chmod(0o600)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(module.evidence({'path': str(path), 'sha256': digest}), {'verified': True})
            with self.assertRaisesRegex(ValueError, 'bytes differ'):
                module.evidence({'path': str(path), 'sha256': HASH})
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'owner-only'):
                module.evidence({'path': str(path), 'sha256': digest})

    def test_symlink_not_authority(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.json'; source.write_text('{}'); source.chmod(0o600)
            link = Path(folder) / 'link.json'; link.symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'regular'):
                module.private_file(link)

    def test_wrong_candidate_or_target_cannot_authorize(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'proof.json'
            proof = {'schemaVersion': 1, 'kind': 'reviewed-document-native-release', 'candidateRevision': TARGET, 'installedRevision': BASE, 'host': 'other', 'database': 'proser'}
            path.write_text(json.dumps(proof)); path.chmod(0o600)
            with patch.object(module, 'git', lambda *_: b''):
                with self.assertRaisesRegex(ValueError, 'Wrong production target'):
                    module.assess(str(path), BASE, TARGET, check_clean=False)
            proof['candidateRevision'] = BASE; path.write_text(json.dumps(proof))
            with self.assertRaisesRegex(ValueError, 'revisions differ'):
                module.assess(str(path), BASE, TARGET, check_clean=False)

    def complete_fixture(self, folder):
        folder=Path(folder)
        def write(name,value):
            path=folder/name;path.write_bytes(value if isinstance(value,bytes) else json.dumps(value).encode());path.chmod(0o600);return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        dump=write('backup.dump',b'isolated fixture only')
        synthetic={'kind':'isolated-enforcement-rehearsal','candidateRevision':TARGET,'dirtyWorktree':False,'sqlSha256':MANIFEST['enforcementSqlSha256'],'summary':{'migrations':list(range(22))},'checks':['restore1','restore2','guarded-commit','stale-writer-rejection']}
        rows={table:{'count':0,'sha256':HASH} for table in ['books','acts','chapters','scenes','manuscript_revisions','images']}
        preservation={'kind':'isolated-production-preservation-v2','candidateRevision':TARGET,'dirtyWorktree':False,'productionMutation':False,'database':'proser_canvas_fixture','migrationCount':22,'enforcementSqlSha256':MANIFEST['enforcementSqlSha256'],'backfillPasses':2,'backfillHeadsBeforeSecond':{'1':'head'},'backfillHeadsAfterSecond':{'1':'head'},'originalRowsBefore':rows,'originalRowsAfter':rows,'candidateRows':rows,'firstRestoreRows':rows,'secondRestoreRows':rows,'originalRowScope':'all-original-ids-and-columns','originalRowNormalizations':[],'schemaDiff':'-- This is an empty migration.','assetBytes':[],'originalDumpSha256':dump['sha256']}
        proof={'schemaVersion':1,'kind':'reviewed-document-native-release','candidateRevision':TARGET,'installedRevision':BASE,'host':'proser','database':'proser','reviewedBy':'Fixture operator','authorization':'user-authorized-canvas-release','holdServices':True,'activateAuthority':False,'rollbackPolicy':'document-compatible-only-after-activation','compatibleRollbackRevision':TARGET,'schemaSha256':hashlib.sha256((module.FACTORY/'prisma/schema.prisma').read_bytes()).hexdigest(),'enforcementSqlSha256':MANIFEST['enforcementSqlSha256'],'syntheticRehearsal':write('synthetic.json',synthetic),'productionRestore':write('preservation.json',preservation),'originalDump':dump}
        binding=write('proof.json',proof)
        return Path(binding['path']),proof,preservation

    def test_complete_reviewed_proof_and_preservation_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path,proof,preservation=self.complete_fixture(folder)
            def mocked(*args):
                if args[0]=='show':return (module.ROOT/args[1].split(':',1)[1]).read_bytes()
                return b''
            with patch.object(module,'git',mocked),patch.object(module,'assess_schema',lambda *_:list(MANIFEST['migrations'])):
                self.assertEqual(module.assess(str(path),BASE,TARGET,check_clean=False)['status'],'candidate-specific-reviewed')
                changed=json.loads(json.dumps(preservation));changed['secondRestoreRows']['scenes']['sha256']='b'*64
                target=Path(proof['productionRestore']['path']);target.write_text(json.dumps(changed));proof['productionRestore']['sha256']=hashlib.sha256(target.read_bytes()).hexdigest();path.write_text(json.dumps(proof))
                with self.assertRaisesRegex(ValueError,'Two candidate restores'):
                    module.assess(str(path),BASE,TARGET,check_clean=False)

    def test_activation_or_dirty_checkout_never_inherited(self):
        with tempfile.TemporaryDirectory() as folder:
            path,proof,_=self.complete_fixture(folder)
            proof['activateAuthority']=True;path.write_text(json.dumps(proof))
            with self.assertRaisesRegex(ValueError,'stop before authority activation'):
                module.assess(str(path),BASE,TARGET,check_clean=False)
            with patch.object(module,'git',lambda *args: (TARGET+'\n').encode() if args[0]=='rev-parse' else b'M file'):
                with self.assertRaisesRegex(ValueError,'clean candidate'):
                    module.assess(str(path),BASE,TARGET)


if __name__ == '__main__':
    unittest.main()
