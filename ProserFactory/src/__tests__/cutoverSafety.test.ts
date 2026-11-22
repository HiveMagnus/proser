import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import {
  buildCutoverTableReport,
  finalizeCutoverReport,
  type CutoverColumn,
} from '@/lib/migration/cutoverReport';

describe('SQLite to PostgreSQL cutover safety', () => {
  const columns: CutoverColumn[] = [
    { name: 'id', dataType: 'integer', nullable: false, primaryKeyOrdinal: 1 },
    { name: 'book_id', dataType: 'integer', nullable: false },
    { name: 'content', dataType: 'text', nullable: true },
    { name: 'metadata', dataType: 'jsonb', nullable: true },
  ];

  it('detects content and primary-key differences even when row counts match', () => {
    const source = finalizeCutoverReport({
      scenes: buildCutoverTableReport(columns, [
        { id: 1, book_id: 10, content: 'source', metadata: '{"b":2,"a":1}' },
      ]),
    });
    const changedValue = finalizeCutoverReport({
      scenes: buildCutoverTableReport(columns, [
        { id: 1, book_id: 10, content: 'corrupted', metadata: { a: 1, b: 2 } },
      ]),
    });
    const changedKey = finalizeCutoverReport({
      scenes: buildCutoverTableReport(columns, [
        { id: 2, book_id: 10, content: 'source', metadata: { a: 1, b: 2 } },
      ]),
    });
    expect(source.totalRows).toBe(changedValue.totalRows);
    expect(source.reportHash).not.toBe(changedValue.reportHash);
    expect(source.tables.scenes.columnDigests.content).not.toBe(
      changedValue.tables.scenes.columnDigests.content,
    );
    expect(source.tables.scenes.primaryKeyDigest).not.toBe(
      changedKey.tables.scenes.primaryKeyDigest,
    );
  });

  it('records nullable-field counts and numeric aggregate totals', () => {
    const report = buildCutoverTableReport(columns, [
      { id: 1, book_id: 10, content: null, metadata: null },
      { id: 2, book_id: 10, content: 'text', metadata: {} },
    ]);
    expect(report.nullCounts).toMatchObject({ content: 1, metadata: 1 });
    expect(report.aggregates).toMatchObject({ 'sum:id': '3', 'sum:book_id': '20' });
  });

  it('normalizes legacy sub-millisecond timestamps to PostgreSQL precision', () => {
    const timestampColumn: CutoverColumn[] = [{
      name: 'created_at',
      dataType: 'timestamp without time zone',
      nullable: false,
      temporalPrecision: 3,
    }];
    const source = buildCutoverTableReport(timestampColumn, [{
      created_at: '2026-07-18T08:00:34.018566+00:00',
    }]);
    const target = buildCutoverTableReport(timestampColumn, [{
      created_at: new Date('2026-07-18T08:00:34.019Z'),
    }]);
    expect(source.rowDigest).toBe(target.rowDigest);
    expect(source.columnDigests.created_at).toBe(target.columnDigests.created_at);
  });

  it('keeps destructive replacement out of the normal deploy path', () => {
    const deploy = readFileSync(
      resolve(__dirname, '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    expect(deploy).not.toContain('REPLACE_EXISTING_TARGET=1');
    expect(deploy).toContain('--record-existing-cutover');
    expect(deploy).toContain('--rotate-cutover-evidence-key');
    expect(deploy).toContain('for _ in $(seq 1 60)');
    expect(deploy).toContain('Factory services did not become active within 60 seconds');
    expect(deploy).toContain('ensure-shared-factory-auth.py');
    expect(deploy).toContain('.env.local must be a regular non-symlink file');
    expect(deploy).toContain("chown '$SERVICE_USER:$SERVICE_USER' '$REMOTE_DIR/.env.local'");
    expect(deploy).toContain("chmod 0600 '$REMOTE_DIR/.env.local'");
    expect(deploy).toContain('scripts/smoke-deployed.mjs');
    expect(deploy).toContain('curl -fsS --max-time 2 http://127.0.0.1:3001/health');
    expect(deploy).toContain('node scripts/smoke-deployed.mjs http://127.0.0.1:3001');
    expect(deploy).not.toContain('https://$REMOTE_TLS_NAME:3001');
    expect(deploy).toContain('normal deploys never replace populated data');
    const sharedAuthProvisioner = readFileSync(
      resolve(__dirname, '../../deploy/ensure-shared-factory-auth.py'),
      'utf8',
    );
    expect(sharedAuthProvisioner).toContain('tempfile.mkstemp(');
    expect(sharedAuthProvisioner).toContain('os.fchmod(descriptor, 0o600)');
    expect(sharedAuthProvisioner).toContain('os.fsync(stream.fileno())');
    expect(sharedAuthProvisioner).toContain('os.O_DIRECTORY');
    expect(sharedAuthProvisioner).not.toContain('temporary.write_text');
  });

  it('proves Redis writes and snapshot persistence before stopping services', () => {
    const deploy = readFileSync(
      resolve(__dirname, '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    const preflight = deploy.indexOf('dist/lib/redis/persistencePreflight.js');
    const stop = deploy.indexOf('_sudo "systemctl stop proser-factory proser-worker"', preflight);
    expect(preflight).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(preflight);
    expect(stop).toBeLessThan(deploy.indexOf('Syncing files to'));
  });

  it('keeps confidential PostgreSQL checkpoints private', () => {
    const deploy = readFileSync(
      resolve(__dirname, '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    expect(deploy).toContain("install -d -m 0700 -o root -g root '$REMOTE_DIR/checkpoints' '$CHECKPOINT_DIR'");
    expect(deploy).toContain("chmod 0600 '$CHECKPOINT_DIR/proser-before.dump' '$CHECKPOINT_DIR/proser-before.dump.sha256'");
    expect(deploy.indexOf('component-before.tar.gz')).toBeLessThan(deploy.indexOf('Syncing files to'));
    expect(deploy.indexOf('Creating a pre-migration PostgreSQL checkpoint')).toBeLessThan(deploy.indexOf('Running PostgreSQL Prisma migrations'));
    expect(deploy).toContain('trap release_exit EXIT');
    expect(deploy.lastIndexOf('trap - EXIT')).toBeGreaterThan(deploy.indexOf('Running deployed smoke tests'));
    const held = deploy.indexOf('write_release_record held-for-document-activation');
    expect(held).toBeGreaterThan(deploy.indexOf('Running PostgreSQL Prisma migrations'));
    expect(held).toBeLessThan(deploy.indexOf('Running deployed smoke tests'));
    expect(deploy.slice(held, deploy.indexOf('Running deployed smoke tests'))).toContain('trap - EXIT');
    expect(deploy).toContain('MIGRATION_STATE="running or partially applied"');
    expect(deploy).toContain('any writes since the checkpoint');
    expect(deploy).toContain('A restarted candidate may have accepted work before the failed probe');
    expect(deploy).toContain('Restore the prior component only together with a compatible database');
  });

  it('keeps the sudo credential out of SSH process arguments', () => {
    const deploy = readFileSync(
      resolve(__dirname, '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    expect(deploy).toContain(`printf '%s\\n' "$SUDO_PASS" | ssh`);
    expect(deploy).toContain("sudo -S -p '' /bin/sh -c $remote_command_q");
    expect(deploy).toContain('sudo -n /bin/sh -c $remote_command_q');
    expect(deploy).toContain("runuser -u '$SERVICE_USER'");
    expect(deploy).not.toContain('ssh -t "$REMOTE"');
    expect(deploy).not.toContain("'$ESCAPED_SUDO_PASS'");
  });

  it('keeps unauthenticated observability endpoints on loopback', () => {
    const compose = readFileSync(
      resolve(__dirname, '../../docker-compose.observability.yml'),
      'utf8',
    );
    for (const port of ['4318', '8889', '14250', '16686']) {
      expect(compose).toContain(`127.0.0.1:${port}:${port}`);
      expect(compose).not.toMatch(new RegExp(`-[ \\t]+["']?${port}:${port}`));
    }
  });

  it('requires authentication on the non-loopback inference service', () => {
    const unit = readFileSync(
      resolve(__dirname, '../../deploy/inference/llama-qwen3.6.service'),
      'utf8',
    );
    const deploy = readFileSync(
      resolve(__dirname, '../../scripts/deploy-inference.sh'),
      'utf8',
    );
    const privilegeBoundary = readFileSync(
      resolve(__dirname, '../../deploy/inference/proser-inference-deploy-sudo'),
      'utf8',
    );
    const config = readFileSync(resolve(__dirname, '../core/config.ts'), 'utf8');

    expect(unit).toContain('--api-key-file /etc/proser-inference-api-keys');
    expect(deploy).toContain('INFERENCE_API_KEY is required');
    expect(deploy).toContain('[[ "$UNAUTH_STATUS" == 401 ]]');
    expect(deploy).toContain('proser-inference-deploy-sudo activate');
    expect(deploy).toContain('INFERENCE_HOST/v1/chat/completions');
    expect(deploy).toContain('if [[ "$ACTIVATED" == 1 ]]');
    expect(deploy).toContain('proser-inference-deploy-sudo rollback "$STAMP"');
    const activation = deploy.indexOf('ACTIVATED=1');
    const cleared = deploy.indexOf('ACTIVATED=0', activation);
    expect(activation).toBeGreaterThan(-1);
    for (const postActivationGate of [
      'Inference health check failed.',
      'UNAUTH_STATUS=',
      'REMOTE_SHA=',
      'systemctl --no-pager',
      'proser-inference-deploy-sudo finalize "$STAMP"',
    ]) {
      const gate = deploy.indexOf(postActivationGate, activation);
      expect(gate).toBeGreaterThan(activation);
      expect(gate).toBeLessThan(cleared);
    }
    expect(deploy).not.toContain('sudo -n install');
    const unitSha256 = createHash('sha256').update(unit).digest('hex');
    expect(privilegeBoundary).toContain(`EXPECTED_UNIT_SHA256=${unitSha256}`);
    expect(privilegeBoundary).toContain('/usr/bin/mv -T -- "$unit_stage" "$state/unit.stage"');
    expect(privilegeBoundary).toContain('assert_fixed_path "$TEMPLATE"');
    expect(privilegeBoundary).toContain("another inference deployment is already active");
    expect(privilegeBoundary).toContain('assert_stage_file "$key_stage" 4096 600');
    expect(privilegeBoundary).toContain("[[ ${SUDO_USER:-} == proser-inference ]]");
    expect(privilegeBoundary).toContain("[[ \"$1\" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]");
    expect(config).toContain('INFERENCE_API_KEY is required for a non-loopback production inference backend');
  });

  it('keeps Hermes deployment on key-only pinned SSH transport', () => {
    for (const relative of [
      '../../scripts/deploy-hermes-proser-plugin-ubuntu24.sh',
      '../../scripts/provision-hermes-agent-identity.sh',
    ]) {
      const script = readFileSync(resolve(__dirname, relative), 'utf8');
      expect(script).toContain('PasswordAuthentication=no');
      expect(script).toContain('StrictHostKeyChecking=yes');
      expect(script).toContain('UserKnownHostsFile=');
      expect(script).not.toContain('sshpass');
      expect(script).not.toContain('StrictHostKeyChecking=accept-new');
      expect(script).not.toContain('PROSER_PASSWORD');
      expect(script).not.toContain('--password');
      expect(script).not.toMatch(/--proser-token(?:\s|\")/);
      expect(script).not.toMatch(/--proser-auth-secret(?:\s|\")/);
    }
  });

  it('verifies the deployed inference secret without a mutation path', () => {
    const deploy = readFileSync(
      resolve(__dirname, '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    const verifier = readFileSync(
      resolve(__dirname, '../../deploy/verify-private-env.py'),
      'utf8',
    );
    expect(deploy).toContain("verify-private-env.py' '$REMOTE_DIR/.env' INFERENCE_API_KEY");
    expect(verifier).toContain('target.resolve(strict=True) != target');
    expect(verifier).toContain('metadata.st_uid != 0 or metadata.st_nlink != 1');
    expect(verifier).toContain('stat.S_IMODE(metadata.st_mode) != 0o600');
    expect(verifier).not.toContain('write_text');
    expect(verifier).not.toContain('os.replace');
  });

  it('keeps PostgreSQL credentials and signed cutover evidence on one source', () => {
    const provisioner = readFileSync(
      resolve(__dirname, '../../deploy/ensure-postgres-env.py'),
      'utf8',
    );
    expect(provisioner).toContain('source_signing_key = ""');
    expect(provisioner).toContain('line.startswith("MIGRATION_EVIDENCE_SIGNING_KEY=")');
    expect(provisioner).toContain('source_signing_key\n            or values.get');
    expect(provisioner).toContain('credential source has no strong MIGRATION_EVIDENCE_SIGNING_KEY');
    const migration = readFileSync(
      resolve(__dirname, '../../scripts/migrate-sqlite-to-postgres.ts'),
      'utf8',
    );
    expect(migration).toContain('CUTOVER_KEY_ROTATION_ID');
    expect(migration).toContain('COPYFILE_EXCL');
    expect(migration).toContain('SQLite source SHA-256 differs from the receipt');
    expect(migration).toContain("spawnSync('systemctl', ['is-active', '--quiet', service]");
    expect(migration).toContain('Cutover key rotation requires ${service} to be inactive');
    expect(migration).toContain('stableStringify(report) !== stableStringify(receipt.report)');
    expect(migration).toContain('validateTargetRelationships(postgres)');
    expect(migration).toContain('representativeApplicationReads(postgres)');
    expect(migration).toContain('WHERE operation_id = $2 AND evidence_signature = $3');
  });
});
