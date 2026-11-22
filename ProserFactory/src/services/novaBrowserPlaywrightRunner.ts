import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import { ValidationError } from '@/lib/errors';
import {
  BrowserRunJournalService,
  browserRunTargetFromEnvironment,
  canonicalJson,
  type BrowserRunTarget,
  type BrowserRunTerminalRecord,
  type StartBrowserRunInput,
} from '@/services/browserRunReceiptService';

const MAX_INPUT_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REQUEST_PATTERN = /^nova-[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type BrowserAction =
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'press'; selector: string; key: string };

type BrowserAssertion =
  | { assertion: 'visible'; selector: string }
  | { assertion: 'text'; selector: string; contains: string }
  | { assertion: 'url'; path: string };

export type NovaBrowserCaseFixture = {
  case_id: string;
  path: string;
  timeout_ms: number;
  actions: BrowserAction[];
  assertions: BrowserAssertion[];
};

export type NovaBrowserFixture = {
  version: 1;
  cases: NovaBrowserCaseFixture[];
};

export type NovaBrowserEvaluationBinding = Pick<StartBrowserRunInput,
  'requestId' | 'evaluationId' | 'packageId' | 'packageRevision' | 'packageDigest'>;

type StableFile = { bytes: Buffer; metadata: Stats };

type RunnerOptions = {
  binding: NovaBrowserEvaluationBinding;
  fixtureFile: string;
  evidenceDirectory: string;
  storageStateFile?: string;
};

type EvidenceBundle = {
  version: 1;
  browser_run_id: string;
  case_id: string;
  case_definition_sha256: string;
  runner_build_sha256: string;
  fixture_sha256: string;
  target_url: string;
  started_at: number;
  observed_at: number;
  status: 'pass' | 'fail' | 'blocked';
  final_url: string | null;
  screenshot_sha256: string | null;
  error_class: string | null;
  error_message: string | null;
};

class BrowserAssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserAssertionFailure';
  }
}

function invalid(message: string): never {
  throw new ValidationError(message);
}

function stableStat(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.uid === after.uid && before.gid === after.gid
    && before.nlink === after.nlink && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readStableRegularFile(filename: string, label: string, privateFile: boolean): Promise<StableFile> {
  if (!isAbsolute(filename)) invalid(`${label} path must be absolute`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : before.uid;
    const forbiddenMode = privateFile ? 0o077 : 0o022;
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_INPUT_BYTES
        || (before.mode & forbiddenMode) !== 0 || (before.uid !== 0 && before.uid !== effectiveUid)) {
      invalid(`${label} is unavailable or unsafe`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.size !== bytes.length
        || (after.mode & forbiddenMode) !== 0 || (after.uid !== 0 && after.uid !== effectiveUid)
        || !stableStat(before, after)) {
      invalid(`${label} changed while being read`);
    }
    return { bytes, metadata: after };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return invalid(`${label} is unavailable or unsafe`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) invalid(`${label} is malformed`);
}

function boundedString(value: unknown, label: string, maximum = 2_000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) invalid(`${label} is invalid`);
  return value;
}

function relativeTargetPath(value: unknown, target: BrowserRunTarget): string {
  const path = boundedString(value, 'Browser fixture path', 1_000);
  if (!path.startsWith('/')) invalid('Browser fixture paths must be absolute URL paths');
  const resolved = new URL(path, target.targetOrigin);
  if (resolved.origin !== target.targetOrigin || resolved.username || resolved.password) {
    invalid('Browser fixture path escapes the configured target');
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function parseAction(value: unknown): BrowserAction {
  const record = plainRecord(value, 'Browser fixture action');
  if (record.action === 'click') {
    exactKeys(record, ['action', 'selector'], 'Browser fixture click action');
    return { action: 'click', selector: boundedString(record.selector, 'Browser fixture selector') };
  }
  if (record.action === 'fill') {
    exactKeys(record, ['action', 'selector', 'value'], 'Browser fixture fill action');
    return {
      action: 'fill',
      selector: boundedString(record.selector, 'Browser fixture selector'),
      value: boundedString(record.value, 'Browser fixture fill value', 10_000),
    };
  }
  if (record.action === 'press') {
    exactKeys(record, ['action', 'selector', 'key'], 'Browser fixture press action');
    return {
      action: 'press',
      selector: boundedString(record.selector, 'Browser fixture selector'),
      key: boundedString(record.key, 'Browser fixture key', 100),
    };
  }
  return invalid('Browser fixture action is unsupported');
}

function parseAssertion(value: unknown, target: BrowserRunTarget): BrowserAssertion {
  const record = plainRecord(value, 'Browser fixture assertion');
  if (record.assertion === 'visible') {
    exactKeys(record, ['assertion', 'selector'], 'Browser fixture visible assertion');
    return { assertion: 'visible', selector: boundedString(record.selector, 'Browser fixture selector') };
  }
  if (record.assertion === 'text') {
    exactKeys(record, ['assertion', 'selector', 'contains'], 'Browser fixture text assertion');
    return {
      assertion: 'text',
      selector: boundedString(record.selector, 'Browser fixture selector'),
      contains: boundedString(record.contains, 'Browser fixture expected text', 10_000),
    };
  }
  if (record.assertion === 'url') {
    exactKeys(record, ['assertion', 'path'], 'Browser fixture URL assertion');
    return { assertion: 'url', path: relativeTargetPath(record.path, target) };
  }
  return invalid('Browser fixture assertion is unsupported');
}

export function parseNovaBrowserFixture(value: unknown, target: BrowserRunTarget): NovaBrowserFixture {
  const record = plainRecord(value, 'Browser fixture');
  exactKeys(record, ['version', 'cases'], 'Browser fixture');
  if (record.version !== 1 || !Array.isArray(record.cases) || record.cases.length < 1 || record.cases.length > 100) {
    invalid('Browser fixture requires version 1 and 1..100 cases');
  }
  const cases = record.cases.map((value): NovaBrowserCaseFixture => {
    const item = plainRecord(value, 'Browser fixture case');
    exactKeys(item, ['case_id', 'path', 'timeout_ms', 'actions', 'assertions'], 'Browser fixture case');
    const caseId = boundedString(item.case_id, 'Browser fixture case ID', 160);
    if (!ID_PATTERN.test(caseId)) invalid('Browser fixture case ID is invalid');
    if (!Number.isSafeInteger(item.timeout_ms) || Number(item.timeout_ms) < 1_000 || Number(item.timeout_ms) > 60_000) {
      invalid('Browser fixture case timeout is invalid');
    }
    if (!Array.isArray(item.actions) || !Array.isArray(item.assertions) || item.assertions.length < 1) {
      invalid('Browser fixture case actions or assertions are malformed');
    }
    return {
      case_id: caseId,
      path: relativeTargetPath(item.path, target),
      timeout_ms: Number(item.timeout_ms),
      actions: item.actions.map(parseAction),
      assertions: item.assertions.map((assertion) => parseAssertion(assertion, target)),
    };
  }).sort((left, right) => left.case_id.localeCompare(right.case_id));
  if (new Set(cases.map((item) => item.case_id)).size !== cases.length) {
    invalid('Browser fixture case IDs must be unique');
  }
  return { version: 1, cases };
}

export function parseNovaBrowserEvaluationBinding(value: unknown): NovaBrowserEvaluationBinding {
  const record = plainRecord(value, 'Nova browser evaluation binding');
  exactKeys(record, ['request_id', 'evaluation_id', 'package_id', 'package_revision', 'package_digest'], 'Nova browser evaluation binding');
  if (typeof record.request_id !== 'string' || !REQUEST_PATTERN.test(record.request_id)
      || typeof record.evaluation_id !== 'string' || !ID_PATTERN.test(record.evaluation_id)
      || typeof record.package_id !== 'string' || !ID_PATTERN.test(record.package_id)
      || !Number.isSafeInteger(record.package_revision) || Number(record.package_revision) < 1
      || Number(record.package_revision) > 1_000_000
      || typeof record.package_digest !== 'string' || !SHA256_PATTERN.test(record.package_digest)) {
    invalid('Nova browser evaluation binding is invalid');
  }
  return {
    requestId: record.request_id,
    evaluationId: record.evaluation_id,
    packageId: record.package_id,
    packageRevision: Number(record.package_revision),
    packageDigest: record.package_digest,
  };
}

export async function loadNovaBrowserEvaluationBinding(filename: string): Promise<NovaBrowserEvaluationBinding> {
  const source = await readStableRegularFile(filename, 'Nova browser evaluation binding file', true);
  try {
    return parseNovaBrowserEvaluationBinding(JSON.parse(source.bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return invalid('Nova browser evaluation binding file is malformed');
  }
}

async function openEvidenceRunDirectory(baseDirectory: string, browserRunId: string): Promise<FileHandle> {
  if (!isAbsolute(baseDirectory)) invalid('Browser evidence directory path must be absolute');
  let baseHandle: FileHandle | undefined;
  try {
    baseHandle = await open(baseDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const base = await baseHandle.stat();
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : base.uid;
    if (!base.isDirectory() || (base.mode & 0o077) !== 0 || (base.uid !== 0 && base.uid !== effectiveUid)) {
      invalid('Browser evidence directory is unavailable or unsafe');
    }
    const anchor = `/proc/self/fd/${baseHandle.fd}`;
    await mkdir(join(anchor, browserRunId), { mode: 0o700 });
    await baseHandle.sync();
    return await open(join(anchor, browserRunId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return invalid('Browser evidence run directory could not be created safely');
  } finally {
    await baseHandle?.close().catch(() => undefined);
  }
}

async function writeEvidenceFile(directory: FileHandle, basename: string, bytes: Buffer): Promise<void> {
  const filename = join(`/proc/self/fd/${directory.fd}`, basename);
  const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await directory.sync();
}

async function performActions(page: Page, fixture: NovaBrowserCaseFixture): Promise<void> {
  for (const action of fixture.actions) {
    const locator = page.locator(action.selector);
    if (action.action === 'click') await locator.click({ timeout: fixture.timeout_ms });
    else if (action.action === 'fill') await locator.fill(action.value, { timeout: fixture.timeout_ms });
    else await locator.press(action.key, { timeout: fixture.timeout_ms });
  }
}

async function performAssertions(page: Page, fixture: NovaBrowserCaseFixture, target: BrowserRunTarget): Promise<void> {
  for (const assertion of fixture.assertions) {
    if (assertion.assertion === 'url') {
      const expected = new URL(assertion.path, target.targetOrigin).href;
      if (page.url() !== expected) throw new BrowserAssertionFailure(`Expected URL ${expected}`);
      continue;
    }
    const locator = page.locator(assertion.selector);
    if (assertion.assertion === 'visible') {
      try { await locator.waitFor({ state: 'visible', timeout: fixture.timeout_ms }); }
      catch { throw new BrowserAssertionFailure(`Expected visible selector ${assertion.selector}`); }
      continue;
    }
    const actual = await locator.textContent({ timeout: fixture.timeout_ms });
    if (!actual?.includes(assertion.contains)) {
      throw new BrowserAssertionFailure(`Expected selector ${assertion.selector} to contain configured text`);
    }
  }
}

function errorEvidence(error: unknown): { errorClass: string; errorMessage: string } {
  const errorClass = error instanceof Error ? error.name : 'UnknownError';
  const raw = error instanceof Error ? error.message : String(error);
  return { errorClass: errorClass.slice(0, 160), errorMessage: raw.slice(0, 2_000) };
}

function assertPageStayedOnTarget(page: Page, target: BrowserRunTarget): void {
  let current: URL;
  try { current = new URL(page.url()); }
  catch { return invalid('Browser page URL is malformed'); }
  if (current.origin !== target.targetOrigin) invalid('Browser page escaped the configured target origin');
}

export class NovaBrowserPlaywrightRunner {
  constructor(
    private readonly journal: BrowserRunJournalService = new BrowserRunJournalService(),
    private readonly target: BrowserRunTarget = browserRunTargetFromEnvironment(),
    private readonly launchBrowser: () => Promise<Browser> = () => chromium.launch({ headless: true }),
    private readonly runnerBuildFile: string = __filename,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(options: RunnerOptions): Promise<{ browserRunId: string; terminal: BrowserRunTerminalRecord }> {
    const fixtureSource = await readStableRegularFile(options.fixtureFile, 'Browser fixture file', false);
    let fixtureValue: unknown;
    try { fixtureValue = JSON.parse(fixtureSource.bytes.toString('utf8')); }
    catch { invalid('Browser fixture file is malformed'); }
    const fixture = parseNovaBrowserFixture(fixtureValue, this.target);
    const runnerSource = await readStableRegularFile(this.runnerBuildFile, 'Browser runner build file', false);
    const runnerBuildSha256 = createHash('sha256').update(runnerSource.bytes).digest('hex');
    const fixtureSha256 = createHash('sha256').update(fixtureSource.bytes).digest('hex');
    let storageState: Exclude<BrowserContextOptions['storageState'], string | undefined> | undefined;
    if (options.storageStateFile) {
      const stateSource = await readStableRegularFile(options.storageStateFile, 'Browser storage-state file', true);
      try {
        storageState = plainRecord(
          JSON.parse(stateSource.bytes.toString('utf8')),
          'Browser storage-state file',
        ) as unknown as Exclude<BrowserContextOptions['storageState'], string | undefined>;
      }
      catch (error) {
        if (error instanceof ValidationError) throw error;
        invalid('Browser storage-state file is malformed');
      }
    }
    const run = await this.journal.start({
      ...options.binding,
      runnerBuildSha256,
      fixtureSha256,
      caseIds: fixture.cases.map((item) => item.case_id),
    });
    const evidenceDirectory = await openEvidenceRunDirectory(options.evidenceDirectory, run.id);
    let browser: Browser | undefined;
    let launchError: unknown;
    try { browser = await this.launchBrowser(); }
    catch (error) { launchError = error; }
    try {
      for (const fixtureCase of fixture.cases) {
        const startedAt = Math.floor(this.clock().getTime() / 1000);
        let context: BrowserContext | undefined;
        let page: Page | undefined;
        let status: 'pass' | 'fail' | 'blocked' = 'blocked';
        let capturedError = launchError;
        let screenshotSha256: string | null = null;
        try {
          if (!browser) throw launchError ?? new Error('Browser launch failed');
          context = await browser.newContext(storageState ? { storageState } : undefined);
          page = await context.newPage();
          await page.goto(new URL(fixtureCase.path, this.target.targetOrigin).href, {
            waitUntil: 'domcontentloaded', timeout: fixtureCase.timeout_ms,
          });
          assertPageStayedOnTarget(page, this.target);
          await performActions(page, fixtureCase);
          assertPageStayedOnTarget(page, this.target);
          await performAssertions(page, fixtureCase, this.target);
          status = 'pass';
          capturedError = undefined;
        } catch (error) {
          capturedError = error;
          status = error instanceof BrowserAssertionFailure ? 'fail' : 'blocked';
        }
        if (page) {
          try {
            const screenshot = await page.screenshot({ type: 'png', fullPage: true });
            screenshotSha256 = createHash('sha256').update(screenshot).digest('hex');
            await writeEvidenceFile(evidenceDirectory, `${fixtureCase.case_id}.png`, screenshot);
          } catch (error) {
            capturedError = error;
            status = 'blocked';
            screenshotSha256 = null;
          }
        }
        const observedAt = Math.floor(this.clock().getTime() / 1000);
        const failure = capturedError ? errorEvidence(capturedError) : null;
        const evidence: EvidenceBundle = {
          version: 1,
          browser_run_id: run.id,
          case_id: fixtureCase.case_id,
          case_definition_sha256: createHash('sha256').update(canonicalJson(fixtureCase)).digest('hex'),
          runner_build_sha256: runnerBuildSha256,
          fixture_sha256: fixtureSha256,
          target_url: new URL(fixtureCase.path, this.target.targetOrigin).href,
          started_at: startedAt,
          observed_at: observedAt,
          status,
          final_url: page?.url() ?? null,
          screenshot_sha256: screenshotSha256,
          error_class: failure?.errorClass ?? null,
          error_message: failure?.errorMessage ?? null,
        };
        const evidenceBytes = Buffer.from(canonicalJson(evidence), 'utf8');
        await writeEvidenceFile(evidenceDirectory, `${fixtureCase.case_id}.json`, evidenceBytes);
        await this.journal.recordCase(run.id, {
          caseId: fixtureCase.case_id,
          status,
          evidenceSha256: createHash('sha256').update(evidenceBytes).digest('hex'),
        });
        await context?.close().catch(() => undefined);
      }
      return { browserRunId: run.id, terminal: await this.journal.finish(run.id) };
    } finally {
      await browser?.close().catch(() => undefined);
      await evidenceDirectory.close().catch(() => undefined);
    }
  }
}
