import {
  constants,
  type Stats,
} from 'node:fs';
import { link, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { NotFoundError, ValidationError } from '@/lib/errors';

const VERSION = 1;
const AUDIENCE = 'nova-creative';
const SURFACE = 'proser_browser';
const MAX_CASES = 100;
const RECEIPT_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_KEY_BYTES = 16 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REQUEST_PATTERN = /^nova-[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type BrowserCaseStatus = 'pass' | 'fail' | 'blocked';
export type BrowserRunOutcome = 'passed' | 'failed' | 'blocked';

export type BrowserRunTarget = {
  issuer: string;
  targetOrigin: string;
  targetServiceId: string;
};

export type StartBrowserRunInput = {
  requestId: string;
  evaluationId: string;
  packageId: string;
  packageRevision: number;
  packageDigest: string;
  runnerBuildSha256: string;
  fixtureSha256: string;
  caseIds: string[];
};

export type BrowserRunRecord = BrowserRunTarget & {
  id: string;
  receiptId: string;
  audience: typeof AUDIENCE;
  requestId: string;
  evaluationId: string;
  packageId: string;
  packageRevision: number;
  packageDigest: string;
  surface: typeof SURFACE;
  runnerBuildSha256: string;
  fixtureSha256: string;
  casePlan: Array<{ case_id: string }>;
  casePlanSha256: string;
  startedAt: Date;
};

export type BrowserRunCaseRecord = {
  browserRunId: string;
  caseId: string;
  status: BrowserCaseStatus;
  evidenceSha256: string;
  observedAt: Date;
};

export type BrowserRunTerminalRecord = {
  browserRunId: string;
  observedAt: Date;
  outcome: BrowserRunOutcome;
  cases: BrowserReceiptCase[];
  caseCohortSha256: string;
  resultSha256: string;
};

export type BrowserReceiptCase = {
  case_id: string;
  status: BrowserCaseStatus;
  evidence_sha256: string;
};

export type BrowserRunReceiptRecord = {
  browserRunId: string;
  receiptId: string;
  keyId: string;
  signature: string;
  canonicalJson: string;
  receiptSha256: string;
  expiresAt: Date;
};

export type NovaBrowserRunnerReceipt = {
  version: 1;
  receipt_id: string;
  issuer: string;
  key_id: string;
  audience: typeof AUDIENCE;
  evaluation_id: string;
  request_id: string;
  package_id: string;
  package_revision: number;
  package_digest: string;
  surface: typeof SURFACE;
  target_origin: string;
  target_service_id: string;
  runner_build_sha256: string;
  fixture_sha256: string;
  case_cohort_sha256: string;
  cases: BrowserReceiptCase[];
  observed_at: number;
  expires_at: number;
  outcome: BrowserRunOutcome;
  result_sha256: string;
  signature: string;
};

export interface BrowserRunRepository {
  createRun(value: BrowserRunRecord): Promise<void>;
  getRun(id: string): Promise<BrowserRunRecord | null>;
  createCaseResult(value: BrowserRunCaseRecord): Promise<void>;
  listCaseResults(browserRunId: string): Promise<BrowserRunCaseRecord[]>;
  getTerminal(browserRunId: string): Promise<BrowserRunTerminalRecord | null>;
  createTerminal(value: BrowserRunTerminalRecord): Promise<void>;
  getReceipt(browserRunId: string): Promise<BrowserRunReceiptRecord | null>;
  createReceipt(value: BrowserRunReceiptRecord): Promise<void>;
}

function invalid(message: string): never {
  throw new ValidationError(message);
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid(`Invalid browser run ${label}`);
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid(`Invalid browser run ${label} SHA-256`);
  return value;
}

function wholeSecond(value: Date, label: string): Date {
  const milliseconds = typeof value?.getTime === 'function' ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    invalid(`Invalid browser run ${label}`);
  }
  return new Date(Math.floor(milliseconds / 1000) * 1000);
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) invalid('Invalid browser run target origin');
  try {
    const parsed = new URL(value);
    const expected = `https://${parsed.host}`;
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash || value !== expected) {
      invalid('Browser run target origin must be one canonical HTTPS origin');
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    invalid('Browser run target origin must be one canonical HTTPS origin');
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Canonical JSON cannot contain NaN or Infinity');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') invalid('Canonical JSON contains an unsupported value');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid('Canonical JSON requires plain objects');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function parseCasePlan(value: unknown): Array<{ case_id: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CASES) {
    invalid('Browser run requires 1..100 precommitted cases');
  }
  const plan = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).length !== 1 || !Object.hasOwn(item, 'case_id')) {
      invalid('Browser run case plan is malformed');
    }
    return { case_id: exactId((item as Record<string, unknown>).case_id, 'case ID') };
  });
  const ids = plan.map((item) => item.case_id);
  if (new Set(ids).size !== ids.length || ids.join('\0') !== [...ids].sort().join('\0')) {
    invalid('Browser run case IDs must be unique and sorted');
  }
  return plan;
}

function validateTarget(target: BrowserRunTarget): BrowserRunTarget {
  return {
    issuer: exactId(target.issuer, 'issuer'),
    targetOrigin: canonicalOrigin(target.targetOrigin),
    targetServiceId: exactId(target.targetServiceId, 'target service identity'),
  };
}

export function browserRunTargetFromEnvironment(): BrowserRunTarget {
  return validateTarget({
    issuer: process.env.PROSER_BROWSER_RUN_ISSUER?.trim() ?? '',
    targetOrigin: process.env.PROSER_BROWSER_TARGET_ORIGIN?.trim() ?? '',
    targetServiceId: process.env.PROSER_BROWSER_TARGET_SERVICE_ID?.trim() ?? '',
  });
}

export function buildBrowserRunRecord(
  input: StartBrowserRunInput,
  target: BrowserRunTarget,
  now = new Date(),
  generatedId = `proser-browser:${randomUUID()}`,
): BrowserRunRecord {
  if (!REQUEST_PATTERN.test(input.requestId)) invalid('Invalid browser run request ID');
  exactId(input.evaluationId, 'evaluation ID');
  exactId(input.packageId, 'package ID');
  if (!Number.isSafeInteger(input.packageRevision) || input.packageRevision < 1 || input.packageRevision > 1_000_000) {
    invalid('Invalid browser run package revision');
  }
  exactSha256(input.packageDigest, 'package digest');
  exactSha256(input.runnerBuildSha256, 'runner build');
  exactSha256(input.fixtureSha256, 'fixture');
  if (!Array.isArray(input.caseIds)) invalid('Browser run requires precommitted cases');
  const casePlan = parseCasePlan(input.caseIds.map((caseId) => ({ case_id: caseId })));
  const identity = exactId(generatedId, 'identity');
  const trustedTarget = validateTarget(target);
  return {
    id: identity,
    receiptId: identity,
    ...trustedTarget,
    audience: AUDIENCE,
    requestId: input.requestId,
    evaluationId: input.evaluationId,
    packageId: input.packageId,
    packageRevision: input.packageRevision,
    packageDigest: input.packageDigest,
    surface: SURFACE,
    runnerBuildSha256: input.runnerBuildSha256,
    fixtureSha256: input.fixtureSha256,
    casePlan,
    casePlanSha256: canonicalSha256(casePlan),
    startedAt: wholeSecond(now, 'start time'),
  };
}

function validateReceiptCases(value: unknown): BrowserReceiptCase[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CASES) {
    invalid('Browser run terminal cases are malformed');
  }
  const cases = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).sort().join(',') !== 'case_id,evidence_sha256,status') {
      invalid('Browser run terminal case is malformed');
    }
    const record = item as Record<string, unknown>;
    const status = record.status;
    if (status !== 'pass' && status !== 'fail' && status !== 'blocked') {
      invalid('Invalid browser run case status');
    }
    return {
      case_id: exactId(record.case_id, 'case ID'),
      status: status as BrowserCaseStatus,
      evidence_sha256: exactSha256(record.evidence_sha256, 'case evidence'),
    };
  });
  const ids = cases.map((item) => item.case_id);
  if (new Set(ids).size !== ids.length || ids.join('\0') !== [...ids].sort().join('\0')) {
    invalid('Browser run terminal cases must be unique and sorted');
  }
  return cases;
}

function deriveOutcome(cases: BrowserReceiptCase[]): BrowserRunOutcome {
  if (cases.some((item) => item.status === 'fail')) return 'failed';
  if (cases.some((item) => item.status === 'blocked')) return 'blocked';
  return 'passed';
}

function resultMaterial(run: BrowserRunRecord, cases: BrowserReceiptCase[], observedAt: Date, outcome: BrowserRunOutcome) {
  return {
    version: VERSION,
    browser_run_id: run.id,
    receipt_id: run.receiptId,
    issuer: run.issuer,
    audience: run.audience,
    evaluation_id: run.evaluationId,
    request_id: run.requestId,
    package_id: run.packageId,
    package_revision: run.packageRevision,
    package_digest: run.packageDigest,
    surface: run.surface,
    target_origin: run.targetOrigin,
    target_service_id: run.targetServiceId,
    runner_build_sha256: run.runnerBuildSha256,
    fixture_sha256: run.fixtureSha256,
    case_plan_sha256: run.casePlanSha256,
    cases,
    case_cohort_sha256: canonicalSha256(cases),
    started_at: unixSeconds(run.startedAt),
    observed_at: unixSeconds(observedAt),
    outcome,
  };
}

export function deriveBrowserRunTerminal(
  run: BrowserRunRecord,
  results: BrowserRunCaseRecord[],
  completedAt = new Date(),
): BrowserRunTerminalRecord {
  const observedAt = wholeSecond(completedAt, 'completion time');
  if (observedAt < run.startedAt) invalid('Browser run completion precedes its start');
  const plan = parseCasePlan(run.casePlan);
  if (run.casePlanSha256 !== canonicalSha256(plan)) invalid('Browser run case plan digest differs');
  const byCase = new Map<string, BrowserRunCaseRecord>();
  for (const result of results) {
    if (result.browserRunId !== run.id) invalid('Browser run case belongs to another run');
    exactId(result.caseId, 'case ID');
    exactSha256(result.evidenceSha256, 'case evidence');
    if (!['pass', 'fail', 'blocked'].includes(result.status)) invalid('Invalid browser run case status');
    if (byCase.has(result.caseId)) invalid('Browser run case was recorded more than once');
    const caseObservedAt = wholeSecond(result.observedAt, 'case observation time');
    if (caseObservedAt < run.startedAt || caseObservedAt > observedAt) invalid('Browser run case chronology is invalid');
    byCase.set(result.caseId, result);
  }
  if (byCase.size !== plan.length || plan.some((item) => !byCase.has(item.case_id))) {
    invalid('Browser run cannot finish until every precommitted case has a result');
  }
  const cases = plan.map(({ case_id }) => {
    const result = byCase.get(case_id);
    if (!result) invalid('Browser run case result is missing');
    return { case_id, status: result.status, evidence_sha256: result.evidenceSha256 };
  });
  const outcome = deriveOutcome(cases);
  const material = resultMaterial(run, cases, observedAt, outcome);
  return {
    browserRunId: run.id,
    observedAt,
    outcome,
    cases,
    caseCohortSha256: material.case_cohort_sha256,
    resultSha256: canonicalSha256(material),
  };
}

export function assertBrowserRunTerminalIntegrity(
  run: BrowserRunRecord,
  terminal: BrowserRunTerminalRecord,
): BrowserRunTerminalRecord {
  if (terminal.browserRunId !== run.id) invalid('Browser run terminal belongs to another run');
  const cases = validateReceiptCases(terminal.cases);
  const plan = parseCasePlan(run.casePlan);
  if (run.casePlanSha256 !== canonicalSha256(plan)
      || plan.map((item) => item.case_id).join('\0') !== cases.map((item) => item.case_id).join('\0')) {
    invalid('Browser run terminal differs from its precommitted cases');
  }
  const observedAt = wholeSecond(terminal.observedAt, 'completion time');
  if (observedAt < run.startedAt) invalid('Browser run completion precedes its start');
  const outcome = deriveOutcome(cases);
  if (outcome !== terminal.outcome || canonicalSha256(cases) !== terminal.caseCohortSha256) {
    invalid('Browser run terminal outcome or case cohort digest differs');
  }
  if (canonicalSha256(resultMaterial(run, cases, observedAt, outcome)) !== terminal.resultSha256) {
    invalid('Browser run terminal result digest differs');
  }
  return { ...terminal, observedAt, cases };
}

function isCreateConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (String((error as { code: unknown }).code) === 'P2002' || String((error as { code: unknown }).code) === '55000'));
}

function prismaRun(row: {
  id: string; receiptId: string; issuer: string; audience: string; requestId: string;
  evaluationId: string; packageId: string; packageRevision: number; packageDigest: string;
  surface: string; targetOrigin: string; targetServiceId: string; runnerBuildSha256: string;
  fixtureSha256: string; casePlan: Prisma.JsonValue; casePlanSha256: string; startedAt: Date;
}): BrowserRunRecord {
  if (row.audience !== AUDIENCE || row.surface !== SURFACE) invalid('Stored browser run has an invalid audience or surface');
  return { ...row, audience: AUDIENCE, surface: SURFACE, casePlan: parseCasePlan(row.casePlan) };
}

function prismaTerminal(row: {
  browserRunId: string; observedAt: Date; outcome: string; cases: Prisma.JsonValue;
  caseCohortSha256: string; resultSha256: string;
}): BrowserRunTerminalRecord {
  if (row.outcome !== 'passed' && row.outcome !== 'failed' && row.outcome !== 'blocked') {
    invalid('Stored browser run has an invalid outcome');
  }
  return { ...row, outcome: row.outcome, cases: validateReceiptCases(row.cases) };
}

export class PrismaBrowserRunRepository implements BrowserRunRepository {
  async createRun(value: BrowserRunRecord): Promise<void> {
    try {
      await databaseService.client.browserRun.create({ data: {
        ...value,
        casePlan: value.casePlan as Prisma.InputJsonValue,
      } });
    } catch (error) {
      if (isCreateConflict(error)) invalid('Browser run identity or evaluation was already journaled');
      throw error;
    }
  }

  async getRun(id: string): Promise<BrowserRunRecord | null> {
    const row = await databaseService.client.browserRun.findUnique({ where: { id } });
    return row ? prismaRun(row) : null;
  }

  async createCaseResult(value: BrowserRunCaseRecord): Promise<void> {
    try { await databaseService.client.browserRunCaseResult.create({ data: value }); }
    catch (error) {
      if (isCreateConflict(error)) invalid('Browser run case result was already recorded');
      throw error;
    }
  }

  async listCaseResults(browserRunId: string): Promise<BrowserRunCaseRecord[]> {
    const rows = await databaseService.client.browserRunCaseResult.findMany({
      where: { browserRunId }, orderBy: { caseId: 'asc' },
    });
    return rows.map((row) => {
      if (row.status !== 'pass' && row.status !== 'fail' && row.status !== 'blocked') {
        invalid('Stored browser run has an invalid case status');
      }
      return { ...row, status: row.status as BrowserCaseStatus };
    });
  }

  async getTerminal(browserRunId: string): Promise<BrowserRunTerminalRecord | null> {
    const row = await databaseService.client.browserRunTerminal.findUnique({ where: { browserRunId } });
    return row ? prismaTerminal(row) : null;
  }

  async createTerminal(value: BrowserRunTerminalRecord): Promise<void> {
    try {
      await databaseService.client.browserRunTerminal.create({ data: {
        ...value,
        cases: value.cases as Prisma.InputJsonValue,
      } });
    } catch (error) {
      if (isCreateConflict(error)) invalid('Browser run was already terminalized');
      throw error;
    }
  }

  async getReceipt(browserRunId: string): Promise<BrowserRunReceiptRecord | null> {
    return databaseService.client.browserRunReceipt.findUnique({ where: { browserRunId } });
  }

  async createReceipt(value: BrowserRunReceiptRecord): Promise<void> {
    try { await databaseService.client.browserRunReceipt.create({ data: value }); }
    catch (error) {
      if (isCreateConflict(error)) invalid('Browser run receipt was already signed');
      throw error;
    }
  }
}

export class BrowserRunJournalService {
  constructor(
    private readonly repository: BrowserRunRepository = new PrismaBrowserRunRepository(),
    private readonly configuredTarget?: BrowserRunTarget,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async start(input: StartBrowserRunInput): Promise<BrowserRunRecord> {
    const record = buildBrowserRunRecord(input, this.configuredTarget ?? browserRunTargetFromEnvironment(), this.clock());
    await this.repository.createRun(record);
    return record;
  }

  async recordCase(
    browserRunId: string,
    input: { caseId: string; status: BrowserCaseStatus; evidenceSha256: string },
  ): Promise<BrowserRunCaseRecord> {
    exactId(browserRunId, 'identity');
    const run = await this.repository.getRun(browserRunId);
    if (!run) throw new NotFoundError('Browser run not found');
    if (await this.repository.getTerminal(browserRunId)) invalid('Browser run is already terminal');
    const caseId = exactId(input.caseId, 'case ID');
    if (!run.casePlan.some((item) => item.case_id === caseId)) invalid('Browser run case was not precommitted');
    if (input.status !== 'pass' && input.status !== 'fail' && input.status !== 'blocked') {
      invalid('Invalid browser run case status');
    }
    const record = {
      browserRunId,
      caseId,
      status: input.status,
      evidenceSha256: exactSha256(input.evidenceSha256, 'case evidence'),
      observedAt: wholeSecond(this.clock(), 'case observation time'),
    };
    if (record.observedAt < run.startedAt) invalid('Browser run case precedes its start');
    await this.repository.createCaseResult(record);
    return record;
  }

  async finish(browserRunId: string): Promise<BrowserRunTerminalRecord> {
    exactId(browserRunId, 'identity');
    const run = await this.repository.getRun(browserRunId);
    if (!run) throw new NotFoundError('Browser run not found');
    if (await this.repository.getTerminal(browserRunId)) invalid('Browser run was already terminalized');
    const terminal = deriveBrowserRunTerminal(run, await this.repository.listCaseResults(browserRunId), this.clock());
    await this.repository.createTerminal(terminal);
    return terminal;
  }
}

type LoadedSigningKey = { privateKey: KeyObject; keyId: string };

function stableStat(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.uid === after.uid && before.gid === after.gid
    && before.nlink === after.nlink && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export async function loadSafeEd25519PrivateKey(filename: string): Promise<LoadedSigningKey> {
  if (!isAbsolute(filename)) invalid('Browser receipt private key path must be absolute');
  let handle: FileHandle | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : before.uid;
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_KEY_BYTES
        || (before.mode & 0o077) !== 0 || (before.uid !== 0 && before.uid !== effectiveUid)) {
      invalid('Browser receipt private key file is unavailable or unsafe');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.size !== bytes.length
        || (after.mode & 0o077) !== 0 || (after.uid !== 0 && after.uid !== effectiveUid)
        || !stableStat(before, after)) {
      invalid('Browser receipt private key changed while being read');
    }
    const privateKey = createPrivateKey(bytes);
    if (privateKey.asymmetricKeyType !== 'ed25519') invalid('Browser receipt private key must be Ed25519');
    const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (!Buffer.isBuffer(publicDer) || publicDer.length !== 44
        || !publicDer.subarray(0, 12).equals(Buffer.from('302a300506032b6570032100', 'hex'))) {
      invalid('Browser receipt private key must be Ed25519');
    }
    return { privateKey, keyId: createHash('sha256').update(publicDer).digest('hex') };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return invalid('Browser receipt private key file is unavailable or invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unsignedReceipt(
  run: BrowserRunRecord,
  terminal: BrowserRunTerminalRecord,
  keyId: string,
): Omit<NovaBrowserRunnerReceipt, 'signature'> {
  const observedAt = unixSeconds(terminal.observedAt);
  return {
    version: VERSION,
    receipt_id: run.receiptId,
    issuer: run.issuer,
    key_id: keyId,
    audience: AUDIENCE,
    evaluation_id: run.evaluationId,
    request_id: run.requestId,
    package_id: run.packageId,
    package_revision: run.packageRevision,
    package_digest: run.packageDigest,
    surface: SURFACE,
    target_origin: run.targetOrigin,
    target_service_id: run.targetServiceId,
    runner_build_sha256: run.runnerBuildSha256,
    fixture_sha256: run.fixtureSha256,
    case_cohort_sha256: terminal.caseCohortSha256,
    cases: terminal.cases,
    observed_at: observedAt,
    expires_at: observedAt + RECEIPT_LIFETIME_SECONDS,
    outcome: terminal.outcome,
    result_sha256: terminal.resultSha256,
  };
}

async function readStableReceiptFile(filename: string): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : before.uid;
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 256 * 1024
        || (before.mode & 0o022) !== 0 || (before.uid !== 0 && before.uid !== effectiveUid)) {
      invalid('Existing browser receipt output is unsafe');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== bytes.length || !stableStat(before, after)) {
      invalid('Existing browser receipt output changed while being read');
    }
    return bytes;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return invalid('Existing browser receipt output is unavailable or unsafe');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function recoverPublishedTempLink(
  directoryHandle: FileHandle,
  receiptId: string,
  filename: string,
): Promise<void> {
  const anchor = `/proc/self/fd/${directoryHandle.fd}`;
  let finalHandle: FileHandle | undefined;
  try {
    finalHandle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const finalMetadata = await finalHandle.stat();
    if (!finalMetadata.isFile() || finalMetadata.nlink < 1 || (finalMetadata.mode & 0o022) !== 0) {
      invalid('Existing browser receipt output is unsafe');
    }
    const prefix = `.${receiptId}.`;
    for (const entry of await readdir(anchor)) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
      const candidate = join(anchor, entry);
      let candidateHandle: FileHandle | undefined;
      try {
        candidateHandle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const candidateMetadata = await candidateHandle.stat();
        if (candidateMetadata.dev === finalMetadata.dev && candidateMetadata.ino === finalMetadata.ino) {
          await candidateHandle.close();
          candidateHandle = undefined;
          await unlink(candidate);
        }
      } catch {
        // An unrelated or concurrently removed temporary name is not recovery evidence.
      } finally {
        await candidateHandle?.close().catch(() => undefined);
      }
    }
    await directoryHandle.sync();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    invalid('Existing browser receipt output is unavailable or unsafe');
  } finally {
    await finalHandle?.close().catch(() => undefined);
  }
}

async function openSafeOutputDirectory(outputDirectory: string): Promise<FileHandle> {
  if (!isAbsolute(outputDirectory)) invalid('Browser receipt output directory must be absolute');
  let handle: FileHandle | undefined;
  try {
    handle = await open(outputDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : metadata.uid;
    if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0
        || (metadata.uid !== 0 && metadata.uid !== effectiveUid)) {
      invalid('Browser receipt output directory is unavailable or unsafe');
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ValidationError) throw error;
    invalid('Browser receipt output directory is unavailable or unsafe');
  }
}

async function writeReceiptFile(outputDirectory: string, receiptId: string, canonical: string): Promise<string> {
  const directoryHandle = await openSafeOutputDirectory(outputDirectory);
  const basename = `${exactId(receiptId, 'receipt ID')}.json`;
  const anchor = `/proc/self/fd/${directoryHandle.fd}`;
  const filename = join(anchor, basename);
  const temporary = join(anchor, `.${receiptId}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(canonical, 'utf8');
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o644);
      await handle.sync();
      const written = await handle.stat();
      if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length
          || (written.mode & 0o022) !== 0) {
        invalid('Browser receipt output file is unsafe');
      }
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, filename);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code) : '';
      if (code !== 'EEXIST') throw error;
      await recoverPublishedTempLink(directoryHandle, receiptId, filename);
      const existing = await readStableReceiptFile(filename);
      if (!existing.equals(bytes)) invalid('A different browser receipt already exists at the output path');
    }
    await unlink(temporary);
    temporaryCreated = false;
    await directoryHandle.sync();
    const published = await readStableReceiptFile(filename);
    if (!published.equals(bytes)) {
      invalid('Published browser receipt differs from the durable signed receipt');
    }
    return join(outputDirectory, basename);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return invalid('Browser receipt output already exists or could not be written safely');
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
    await directoryHandle.close().catch(() => undefined);
  }
}

function parseStoredReceipt(value: BrowserRunReceiptRecord): NovaBrowserRunnerReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(value.canonicalJson); }
  catch { invalid('Stored browser receipt is malformed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('Stored browser receipt is malformed');
  const record = parsed as Record<string, unknown>;
  const fields = [
    'audience', 'case_cohort_sha256', 'cases', 'evaluation_id', 'expires_at', 'fixture_sha256',
    'issuer', 'key_id', 'observed_at', 'outcome', 'package_digest', 'package_id',
    'package_revision', 'receipt_id', 'request_id', 'result_sha256', 'runner_build_sha256',
    'signature', 'surface', 'target_origin', 'target_service_id', 'version',
  ];
  if (record.receipt_id !== value.receiptId || record.key_id !== value.keyId
      || record.signature !== value.signature || Object.keys(record).sort().join('\0') !== fields.sort().join('\0')
      || canonicalJson(record) !== value.canonicalJson || canonicalSha256(record) !== value.receiptSha256) {
    invalid('Stored browser receipt digest differs');
  }
  return record as unknown as NovaBrowserRunnerReceipt;
}

export class BrowserRunReceiptExporter {
  constructor(
    private readonly repository: BrowserRunRepository = new PrismaBrowserRunRepository(),
    private readonly configuredPrivateKeyFile?: string,
    private readonly configuredOutputDirectory?: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private privateKeyFile(): string {
    const filename = this.configuredPrivateKeyFile
      ?? process.env.PROSER_BROWSER_RECEIPT_PRIVATE_KEY_FILE?.trim() ?? '';
    if (!filename) invalid('Browser receipt private key file is not configured');
    return filename;
  }

  private outputDirectory(): string {
    const directory = this.configuredOutputDirectory
      ?? process.env.PROSER_BROWSER_RECEIPT_OUTPUT_DIR?.trim() ?? '';
    if (!directory) invalid('Browser receipt output directory is not configured');
    return directory;
  }

  async sign(browserRunId: string): Promise<NovaBrowserRunnerReceipt> {
    exactId(browserRunId, 'identity');
    const run = await this.repository.getRun(browserRunId);
    if (!run) throw new NotFoundError('Browser run not found');
    const terminalValue = await this.repository.getTerminal(browserRunId);
    if (!terminalValue) invalid('Browser run is not terminal');
    if (await this.repository.getReceipt(browserRunId)) invalid('Browser run receipt was already signed');
    const terminal = assertBrowserRunTerminalIntegrity(run, terminalValue);
    const current = unixSeconds(wholeSecond(this.clock(), 'export time'));
    const observed = unixSeconds(terminal.observedAt);
    if (observed > current + MAX_CLOCK_SKEW_SECONDS || current >= observed + RECEIPT_LIFETIME_SECONDS) {
      invalid('Browser run is not fresh enough for a new receipt');
    }
    const { privateKey, keyId } = await loadSafeEd25519PrivateKey(this.privateKeyFile());
    const unsigned = unsignedReceipt(run, terminal, keyId);
    const signature = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKey).toString('base64url');
    const receipt: NovaBrowserRunnerReceipt = { ...unsigned, signature };
    const canonical = canonicalJson(receipt);
    await this.repository.createReceipt({
      browserRunId,
      receiptId: run.receiptId,
      keyId,
      signature,
      canonicalJson: canonical,
      receiptSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      expiresAt: new Date(unsigned.expires_at * 1000),
    });
    return receipt;
  }

  async export(browserRunId: string): Promise<{ receipt: NovaBrowserRunnerReceipt; path: string }> {
    exactId(browserRunId, 'identity');
    const existing = await this.repository.getReceipt(browserRunId);
    const receipt = existing ? parseStoredReceipt(existing) : await this.sign(browserRunId);
    const canonical = existing?.canonicalJson ?? canonicalJson(receipt);
    return {
      receipt,
      path: await writeReceiptFile(this.outputDirectory(), receipt.receipt_id, canonical),
    };
  }

  async materializeExisting(browserRunId: string): Promise<string> {
    exactId(browserRunId, 'identity');
    const stored = await this.repository.getReceipt(browserRunId);
    if (!stored) throw new NotFoundError('Signed browser run receipt not found');
    const receipt = parseStoredReceipt(stored);
    return writeReceiptFile(this.outputDirectory(), receipt.receipt_id, stored.canonicalJson);
  }
}

export const browserRunJournalService = new BrowserRunJournalService();
export const browserRunReceiptExporter = new BrowserRunReceiptExporter();
