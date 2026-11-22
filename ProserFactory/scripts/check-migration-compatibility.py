#!/usr/bin/env python3
"""Conservative old-code compatibility gate for a Factory Prisma release."""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PREFIX = 'ProserFactory/prisma/'
SHA = re.compile(r'[a-f0-9]{40}\Z')
MIGRATION = re.compile(r'ProserFactory/prisma/migrations/[0-9A-Za-z_-]+/migration\.sql\Z')


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout


def safe_additive_sql(source):
    # A deliberately small SQL subset. Anything involving a function, trigger,
    # constraint replacement, data rewrite, or drop needs a separate review.
    cleaned = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
    cleaned = '\n'.join(line.split('--', 1)[0] for line in cleaned.splitlines())
    if '$$' in cleaned or '/*' in cleaned:
        return False
    statements = [item.strip() for item in cleaned.split(';') if item.strip()]
    if not statements:
        return False
    for statement in statements:
        normalized = re.sub(r'\s+', ' ', statement).strip()
        if re.fullmatch(r'CREATE TABLE "[A-Za-z_][A-Za-z0-9_]*" \(.+\)', normalized, re.I | re.S):
            continue
        if re.fullmatch(r'CREATE INDEX "[A-Za-z_][A-Za-z0-9_]*" ON "[A-Za-z_][A-Za-z0-9_]*"(?: USING [A-Za-z_]+)?\s*\(.+\)', normalized, re.I | re.S):
            continue
        add = re.fullmatch(r'ALTER TABLE "[A-Za-z_][A-Za-z0-9_]*" ADD COLUMN "[A-Za-z_][A-Za-z0-9_]*" (.+)', normalized, re.I | re.S)
        if add:
            column = add.group(1)
            if ' NOT NULL' not in column.upper():
                continue
            if re.search(r'\bDEFAULT\s+(?:[0-9]+|TRUE|FALSE|\'[^\']*\')\s+NOT NULL\Z', column, re.I):
                continue
        return False
    return True


def assess(base, target):
    if not SHA.fullmatch(base) or not SHA.fullmatch(target):
        raise ValueError('Exact full Git SHAs are required')
    git('cat-file', '-e', f'{base}^{{commit}}')
    git('cat-file', '-e', f'{target}^{{commit}}')
    changes = git('diff', '--name-status', '-z', base, target, '--', PREFIX).split(b'\0')
    entries = []
    index = 0
    while index < len(changes) and changes[index]:
        status = changes[index].decode()
        path = changes[index + 1].decode()
        if status.startswith(('R', 'C')):
            raise ValueError('Prisma migration rename or copy requires separate review')
        entries.append((status, path))
        index += 2
    schema_changed = any(path == PREFIX + 'schema.prisma' for _, path in entries)
    migrations = []
    for status, path in entries:
        if path == PREFIX + 'schema.prisma' and status == 'M':
            continue
        if status != 'A' or not MIGRATION.fullmatch(path):
            raise ValueError(f'Existing Prisma authority changed: {path}')
        sql = git('show', f'{target}:{path}').decode()
        if not safe_additive_sql(sql):
            raise ValueError(f'Migration is outside the additive compatibility subset: {path}')
        migrations.append(path)
    if schema_changed and not migrations:
        raise ValueError('Prisma schema changed without a new migration')
    if migrations and not schema_changed:
        raise ValueError('New migration has no Prisma schema change')
    return {'schema': 1, 'baseSha': base, 'candidateSha': target,
            'status': 'additive-compatible' if migrations else 'unchanged',
            'newMigrations': migrations}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-sha', required=True)
    parser.add_argument('--candidate-sha', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(assess(args.base_sha, args.candidate_sha), sort_keys=True))
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(2, f'{error}\n')
