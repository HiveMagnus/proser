#!/usr/bin/env node
// Fixed, migration-free Factory code release for the trusted Council controller.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const factory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(factory, '..');
const [mode, ...tail] = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < tail.length; index += 2) {
  if (!tail[index]?.startsWith('--') || !tail[index + 1] || flags.has(tail[index])) throw new Error('Invalid Factory release flags');
  flags.set(tail[index], tail[index + 1]);
}
for (const flag of flags.keys()) if (!['--release-id', '--revision', '--record-dir'].includes(flag)) throw new Error('Unknown Factory release flag');
const releaseId = flags.get('--release-id');
const revision = flags.get('--revision');
const recordDir = flags.get('--record-dir');
if (!['dry-run', 'deploy', 'rollback'].includes(mode) ||
  !/^[a-z0-9][a-z0-9-]{7,79}$/u.test(releaseId ?? '') ||
  !/^[a-f0-9]{40}$/u.test(revision ?? '') || !path.isAbsolute(recordDir ?? '')) {
  throw new Error('Usage: council-code-factory-release.mjs dry-run|deploy|rollback --release-id ID --revision SHA --record-dir ABS');
}
const helper = path.join(factory, 'scripts/council-code-factory-remote.py');
const artifact = path.join(recordDir, 'dist.tgz');
const planPath = path.join(recordDir, 'plan.json');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 900_000, input: options.input });
  if (result.status !== 0) throw new Error(`${binary} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)}`);
  return result.stdout.trim();
}

function sudoPassword() {
  for (const file of [path.join(factory, '.env.local'), path.join(factory, '.env')]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, 'utf8').match(/^PROSER_SUDO_PASSWORD=(.*)$/mu);
    if (match) return match[1].trim().replace(/^['"]|['"]$/gu, '');
  }
  return process.env.PROSER_SUDO_PASSWORD ?? '';
}

function remote(phase, expected = null, upload = false) {
  const temporary = command('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'proser',
    'umask 077; mktemp -d /tmp/proser-council-code-XXXXXXXX']);
  if (!/^\/tmp\/proser-council-code-[A-Za-z0-9]{8}$/u.test(temporary)) throw new Error('Remote Factory staging path differs');
  try {
    command('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', helper, `proser:${temporary}/release.py`]);
    if (upload) command('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', artifact, `proser:${temporary}/dist.tgz`]);
    const args = ['python3', `${temporary}/release.py`, phase, '--release-id', releaseId,
      ...(expected ? ['--expected', JSON.stringify(expected)] : []),
      ...(upload ? ['--archive', `${temporary}/dist.tgz`] : [])];
    const password = sudoPassword();
    const invocation = `${password ? 'sudo -S -p ""' : 'sudo -n'} ${args.map(quote).join(' ')}`;
    const output = command('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'proser', invocation],
      { input: password ? `${password}\n` : undefined, timeout: 600_000 });
    return JSON.parse(output.split('\n').at(-1));
  } finally {
    command('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'proser',
      `rm -f ${quote(`${temporary}/release.py`)} ${quote(`${temporary}/dist.tgz`)}; rmdir ${quote(temporary)}`]);
  }
}

function pinnedSource() {
  if (command('git', ['rev-parse', 'HEAD']) !== revision) throw new Error('Factory source revision differs');
  if (mode !== 'rollback' && command('git', ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('Factory release requires a clean checkout');
  }
}

try {
  pinnedSource();
  if (mode === 'dry-run') {
    if (fs.existsSync(planPath) || fs.existsSync(artifact)) throw new Error('Factory release ID already staged');
    fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(recordDir, 0o700);
    const live = remote('status');
    command('npm', ['--prefix', 'ProserFactory', 'run', 'typecheck']);
    command('npm', ['--prefix', 'ProserFactory', 'run', 'test:smoke']);
    command('npm', ['--prefix', 'ProserFactory', 'run', 'build']);
    if (command('git', ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Factory build changed source');
    const candidate = JSON.parse(command('python3', [helper, 'local', '--release-id', releaseId, '--base', factory]));
    if (candidate.protectedDigest !== live.protectedDigest) throw new Error('Factory schema, migrations, dependencies, or service units changed; use reviewed native migration release');
    command('tar', ['-czf', artifact, '-C', factory, 'dist']);
    fs.chmodSync(artifact, 0o600);
    const plan = { schema: 1, releaseId, sourceSha: revision, priorRevision: live.installedRevision,
      priorDigest: live.currentDigest, protectedDigest: live.protectedDigest,
      unitDigest: live.unitDigest, migrationDigest: live.migrationDigest,
      candidateDigest: candidate.candidateDigest, artifactSha256: sha(artifact),
      databasePolicy: 'zero-pending-migrations-postgres-dump-retain-forward',
      rollbackCommand: `node ProserFactory/scripts/council-code-factory-release.mjs rollback --release-id ${releaseId} --revision ${revision} --record-dir ${recordDir}` };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'ready', releaseId, revision, installedRevision: live.installedRevision,
      artifactSha256: plan.artifactSha256, protectedDigest: plan.protectedDigest,
      priorDigest: plan.priorDigest, migrationDigest: plan.migrationDigest,
      databasePolicy: plan.databasePolicy }));
  } else {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (plan.schema !== 1 || plan.releaseId !== releaseId || plan.sourceSha !== revision) throw new Error('Factory plan identity differs');
    if (mode === 'deploy') {
      if (sha(artifact) !== plan.artifactSha256) throw new Error('Factory artifact changed after dry-run');
      const candidate = JSON.parse(command('python3', [helper, 'local', '--release-id', releaseId, '--base', factory]));
      if (candidate.protectedDigest !== plan.protectedDigest || candidate.candidateDigest !== plan.candidateDigest) throw new Error('Factory build or protected source drifted');
      const receipt = remote('deploy', plan, true);
      if (receipt.status !== 'deployed' || receipt.installedRevision !== revision ||
        receipt.installedDigest !== plan.candidateDigest || receipt.artifactSha256 !== plan.artifactSha256 ||
        receipt.redisPersistencePreflight !== 'passed' ||
        receipt.databaseBackup?.validation !== 'pg_restore-list') throw new Error('Factory installed proof differs');
      console.log(JSON.stringify({ status: 'deployed', releaseId, revision, installedRevision: revision,
        artifactSha256: plan.artifactSha256, backup: receipt.databaseBackup.path,
        backupSha256: receipt.databaseBackup.sha256, health: 'passed',
        functionalFlows: receipt.functionalFlows, migrationDigest: receipt.migrationDigest,
        databaseRestored: false, native: receipt, rollbackCommand: plan.rollbackCommand }));
    } else {
      const receipt = remote('rollback');
      if (receipt.status !== 'rolled-back' || receipt.restoredDigest !== plan.priorDigest ||
        receipt.installedRevision !== plan.priorRevision || receipt.databaseRestored !== false) throw new Error('Factory rollback proof differs');
      console.log(JSON.stringify({ status: 'rolled-back', releaseId, revision,
        installedRevision: receipt.installedRevision, restoredDigest: receipt.restoredDigest,
        databaseRestored: false, health: 'passed', functionalFlows: receipt.functionalFlows,
        native: receipt }));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
