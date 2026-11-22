import {
  createHash,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../lib/database', () => ({ databaseService: { client: {} } }));

import {
  BrowserRunJournalService,
  BrowserRunReceiptExporter,
  type BrowserRunCaseRecord,
  type BrowserRunRecord,
  type BrowserRunReceiptRecord,
  type BrowserRunRepository,
  type BrowserRunTerminalRecord,
  buildBrowserRunRecord,
  canonicalJson,
  canonicalSha256,
} from '../services/browserRunReceiptService';
import {
  NovaBrowserPlaywrightRunner,
  parseNovaBrowserEvaluationBinding,
  parseNovaBrowserFixture,
} from '../services/novaBrowserPlaywrightRunner';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const requestId = `nova-${'a'.repeat(32)}`;
const target = {
  issuer: 'proser-production',
  targetOrigin: 'https://proser.example',
  targetServiceId: 'proser-author',
};
const startInput = {
  requestId,
  evaluationId: 'evaluation-one',
  packageId: 'package-one',
  packageRevision: 7,
  packageDigest: digest('package'),
  runnerBuildSha256: digest('runner'),
  fixtureSha256: digest('fixture'),
  caseIds: ['case-a', 'case-b'],
};

class MemoryRepository implements BrowserRunRepository {
  readonly runs = new Map<string, BrowserRunRecord>();
  readonly results = new Map<string, BrowserRunCaseRecord>();
  readonly terminals = new Map<string, BrowserRunTerminalRecord>();
  readonly receipts = new Map<string, BrowserRunReceiptRecord>();

  async createRun(value: BrowserRunRecord): Promise<void> {
    if (this.runs.has(value.id) || [...this.runs.values()].some((item) => item.evaluationId === value.evaluationId)) {
      throw new Error('duplicate run');
    }
    this.runs.set(value.id, structuredClone(value));
  }

  async getRun(id: string): Promise<BrowserRunRecord | null> {
    return structuredClone(this.runs.get(id) ?? null);
  }

  async createCaseResult(value: BrowserRunCaseRecord): Promise<void> {
    const key = `${value.browserRunId}\0${value.caseId}`;
    if (this.results.has(key)) throw new Error('duplicate case');
    this.results.set(key, structuredClone(value));
  }

  async listCaseResults(browserRunId: string): Promise<BrowserRunCaseRecord[]> {
    return [...this.results.values()]
      .filter((item) => item.browserRunId === browserRunId)
      .sort((a, b) => a.caseId.localeCompare(b.caseId))
      .map((item) => structuredClone(item));
  }

  async getTerminal(browserRunId: string): Promise<BrowserRunTerminalRecord | null> {
    return structuredClone(this.terminals.get(browserRunId) ?? null);
  }

  async createTerminal(value: BrowserRunTerminalRecord): Promise<void> {
    if (this.terminals.has(value.browserRunId)) throw new Error('duplicate terminal');
    this.terminals.set(value.browserRunId, structuredClone(value));
  }

  async getReceipt(browserRunId: string): Promise<BrowserRunReceiptRecord | null> {
    return structuredClone(this.receipts.get(browserRunId) ?? null);
  }

  async createReceipt(value: BrowserRunReceiptRecord): Promise<void> {
    if (this.receipts.has(value.browserRunId)) throw new Error('duplicate receipt');
    this.receipts.set(value.browserRunId, structuredClone(value));
  }
}

function keyFixture(root: string) {
  const pair = generateKeyPairSync('ed25519');
  const filename = join(root, 'runner-private.pem');
  writeFileSync(filename, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(filename, 0o600);
  return { ...pair, filename };
}

async function terminalRun(repository: MemoryRepository, now = new Date('2026-09-20T20:00:00Z')) {
  let timestamp = now.getTime();
  const journal = new BrowserRunJournalService(repository, target, () => new Date(timestamp));
  const run = await journal.start(startInput);
  timestamp += 1_000;
  await journal.recordCase(run.id, { caseId: 'case-a', status: 'blocked', evidenceSha256: digest('blocked evidence') });
  timestamp += 1_000;
  await journal.recordCase(run.id, { caseId: 'case-b', status: 'fail', evidenceSha256: digest('failure evidence') });
  timestamp += 1_000;
  const terminal = await journal.finish(run.id);
  return { journal, run, terminal };
}

test('precommits exact sorted cases and rejects mutable or malformed run identity', () => {
  const record = buildBrowserRunRecord(startInput, target, new Date('2026-09-20T20:00:00.999Z'), 'proser-browser:test');
  expect(record).toMatchObject({
    id: 'proser-browser:test', receiptId: 'proser-browser:test', audience: 'nova-creative',
    surface: 'proser_browser', casePlan: [{ case_id: 'case-a' }, { case_id: 'case-b' }],
    startedAt: new Date('2026-09-20T20:00:00Z'),
  });
  expect(record.casePlanSha256).toBe(canonicalSha256(record.casePlan));
  const injected = buildBrowserRunRecord(
    { ...startInput, issuer: 'attacker', targetOrigin: 'https://evil.example', outcome: 'passed' } as typeof startInput,
    target,
  );
  expect(injected).toMatchObject({ issuer: target.issuer, targetOrigin: target.targetOrigin });
  expect(injected).not.toHaveProperty('outcome');
  expect(() => buildBrowserRunRecord({ ...startInput, caseIds: ['case-b', 'case-a'] }, target)).toThrow(/unique and sorted/);
  expect(() => buildBrowserRunRecord({ ...startInput, requestId: 'caller-chosen' }, target)).toThrow(/request ID/);
  expect(() => buildBrowserRunRecord(startInput, { ...target, targetOrigin: 'https://proser.example/path' })).toThrow(/canonical HTTPS origin/);
  expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/NaN or Infinity/);
});

test('retains failed and blocked evidence and derives terminal hashes and failure precedence', async () => {
  const repository = new MemoryRepository();
  const { journal, run, terminal } = await terminalRun(repository);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.cases).toEqual([
    { case_id: 'case-a', status: 'blocked', evidence_sha256: digest('blocked evidence') },
    { case_id: 'case-b', status: 'fail', evidence_sha256: digest('failure evidence') },
  ]);
  expect(terminal.caseCohortSha256).toBe(canonicalSha256(terminal.cases));
  expect(terminal.resultSha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(journal.recordCase(run.id, { caseId: 'case-a', status: 'pass', evidenceSha256: digest('rewrite') })).rejects.toThrow(/already terminal/);
  await expect(journal.finish(run.id)).rejects.toThrow(/already terminalized/);
});

test('refuses unplanned, duplicate and incomplete case settlement', async () => {
  const repository = new MemoryRepository();
  let timestamp = Date.parse('2026-09-20T20:00:00Z');
  const journal = new BrowserRunJournalService(repository, target, () => new Date(timestamp));
  const run = await journal.start(startInput);
  await expect(journal.recordCase(run.id, { caseId: 'case-z', status: 'pass', evidenceSha256: digest('z') })).rejects.toThrow(/not precommitted/);
  timestamp += 1_000;
  await journal.recordCase(run.id, { caseId: 'case-a', status: 'pass', evidenceSha256: digest('a') });
  timestamp += 1_000;
  await expect(journal.recordCase(run.id, { caseId: 'case-a', status: 'fail', evidenceSha256: digest('replacement') })).rejects.toThrow(/duplicate case/);
  await expect(journal.finish(run.id)).rejects.toThrow(/every precommitted case/);
});

test('signs only a fresh terminal journal record and writes the exact Nova v1 contract once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proser-browser-receipt-'));
  const output = join(root, 'out');
  mkdirSync(output, { mode: 0o700 });
  const key = keyFixture(root);
  const repository = new MemoryRepository();
  const { run, terminal } = await terminalRun(repository);
  const exporter = new BrowserRunReceiptExporter(repository, key.filename, output, () => new Date('2026-09-20T20:00:04Z'));
  try {
    const result = await exporter.export(run.id);
    const stored = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(stored).toEqual(result.receipt);
    expect(stored).toMatchObject({
      version: 1, receipt_id: run.receiptId, issuer: target.issuer, audience: 'nova-creative',
      evaluation_id: startInput.evaluationId, request_id: requestId, package_id: startInput.packageId,
      package_revision: 7, package_digest: startInput.packageDigest, surface: 'proser_browser',
      target_origin: target.targetOrigin, target_service_id: target.targetServiceId,
      runner_build_sha256: startInput.runnerBuildSha256, fixture_sha256: startInput.fixtureSha256,
      cases: terminal.cases, outcome: 'failed', result_sha256: terminal.resultSha256,
    });
    expect(Object.keys(stored).sort()).toEqual([
      'audience', 'case_cohort_sha256', 'cases', 'evaluation_id', 'expires_at', 'fixture_sha256',
      'issuer', 'key_id', 'observed_at', 'outcome', 'package_digest', 'package_id',
      'package_revision', 'receipt_id', 'request_id', 'result_sha256', 'runner_build_sha256',
      'signature', 'surface', 'target_origin', 'target_service_id', 'version',
    ]);
    const { signature, ...unsigned } = stored;
    expect(verify(null, Buffer.from(canonicalJson(unsigned)), key.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(stored.key_id).toBe(createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
    await expect(exporter.sign(run.id)).rejects.toThrow(/already signed/);

    unlinkSync(result.path);
    await expect(exporter.export(run.id)).resolves.toMatchObject({ path: result.path, receipt: stored });
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toEqual(stored);

    const staleTemporary = join(output, `.${run.id}.00000000-0000-4000-8000-000000000000.tmp`);
    linkSync(result.path, staleTemporary);
    expect(statSync(result.path).nlink).toBe(2);
    await expect(exporter.materializeExisting(run.id)).resolves.toBe(result.path);
    expect(statSync(result.path).nlink).toBe(1);
    expect(readdirSync(output)).toEqual([`${run.id}.json`]);

    unlinkSync(result.path);
    writeFileSync(result.path, '{"different":true}', { mode: 0o644 });
    await expect(exporter.export(run.id)).rejects.toThrow(/different browser receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted Playwright runner derives build, fixture, case plan and retained evidence digests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proser-browser-runner-'));
  const fixtureFile = join(root, 'fixture.json');
  const runnerBuildFile = join(root, 'runner-build.js');
  const evidenceDirectory = join(root, 'evidence');
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  chmodSync(evidenceDirectory, 0o700);
  const fixture = {
    version: 1,
    cases: [
      {
        case_id: 'case-b', path: '/missing', timeout_ms: 1_000, actions: [],
        assertions: [{ assertion: 'visible', selector: '#missing' }],
      },
      {
        case_id: 'case-a', path: '/ready', timeout_ms: 1_000,
        actions: [{ action: 'click', selector: '#continue' }],
        assertions: [{ assertion: 'text', selector: '#status', contains: 'Ready' }],
      },
    ],
  };
  const fixtureBytes = Buffer.from(JSON.stringify(fixture));
  const runnerBytes = Buffer.from('trusted playwright runner build\n');
  writeFileSync(fixtureFile, fixtureBytes, { mode: 0o644 });
  writeFileSync(runnerBuildFile, runnerBytes, { mode: 0o644 });
  const repository = new MemoryRepository();
  const journal = new BrowserRunJournalService(repository, target, () => new Date('2026-09-20T20:00:00Z'));
  const pages: Array<{ currentUrl: string }> = [];
  const browser = {
    newContext: jest.fn(async () => ({
      newPage: jest.fn(async () => {
        const state = { currentUrl: '' };
        pages.push(state);
        return {
          goto: jest.fn(async (url: string) => { state.currentUrl = url; }),
          url: jest.fn(() => state.currentUrl),
          screenshot: jest.fn(async () => Buffer.from(`screenshot:${state.currentUrl}`)),
          locator: jest.fn((selector: string) => ({
            click: jest.fn(async () => undefined),
            fill: jest.fn(async () => undefined),
            press: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => {
              if (selector === '#missing') throw new Error('not visible');
            }),
            textContent: jest.fn(async () => selector === '#status' ? 'Ready to write' : null),
          })),
        };
      }),
      close: jest.fn(async () => undefined),
    })),
    close: jest.fn(async () => undefined),
  };
  const runner = new NovaBrowserPlaywrightRunner(
    journal,
    target,
    async () => browser as any,
    runnerBuildFile,
    () => new Date('2026-09-20T20:00:00Z'),
  );
  try {
    const result = await runner.run({
      binding: {
        requestId,
        evaluationId: 'evaluation-runner',
        packageId: startInput.packageId,
        packageRevision: startInput.packageRevision,
        packageDigest: startInput.packageDigest,
      },
      fixtureFile,
      evidenceDirectory,
    });
    const run = repository.runs.get(result.browserRunId)!;
    expect(run.runnerBuildSha256).toBe(digest(runnerBytes.toString()));
    expect(run.fixtureSha256).toBe(createHash('sha256').update(fixtureBytes).digest('hex'));
    expect(run.casePlan).toEqual([{ case_id: 'case-a' }, { case_id: 'case-b' }]);
    expect(result.terminal.outcome).toBe('failed');
    expect(result.terminal.cases.map((item) => item.status)).toEqual(['pass', 'fail']);
    for (const item of result.terminal.cases) {
      const evidence = readFileSync(join(evidenceDirectory, result.browserRunId, `${item.case_id}.json`));
      expect(item.evidence_sha256).toBe(createHash('sha256').update(evidence).digest('hex'));
      expect(JSON.parse(evidence.toString())).toMatchObject({
        browser_run_id: result.browserRunId,
        case_id: item.case_id,
        fixture_sha256: run.fixtureSha256,
        runner_build_sha256: run.runnerBuildSha256,
        status: item.status,
      });
    }
    expect(pages).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted Playwright runner preserves browser launch failures as blocked evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proser-browser-runner-blocked-'));
  const fixtureFile = join(root, 'fixture.json');
  const runnerBuildFile = join(root, 'runner-build.js');
  const evidenceDirectory = join(root, 'evidence');
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  chmodSync(evidenceDirectory, 0o700);
  writeFileSync(fixtureFile, JSON.stringify({
    version: 1,
    cases: [{
      case_id: 'browser-start', path: '/', timeout_ms: 1_000, actions: [],
      assertions: [{ assertion: 'visible', selector: 'main' }],
    }],
  }), { mode: 0o644 });
  writeFileSync(runnerBuildFile, 'runner build\n', { mode: 0o644 });
  const repository = new MemoryRepository();
  const runner = new NovaBrowserPlaywrightRunner(
    new BrowserRunJournalService(repository, target, () => new Date('2026-09-20T20:00:00Z')),
    target,
    async () => { throw new Error('chromium unavailable'); },
    runnerBuildFile,
    () => new Date('2026-09-20T20:00:00Z'),
  );
  try {
    const result = await runner.run({
      binding: {
        requestId,
        evaluationId: 'evaluation-blocked',
        packageId: startInput.packageId,
        packageRevision: startInput.packageRevision,
        packageDigest: startInput.packageDigest,
      },
      fixtureFile,
      evidenceDirectory,
    });
    expect(result.terminal.outcome).toBe('blocked');
    expect(result.terminal.cases[0]?.status).toBe('blocked');
    const evidence = JSON.parse(readFileSync(join(
      evidenceDirectory,
      result.browserRunId,
      'browser-start.json',
    ), 'utf8'));
    expect(evidence).toMatchObject({
      status: 'blocked',
      screenshot_sha256: null,
      error_class: 'Error',
      error_message: 'chromium unavailable',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted runner fixture and Nova binding parsers reject caller-controlled derivations', () => {
  expect(parseNovaBrowserEvaluationBinding({
    request_id: requestId,
    evaluation_id: 'evaluation-parser',
    package_id: 'package-parser',
    package_revision: 1,
    package_digest: digest('package-parser'),
  })).toMatchObject({ requestId, evaluationId: 'evaluation-parser' });
  expect(() => parseNovaBrowserEvaluationBinding({
    request_id: requestId,
    evaluation_id: 'evaluation-parser',
    package_id: 'package-parser',
    package_revision: 1,
    package_digest: digest('package-parser'),
    runner_build_sha256: digest('caller build'),
  })).toThrow(/malformed/);
  expect(() => parseNovaBrowserFixture({
    version: 1,
    cases: [
      { case_id: 'same', path: '/one', timeout_ms: 1_000, actions: [], assertions: [{ assertion: 'url', path: '/one' }] },
      { case_id: 'same', path: '/two', timeout_ms: 1_000, actions: [], assertions: [{ assertion: 'url', path: '/two' }] },
    ],
  }, target)).toThrow(/unique/);
});

test('migration declares row and statement triggers for every append-only journal table', () => {
  const migration = readFileSync(join(
    __dirname,
    '../../prisma/migrations/20260920220000_browser_run_receipts/migration.sql',
  ), 'utf8');
  for (const table of ['browser_runs', 'browser_run_case_results', 'browser_run_terminals', 'browser_run_receipts']) {
    expect(migration).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"`));
    expect(migration).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"`));
  }
});

test('rejects terminal tampering, stale runs, unsafe keys and unsafe output directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proser-browser-adversarial-'));
  const key = keyFixture(root);
  const repository = new MemoryRepository();
  const { run, terminal } = await terminalRun(repository);
  const exporter = new BrowserRunReceiptExporter(repository, key.filename, join(root, 'unused-output'), () => new Date('2026-09-20T20:00:04Z'));
  try {
    repository.terminals.set(run.id, { ...terminal, resultSha256: '0'.repeat(64) });
    await expect(exporter.sign(run.id)).rejects.toThrow(/result digest differs/);
    repository.terminals.set(run.id, terminal);
    const staleExporter = new BrowserRunReceiptExporter(repository, key.filename, join(root, 'unused-output'), () => new Date('2026-09-21T20:00:03Z'));
    await expect(staleExporter.sign(run.id)).rejects.toThrow(/not fresh enough/);

    const linkedKey = join(root, 'linked-key.pem');
    symlinkSync(key.filename, linkedKey);
    const linkedExporter = new BrowserRunReceiptExporter(repository, linkedKey, join(root, 'unused-output'), () => new Date('2026-09-20T20:00:04Z'));
    await expect(linkedExporter.sign(run.id)).rejects.toThrow(/unavailable or invalid/);
    chmodSync(key.filename, 0o640);
    await expect(exporter.sign(run.id)).rejects.toThrow(/unavailable or unsafe/);

    chmodSync(key.filename, 0o600);
    const receipt = await exporter.sign(run.id);
    expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const unsafeOutput = join(root, 'unsafe-output');
    mkdirSync(unsafeOutput, { mode: 0o777 });
    chmodSync(unsafeOutput, 0o777);
    const unsafeExporter = new BrowserRunReceiptExporter(repository, key.filename, unsafeOutput, () => new Date('2026-09-20T20:00:04Z'));
    await expect(unsafeExporter.materializeExisting(run.id)).rejects.toThrow(/output directory is unavailable or unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
