#!/usr/bin/env node
// Rehearse candidate migrations and a clean restore on a disposable PostgreSQL database.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, renameSync, chmodSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [checkpoint, database] = process.argv.slice(2);
if (!checkpoint?.startsWith('/opt/proser-factory/checkpoints/') ||
    !/^proser_recovery_[0-9]{8}T[0-9]{6}Z$/u.test(database ?? '')) {
  throw new Error('Usage: drill-prisma-migration.mjs ABS_CHECKPOINT proser_recovery_YYYYMMDDTHHMMSSZ');
}
const dump = path.join(checkpoint, 'proser-before.dump');
const expectedDigest = readFileSync(`${dump}.sha256`, 'utf8').trim().split(/\s+/u)[0];
const dumpHash = createHash('sha256');
for await (const chunk of createReadStream(dump)) dumpHash.update(chunk);
const digest = dumpHash.digest('hex');
if (digest !== expectedDigest) throw new Error('Pre-migration dump digest differs');

for (const file of ['.env', '.env.local']) dotenv.config({ path: path.join(root, file), override: true, quiet: true });
const original = new URL(process.env.DATABASE_URL ?? '');
if (!['postgresql:', 'postgres:'].includes(original.protocol) || original.pathname !== '/proser' ||
    !['localhost', '127.0.0.1', '::1'].includes(original.hostname)) {
  throw new Error('Factory production DATABASE_URL differs from the isolated drill contract');
}
const clone = new URL(original);
clone.pathname = `/${database}`;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: options.timeout ?? 180_000,
    maxBuffer: 1024 * 1024, env: options.env ?? process.env, stdio: options.stdio });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${String(result.stderr ?? result.error?.message ?? '').slice(0, 500)}`);
  return String(result.stdout ?? '').trim();
};
const docker = (...args) => run('docker', ['exec', 'proser-postgres', ...args]);
const restore = () => {
  const fd = openSync(dump, 'r');
  try {
    run('docker', ['exec', '-i', 'proser-postgres', 'pg_restore', '--exit-on-error', '--no-owner',
      '--no-acl', '-U', 'proser', '-d', database], { stdio: [fd, 'pipe', 'pipe'], timeout: 600_000 });
  } finally { closeSync(fd); }
};
const count = () => Number(docker('psql', '-U', 'proser', '-d', database, '-tA', '-v', 'ON_ERROR_STOP=1',
  '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'));
const rows = () => {
  const names = docker('psql', '-U', 'proser', '-d', database, '-tA', '-v', 'ON_ERROR_STOP=1',
    '-c', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").split('\n').filter(Boolean);
  if (names.length < 1 || names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
    throw new Error('Restored table inventory is invalid');
  }
  const query = `${names.map(name => `SELECT '${name}' AS table_name, count(*) AS row_count FROM "${name}"`).join(' UNION ALL ')} ORDER BY table_name`;
  return docker('psql', '-U', 'proser', '-d', database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query);
};
const liveCount = Number(docker('psql', '-U', 'proser', '-d', 'proser', '-tA', '-v', 'ON_ERROR_STOP=1',
  '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'));
if (!Number.isSafeInteger(liveCount) || liveCount < 1) throw new Error('Live Prisma migration ledger is invalid');
const prisma = path.join(root, 'node_modules/prisma/build/index.js');
let created = false;
try {
  docker('createdb', '-U', 'proser', database);
  created = true;
  restore();
  const baseline = count();
  if (baseline !== liveCount) throw new Error('Restored migration ledger differs from live');
  const baselineRows = rows();
  const env = { ...process.env, DATABASE_URL: clone.toString() };
  run(process.execPath, [prisma, 'migrate', 'deploy'], { env, timeout: 600_000 });
  run(process.execPath, [prisma, 'migrate', 'status'], { env, timeout: 120_000 });
  const migrated = count();
  if (migrated < baseline) throw new Error('Candidate migration ledger regressed');
  docker('dropdb', '-U', 'proser', database);
  created = false;
  docker('createdb', '-U', 'proser', database);
  created = true;
  restore();
  const recovered = count();
  if (recovered !== baseline || rows() !== baselineRows) throw new Error('Pre-migration recovery data differs');
  const receipt = { schema: 1, dumpSha256: digest, liveAppliedMigrations: liveCount,
    candidateAppliedMigrations: migrated, recoveredAppliedMigrations: recovered,
    candidateRevision: readFileSync(path.join(root, 'REVISION'), 'utf8').trim(),
    candidateSchemaSha256: createHash('sha256').update(readFileSync(path.join(root, 'prisma/schema.prisma'))).digest('hex'),
    restoredTableRowsSha256: createHash('sha256').update(baselineRows).digest('hex'),
    status: 'passed' };
  const output = path.join(checkpoint, 'migration-drill.json');
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, output);
  chmodSync(output, 0o600);
  console.log(JSON.stringify(receipt));
} finally {
  if (created) docker('dropdb', '-U', 'proser', '--if-exists', database);
}
