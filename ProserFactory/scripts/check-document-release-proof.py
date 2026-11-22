#!/usr/bin/env python3
"""Exact reviewed document transition. Does not relax the additive classifier."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FACTORY = ROOT / 'ProserFactory'
SHA = re.compile(r'[a-f0-9]{40}\Z')
DIGEST = re.compile(r'[a-f0-9]{64}\Z')


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_file(path):
    source = Path(path)
    require(source.is_absolute(), 'Proof/evidence paths must be absolute')
    metadata = source.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid() and not metadata.st_mode & 0o077,
            'Proof/evidence must be owner-only regular files owned by the current operator')
    for parent in [source.parent]:
        info = parent.stat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'Proof/evidence parent must be owner-only')
    return source.read_bytes()


def evidence(binding):
    require(isinstance(binding, dict) and DIGEST.fullmatch(binding.get('sha256', '')), 'Evidence binding requires SHA256')
    raw = private_file(binding['path'])
    require(sha(raw) == binding['sha256'], 'Evidence bytes differ from reviewed SHA256')
    return json.loads(raw)


def assess_schema(base, target, manifest):
    require(SHA.fullmatch(base) and SHA.fullmatch(target), 'Exact full Git SHAs required')
    git('cat-file', '-e', f'{base}^{{commit}}')
    git('cat-file', '-e', f'{target}^{{commit}}')
    git('merge-base', '--is-ancestor', base, target)
    entries = git('diff', '--name-status', '-z', base, target, '--', 'ProserFactory/prisma/').split(b'\0')
    changed = []
    for index in range(0, len(entries) - 1, 2):
        status, path = entries[index].decode(), entries[index + 1].decode()
        require(not status.startswith(('R', 'C')), 'Prisma rename/copy requires another reviewed procedure')
        relative = path.removeprefix('ProserFactory/')
        if relative == 'prisma/schema.prisma':
            require(status == 'M', 'Only the captured Prisma schema modification is allowed')
        elif relative == 'prisma/migrations/migration_lock.toml':
            require(status == 'M' and sha(git('show', f'{target}:{path}')) == manifest['migrationLockSha256'], 'Migration lock differs from reviewed bytes')
            old = git('show', f'{base}:{path}').decode()
            require([line for line in old.splitlines() if not line.startswith('#')] == ['provider = "postgresql"'], 'Installed migration provider differs')
        else:
            require(status == 'A' and relative in manifest['migrations'], f'Unknown or rewritten migration authority: {path}')
            require(sha(git('show', f'{target}:{path}')) == manifest['migrations'][relative], f'Reviewed migration bytes differ: {path}')
            changed.append(relative)
    require(changed, 'This reviewed path is only for the document schema transition')
    # Check the complete candidate closure, including already installed members.
    for relative, digest in manifest['migrations'].items():
        require(sha(git('show', f'{target}:ProserFactory/{relative}')) == digest, f'Candidate migration closure differs: {relative}')
    require(sha(git('show', f'{target}:ProserFactory/deploy/document-authority/enforcement.sql')) == manifest['enforcementSqlSha256'], 'Enforcement SQL differs')
    return changed


def assess(proof_path, base, target, check_clean=True):
    require(SHA.fullmatch(base) and SHA.fullmatch(target), 'Exact full Git SHAs required')
    if check_clean:
        require(git('rev-parse', 'HEAD').decode().strip() == target and not git('status', '--porcelain=v1', '--untracked-files=all').strip(), 'Exact clean candidate checkout required')
    raw = private_file(proof_path)
    proof = json.loads(raw)
    require(proof.get('schemaVersion') == 1 and proof.get('kind') == 'reviewed-document-native-release', 'Wrong proof kind/version')
    require(proof.get('candidateRevision') == target and proof.get('installedRevision') == base, 'Proof candidate/installed revisions differ')
    require(proof.get('host') == 'proser' and proof.get('database') == 'proser', 'Wrong production target')
    require(isinstance(proof.get('reviewedBy'), str) and proof['reviewedBy'].strip() and proof.get('authorization') == 'user-authorized-canvas-release', 'Explicit operator review and user release authorization required')
    require(proof.get('holdServices') is True and proof.get('activateAuthority') is False, 'Native transition must stop before authority activation')
    require(proof.get('rollbackPolicy') == 'document-compatible-only-after-activation' and SHA.fullmatch(proof.get('compatibleRollbackRevision', '')), 'Document-compatible rollback policy/revision required')
    manifest = json.loads(git('show', f'{target}:ProserFactory/deploy/document-authority/reviewed-schema.json'))
    changes = assess_schema(base, target, manifest)
    require(proof.get('schemaSha256') == sha(git('show', f'{target}:ProserFactory/prisma/schema.prisma')), 'Proof schema digest differs')
    require(proof.get('enforcementSqlSha256') == manifest['enforcementSqlSha256'], 'Proof enforcement digest differs')
    synthetic = evidence(proof['syntheticRehearsal'])
    require(synthetic.get('kind') == 'isolated-enforcement-rehearsal' and synthetic.get('candidateRevision') == target and synthetic.get('dirtyWorktree') is False and synthetic.get('sqlSha256') == manifest['enforcementSqlSha256'], 'Synthetic rehearsal must prove this exact clean candidate/SQL')
    require(len(synthetic.get('summary', {}).get('migrations', [])) == manifest['migrationCount'] and {'restore1', 'restore2', 'guarded-commit', 'stale-writer-rejection'}.issubset(synthetic.get('checks', [])), 'Synthetic rehearsal missing migration/restore/guard evidence')
    preservation = evidence(proof['productionRestore'])
    require(preservation.get('kind') == 'isolated-production-preservation-v2' and preservation.get('candidateRevision') == target and preservation.get('dirtyWorktree') is False and preservation.get('productionMutation') is False, 'Production-backup rehearsal must prove this exact clean candidate in isolation')
    require(re.fullmatch(r'proser_canvas_[A-Za-z0-9_]+', preservation.get('database', '')) and preservation.get('migrationCount') == manifest['migrationCount'] and preservation.get('enforcementSqlSha256') == manifest['enforcementSqlSha256'], 'Wrong production restore schema/SQL/isolated database')
    require(preservation.get('backfillPasses') == 2 and preservation.get('backfillHeadsBeforeSecond') == preservation.get('backfillHeadsAfterSecond') and preservation.get('backfillHeadsBeforeSecond'), 'Second backfill must prove identical complete head references')
    before, after = preservation.get('originalRowsBefore'), preservation.get('originalRowsAfter')
    require(isinstance(before, dict) and before and before == after and {'books', 'acts', 'chapters', 'scenes', 'manuscript_revisions', 'images'}.issubset(before), 'Complete original rows/IDs/timestamps/history/assets not preserved')
    require(preservation.get('originalRowScope') == 'all-original-ids-and-columns', 'Original row comparison must include every original column and retained identity')
    normalizations = preservation.get('originalRowNormalizations', [])
    require(isinstance(normalizations, list) and all(item.get('table') == 'images' and item.get('column') == 'config_json' and isinstance(item.get('assetId'), int) and item['assetId'] > 0 and DIGEST.fullmatch(item.get('originalValueSha256', '')) and item.get('originalValueSha256') == item.get('auditOriginalValueSha256') and DIGEST.fullmatch(item.get('registeredValueSha256', '')) and isinstance(item.get('auditId'), int) and item['auditId'] > 0 for item in normalizations), 'Only exact audited selected-image metadata augmentation can normalize original row comparison')
    for summary in before.values():
        require(isinstance(summary.get('count'), int) and summary['count'] >= 0 and DIGEST.fullmatch(summary.get('sha256', '')), 'Invalid original row evidence')
    summaries = preservation.get('candidateRows'), preservation.get('firstRestoreRows'), preservation.get('secondRestoreRows')
    require(summaries[0] and summaries[0] == summaries[1] == summaries[2], 'Two candidate restores must preserve all table hashes/counts')
    require(preservation.get('schemaDiff') == '-- This is an empty migration.', 'Prisma diff is not empty')
    require(isinstance(preservation.get('assetBytes'), list), 'Original image-byte evidence required')
    for asset in preservation['assetBytes']:
        require(DIGEST.fullmatch(asset.get('sha256', '')) and sha(private_file(asset['path'])) == asset['sha256'], 'Preserved original image bytes differ')
    require(len(preservation['assetBytes']) == before['images']['count'], 'Original image-byte inventory is incomplete')
    dump = proof['originalDump']
    require(sha(private_file(dump['path'])) == dump['sha256'] == preservation.get('originalDumpSha256'), 'Original production dump binding differs')
    return {'schemaVersion': 1, 'status': 'candidate-specific-reviewed', 'candidateRevision': target, 'installedRevision': base, 'proofSha256': sha(raw), 'schemaSha256': proof['schemaSha256'], 'enforcementSqlSha256': manifest['enforcementSqlSha256'], 'newMigrations': changes, 'holdServices': True, 'activateAuthority': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proof-file', required=True)
    parser.add_argument('--base-sha', required=True)
    parser.add_argument('--candidate-sha', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(assess(args.proof_file, args.base_sha, args.candidate_sha), sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        parser.exit(2, f'{error}\n')
