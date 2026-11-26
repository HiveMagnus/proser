import type { DocumentMutationPreconditions } from '@hivemagnus/proser-contracts';
const API_BASE = '';

type FactoryEnvelope<T> = {
  ok: boolean;
  success?: boolean;
  data: T;
  error?: string | { message?: string; code?: string };
  code?: string;
};

export class FactoryRequestError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'FactoryRequestError';
    this.status = status;
    this.code = code;
  }
}

export class FactoryTimeoutError extends FactoryRequestError {
  constructor(message = 'Factory request timed out') {
    super(408, message, 'FACTORY_TIMEOUT');
    this.name = 'FactoryTimeoutError';
  }
}

export class FactoryResponseTooLargeError extends FactoryRequestError {
  constructor(limitBytes: number) {
    super(
      502,
      `Factory response exceeded the ${limitBytes.toLocaleString()} byte limit`,
      'FACTORY_RESPONSE_TOO_LARGE',
    );
    this.name = 'FactoryResponseTooLargeError';
  }
}

export interface GenerationOperationReceipt {
  operationId: string;
  idempotencyKey: string;
  requestHash: string;
  route: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  latestCursor: number;
  artifactHash?: string;
  errorCode?: string;
}

export interface ProseOperationRequest {
  bookId: number;
  sceneId?: number;
  prompt?: string;
  instructions?: string;
  targetWords?: number;
  pov?: string;
  tense?: string;
}

export function createProseOperation(
  request: ProseOperationRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return requestFactory<GenerationOperationReceipt>('/api/generate/operations', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ kind: 'prose', ...request }),
    timeoutMs: 30_000,
    signal,
  });
}

export async function findUnresolvedGenerationOperations(idempotencyKey?: string) {
  const query = idempotencyKey ? `?idempotencyKey=${encodeURIComponent(idempotencyKey)}` : '';
  return requestFactory<{ operations: GenerationOperationReceipt[] }>(
    `/api/generate/operations/unresolved${query}`,
  );
}

export function lookupGenerationOperation(idempotencyKey: string) {
  return requestFactory<GenerationOperationReceipt>(
    `/api/generate/operations/lookup?idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
  );
}

export function getGenerationArtifact(operationId: string) {
  return requestFactory<{ operation: GenerationOperationReceipt; artifact: string }>(
    `/api/generate/operations/${encodeURIComponent(operationId)}/artifact`,
  );
}

export function cancelGenerationOperation(operationId: string) {
  return requestFactory<GenerationOperationReceipt>(
    `/api/generate/operations/${encodeURIComponent(operationId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
}

type FactoryRequestInit = RequestInit & { timeoutMs?: number; responseLimitBytes?: number };

function responseLimit(path: string) {
  if (/\/api\/books\/[^/]+\/findings/.test(path)) return 2 * 1024 * 1024;
  if (/\/api\/workflows\//.test(path)) return 1024 * 1024;
  if (/\/api\/editorial\//.test(path)) return 1024 * 1024;
  return 8 * 1024 * 1024;
}

async function readBoundedResponse(res: Response, limitBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limitBytes) throw new FactoryResponseTooLargeError(limitBytes);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limitBytes) {
      await reader.cancel();
      throw new FactoryResponseTooLargeError(limitBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function requestFactory<T>(path: string, init?: FactoryRequestInit): Promise<T> {
  if (init?.signal?.aborted) {
    throw init.signal.reason instanceof Error
      ? init.signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
  const timeoutController = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 30_000;
  const timeout = globalThis.setTimeout(() => timeoutController.abort('timeout'), timeoutMs);
  const abortFromCaller = () => timeoutController.abort(init?.signal?.reason ?? 'cancelled');
  init?.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: timeoutController.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    const raw = await readBoundedResponse(res, init?.responseLimitBytes ?? responseLimit(path));
    const body = (() => {
      try {
        return JSON.parse(raw) as FactoryEnvelope<T>;
      } catch {
        return null;
      }
    })();
    const isOk = Boolean(body?.ok ?? body?.success);
    const errorMessage = typeof body?.error === 'string' ? body.error : body?.error?.message;
    const errorCode = typeof body?.error === 'object' ? body.error?.code : body?.code;

    if (!res.ok || !isOk) {
      if (errorCode === 'UPSTREAM_TIMEOUT') throw new FactoryTimeoutError(errorMessage);
      if (errorCode === 'UPSTREAM_RESPONSE_TOO_LARGE')
        throw new FactoryResponseTooLargeError(init?.responseLimitBytes ?? responseLimit(path));
      throw new FactoryRequestError(res.status, errorMessage || `API ${res.status}`, errorCode);
    }

    if (!body) throw new FactoryRequestError(res.status, `API ${res.status}`);

    return body.data;
  } catch (error) {
    if (timeoutController.signal.aborted && !init?.signal?.aborted) throw new FactoryTimeoutError();
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    init?.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function stringId(value: unknown) {
  return String(value ?? '');
}

export interface Book {
  id: string;
  title: string;
  genre?: string;
  archetype?: string;
  draftStatus?: string;
  wordCount?: number;
  summary?: string | null;
  updatedAt?: string;
}

export interface SceneRecord {
  id: string;
  chapterId: string;
  sceneNumber: number;
  outline?: string | null;
  summary?: string | null;
  prose?: string | null;
  wordCount: number;
  hasProse?: boolean;
  sourceBookRevisionId?: string;
  sourceSceneRevisionId?: string;
  contentHash?: string;
  projection?: 'final';
}

export interface ChapterRecord {
  id: string;
  actId: string;
  chapterNumber: number;
  title?: string | null;
  summary?: string | null;
  scenes: SceneRecord[];
}

export interface ActRecord {
  id: string;
  bookId: string;
  actNumber: number;
  title?: string | null;
  summary?: string | null;
  chapters: ChapterRecord[];
}

export interface CodexEntry {
  id: string;
  bookId: string;
  entryType: string;
  entryName: string;
  entryDescription: string | null;
  attributes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProseTraceCandidate {
  ordinal: number;
  stage: string;
  candidateType: string;
  selectionLabel?: string | null;
  accepted?: boolean | null;
  rejected?: boolean | null;
  outputText: string;
  wordCount: number;
  overallScore?: number | null;
  tier?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProseFinding {
  id: number;
  source: string;
  findingType: string;
  severity: string;
  title?: string | null;
  message: string;
  excerpt?: string | null;
  suggestion?: string | null;
  rationale?: string | null;
  fromOffset?: number | null;
  toOffset?: number | null;
  metadata?: Record<string, unknown>;
  dismissedAt?: string | null;
}

export interface ProseCompareCard {
  id: number;
  findingId?: number | null;
  title: string;
  message: string;
  excerpt?: string | null;
  optionALabel: string;
  optionAText: string;
  optionBLabel: string;
  optionBText: string;
  recommendedOption?: 'a' | 'b' | null;
  rationale?: string | null;
  fromOffset?: number | null;
  toOffset?: number | null;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface ProseAction {
  id: number;
  actionType: string;
  findingId?: number | null;
  compareCardId?: number | null;
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
}

export interface ProseTrace {
  traceId: string;
  status: string;
  judgeStatus?: string | null;
  recipeVersion?: string | null;
  genreKey?: string | null;
  adapterUsed?: string | null;
  modelUsed?: string | null;
  promptText?: string | null;
  brief?: string | null;
  judgeSummary?: Record<string, unknown> | null;
  validatorResults?: Array<Record<string, unknown>>;
  errorMessage?: string | null;
  candidates: ProseTraceCandidate[];
  inlineFindings: ProseFinding[];
  compareCards: ProseCompareCard[];
  actions: ProseAction[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ProseGenerationResult {
  prose: string;
  wordCount: number;
  model?: string;
  traceId?: string;
  genreKey?: string | null;
  recipeVersion?: string | null;
  judgeStatus?: string | null;
  adapterUsed?: string | null;
  validatorResults?: Array<Record<string, unknown>>;
  revisionApplied?: boolean;
}

export interface ProseBatchItem {
  sceneId?: string;
  prompt?: string;
  instructions?: string;
  targetWords?: number;
  pov?: string;
  tense?: string;
  mustInclude?: string[];
  mustAvoid?: string[];
  qualityMode?: 'standard' | 'strict';
}

export interface ProseBatchResult {
  results: Array<{
    index: number;
    ok?: boolean;
    success?: boolean;
    data?: ProseGenerationResult;
    error?: string | { message?: string; code?: string };
  }>;
  summary?: Record<string, unknown>;
}

export interface CommandReviseResult {
  revised: string;
  scope: 'scene' | 'paragraph';
  model?: string;
}

function normalizeScene(scene: Record<string, unknown>): SceneRecord {
  return {
    id: stringId(scene.id),
    chapterId: stringId(scene.chapterId),
    sceneNumber: Number(scene.sceneNumber ?? 0),
    outline: typeof scene.outline === 'string' ? scene.outline : null,
    summary: typeof scene.summary === 'string' ? scene.summary : null,
    prose: typeof scene.prose === 'string' ? scene.prose : null,
    wordCount: Number(scene.wordCount ?? 0),
    hasProse: typeof scene.hasProse === 'boolean' ? scene.hasProse : undefined,
    sourceBookRevisionId:
      typeof scene.sourceBookRevisionId === 'string' ? scene.sourceBookRevisionId : undefined,
    sourceSceneRevisionId:
      typeof scene.sourceSceneRevisionId === 'string' ? scene.sourceSceneRevisionId : undefined,
    contentHash: typeof scene.contentHash === 'string' ? scene.contentHash : undefined,
    projection: scene.projection === 'final' ? 'final' : undefined,
  };
}

function normalizeChapter(chapter: Record<string, unknown>): ChapterRecord {
  return {
    id: stringId(chapter.id),
    actId: stringId(chapter.actId),
    chapterNumber: Number(chapter.chapterNumber ?? 0),
    title: typeof chapter.title === 'string' ? chapter.title : null,
    summary: typeof chapter.summary === 'string' ? chapter.summary : null,
    scenes: Array.isArray(chapter.scenes)
      ? chapter.scenes.map((scene) => normalizeScene(scene as Record<string, unknown>))
      : [],
  };
}

function normalizeAct(act: Record<string, unknown>): ActRecord {
  return {
    id: stringId(act.id),
    bookId: stringId(act.bookId),
    actNumber: Number(act.actNumber ?? 0),
    title: typeof act.title === 'string' ? act.title : null,
    summary: typeof act.summary === 'string' ? act.summary : null,
    chapters: Array.isArray(act.chapters)
      ? act.chapters.map((chapter) => normalizeChapter(chapter as Record<string, unknown>))
      : [],
  };
}

/* ── Books ─────────────────────────────────────────── */

export async function listBooks(expectedUserId?: string): Promise<{ data: Book[] }> {
  const data = await requestFactory<
    Array<Record<string, unknown>> | { books?: Array<Record<string, unknown>> }
  >(
    '/api/books',
    expectedUserId
      ? { headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) } }
      : undefined,
  );
  const books = Array.isArray(data) ? data : Array.isArray(data?.books) ? data.books : [];
  return {
    data: books.map((book) => ({
      id: stringId(book.id),
      title: typeof book.title === 'string' && book.title.trim() ? book.title : 'Untitled Book',
      genre: typeof book.genre === 'string' ? book.genre : undefined,
      archetype: typeof book.archetype === 'string' ? book.archetype : undefined,
      draftStatus: typeof book.draftStatus === 'string' ? book.draftStatus : 'draft',
      wordCount: typeof book.wordCount === 'number' ? book.wordCount : 0,
      summary: typeof book.summary === 'string' ? book.summary : null,
      updatedAt: typeof book.updatedAt === 'string' ? book.updatedAt : undefined,
    })),
  };
}

export async function createBook(
  input: {
    operationId: string;
    title?: string;
    genre?: string;
    archetype?: string;
    targetAudience?: string;
    summary?: string;
  },
  expectedUserId: string,
): Promise<{ data: Book }> {
  const data = await requestFactory<Record<string, unknown>>('/api/books', {
    method: 'POST',
    body: JSON.stringify(input),
    ...(expectedUserId
      ? { headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) } }
      : {}),
  });

  return {
    data: {
      id: stringId(data.id),
      title: typeof data.title === 'string' && data.title.trim() ? data.title : 'Untitled Book',
      genre: typeof data.genre === 'string' ? data.genre : undefined,
      archetype: typeof data.archetype === 'string' ? data.archetype : undefined,
      draftStatus: typeof data.draftStatus === 'string' ? data.draftStatus : 'draft',
      wordCount: typeof data.wordCount === 'number' ? data.wordCount : 0,
      summary: typeof data.summary === 'string' ? data.summary : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    },
  };
}

export async function updateBook(
  bookId: string,
  input: {
    title?: string;
    genre?: string;
    archetype?: string;
    targetAudience?: string;
    writingStyle?: string;
    summary?: string;
    tagline?: string;
    draftStatus?: string;
  },
  documentPreconditions: DocumentMutationPreconditions,
  expectedUserId: string,
): Promise<{ data: Book }> {
  const data = await requestFactory<Record<string, unknown>>(
    `/api/books/${encodeURIComponent(bookId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        ...input,
        ...(input.archetype !== undefined ? { storyArchetypeKey: input.archetype } : {}),
        documentPreconditions,
      }),
      headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) },
    },
  );
  return {
    data: {
      id: stringId(data.id),
      title: typeof data.title === 'string' && data.title.trim() ? data.title : 'Untitled Book',
      genre: typeof data.genre === 'string' ? data.genre : undefined,
      archetype: typeof data.archetype === 'string' ? data.archetype : undefined,
      draftStatus: typeof data.draftStatus === 'string' ? data.draftStatus : 'draft',
      wordCount: typeof data.wordCount === 'number' ? data.wordCount : 0,
      summary: typeof data.summary === 'string' ? data.summary : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    },
  };
}

export async function deleteBook(
  bookId: string,
  documentPreconditions: DocumentMutationPreconditions,
  expectedUserId: string,
): Promise<void> {
  await requestFactory<{ deleted: boolean }>(`/api/books/${encodeURIComponent(bookId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ documentPreconditions }),
    headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) },
  });
}

export async function getStructure(
  bookId: string,
  options?: { includeProse?: boolean },
): Promise<{ data: { acts: ActRecord[] } }> {
  const data = await requestFactory<{ acts: Array<Record<string, unknown>> }>(
    `/api/books/${encodeURIComponent(bookId)}/structure${options?.includeProse ? '?includeProse=1' : ''}`,
  );
  return { data: { acts: (data.acts ?? []).map(normalizeAct) } };
}

export async function saveStructure(
  bookId: string,
  input: {
    acts: Array<{
      title?: string;
      summary?: string;
      chapters: Array<{ title?: string; summary?: string }>;
    }>;
  },
): Promise<{ data: { acts: ActRecord[] } }> {
  const data = await requestFactory<{ acts: Array<Record<string, unknown>> }>(
    `/api/books/${encodeURIComponent(bookId)}/structure`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return { data: { acts: (data.acts ?? []).map(normalizeAct) } };
}

export async function createAct(
  bookId: string,
  input: {
    title?: string;
    summary?: string;
  },
): Promise<{ data: { act: ActRecord } }> {
  const data = await requestFactory<{ act: Record<string, unknown> }>(
    `/api/books/${encodeURIComponent(bookId)}/acts`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return { data: { act: normalizeAct(data.act) } };
}

export async function createChapter(
  bookId: string,
  actId: string,
  input: {
    title?: string;
    summary?: string;
  },
): Promise<{ data: { chapter: ChapterRecord } }> {
  const data = await requestFactory<{ chapter: Record<string, unknown> }>(
    `/api/books/${encodeURIComponent(bookId)}/acts/${encodeURIComponent(actId)}/chapters`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return { data: { chapter: normalizeChapter(data.chapter) } };
}

/* ── Scenes / Prose ───────────────────────────────── */

export async function createScene(
  bookId: string,
  chapterId: string,
  input: {
    outline?: string;
    summary?: string;
    prose?: string;
  },
): Promise<{ data: { scene: SceneRecord } }> {
  const data = await requestFactory<{ scene: Record<string, unknown> }>(
    `/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}/scenes`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return { data: { scene: normalizeScene(data.scene) } };
}

export async function updateScene(
  bookId: string,
  sceneId: string,
  input: {
    outline?: string;
    summary?: string;
    prose?: string;
  },
): Promise<{ data: { scene: SceneRecord } }> {
  const data = await requestFactory<{ scene: Record<string, unknown> }>(
    `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
  return { data: { scene: normalizeScene(data.scene) } };
}

export async function generateProse(input: {
  bookId: string;
  sceneId?: string;
  prompt?: string;
  instructions?: string;
  targetWords?: number;
  pov?: string;
  tense?: string;
  genre?: string;
}): Promise<{ data: ProseGenerationResult }> {
  const data = await requestFactory<ProseGenerationResult>('/api/generate/prose', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return { data };
}

export async function generateProseBatch(input: {
  bookId: string;
  items: ProseBatchItem[];
  maxConcurrency?: number;
  continueOnError?: boolean;
  saveToScene?: boolean;
  useCodexRAG?: boolean;
  codexTypes?: string;
  codexK?: number;
  tokenBudget?: number;
  selectedModel?: string;
}): Promise<{ data: ProseBatchResult }> {
  const data = await requestFactory<ProseBatchResult>('/api/generate/prose/batch', {
    method: 'POST',
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(20 * 60_000),
  });
  return { data };
}

export async function commandReviseProse(input: {
  bookId: string;
  sceneId?: string;
  originalText: string;
  instruction: string;
  scope: 'scene' | 'paragraph';
  sceneOutline?: string;
}): Promise<{ data: CommandReviseResult }> {
  const data = await requestFactory<CommandReviseResult>('/api/generate/prose/command-revise', {
    method: 'POST',
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5 * 60_000), // 5 minutes for slow GPUs
  });
  return { data };
}

export async function getTrace(traceId: string): Promise<{ data: ProseTrace }> {
  const data = await requestFactory<ProseTrace>(`/api/prose/traces/${encodeURIComponent(traceId)}`);
  return { data };
}

export async function getLatestSceneTrace(
  bookId: string,
  sceneId: string,
): Promise<{ data: ProseTrace | null }> {
  const data = await requestFactory<ProseTrace | null>(
    `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}/prose/traces/latest`,
  );
  return { data };
}

export async function submitScenePreference(
  bookId: string,
  sceneId: string,
  input: {
    traceId: string;
    compareCardId: number;
    chosen: 'a' | 'b';
    applyChosen: boolean;
    rationale?: string;
  },
): Promise<{ data: ProseTrace }> {
  const data = await requestFactory<ProseTrace>(
    `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}/prose/preferences`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return { data };
}

/* ── Codex (Story Bible) ──────────────────────────── */

export interface CodexListResponse {
  data: CodexEntry[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export async function listCodexEntries(
  bookId: string,
  params?: { page?: number; limit?: number; entryType?: string; search?: string },
): Promise<CodexListResponse> {
  const sp = new URLSearchParams();
  if (params?.page) sp.set('page', String(params.page));
  if (params?.limit) sp.set('pageSize', String(params.limit));
  const qs = sp.toString();
  const data = await requestFactory<{
    entries: Array<Record<string, unknown>>;
    pagination?: { page?: number; pageSize?: number; total?: number; totalPages?: number };
  }>(`/api/books/${encodeURIComponent(bookId)}/codex${qs ? `?${qs}` : ''}`);

  const entries = (data.entries ?? []).map((entry) => ({
    id: stringId(entry.id),
    bookId: stringId(entry.bookId),
    entryType: String(entry.entryType ?? ''),
    entryName: String(entry.entryName ?? ''),
    entryDescription: typeof entry.entryDescription === 'string' ? entry.entryDescription : null,
    attributes: typeof entry.attributes === 'string' ? entry.attributes : null,
    createdAt: String(entry.createdAt ?? ''),
    updatedAt: String(entry.updatedAt ?? ''),
  }));

  return {
    data: entries,
    pagination: {
      page: Number(data.pagination?.page ?? 1),
      limit: Number(data.pagination?.pageSize ?? params?.limit ?? 50),
      total: Number(data.pagination?.total ?? entries.length),
      pages: Number(data.pagination?.totalPages ?? 1),
    },
  };
}

export async function getCodexEntry(_bookId: string, id: string): Promise<{ data: CodexEntry }> {
  const entry = await requestFactory<Record<string, unknown>>(
    `/api/codex/${encodeURIComponent(id)}`,
  );
  return {
    data: {
      id: stringId(entry.id),
      bookId: stringId(entry.bookId),
      entryType: String(entry.entryType ?? ''),
      entryName: String(entry.entryName ?? ''),
      entryDescription: typeof entry.entryDescription === 'string' ? entry.entryDescription : null,
      attributes: typeof entry.attributes === 'string' ? entry.attributes : null,
      createdAt: String(entry.createdAt ?? ''),
      updatedAt: String(entry.updatedAt ?? ''),
    },
  };
}

export interface CreateCodexInput {
  entryType: string;
  entryName: string;
  entryDescription?: string;
  attributes?: string;
}

export async function createCodexEntry(
  bookId: string,
  data: CreateCodexInput,
): Promise<{ data: CodexEntry }> {
  const entry = await requestFactory<Record<string, unknown>>(
    `/api/books/${encodeURIComponent(bookId)}/codex`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
  return {
    data: {
      id: stringId(entry.id),
      bookId: stringId(entry.bookId),
      entryType: String(entry.entryType ?? ''),
      entryName: String(entry.entryName ?? ''),
      entryDescription: typeof entry.entryDescription === 'string' ? entry.entryDescription : null,
      attributes: typeof entry.attributes === 'string' ? entry.attributes : null,
      createdAt: String(entry.createdAt ?? ''),
      updatedAt: String(entry.updatedAt ?? ''),
    },
  };
}

export interface UpdateCodexInput {
  entryType?: string;
  entryName?: string;
  entryDescription?: string;
  attributes?: string;
}

export async function updateCodexEntry(
  _bookId: string,
  id: string,
  data: UpdateCodexInput,
): Promise<{ data: CodexEntry }> {
  const entry = await requestFactory<Record<string, unknown>>(
    `/api/codex/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  );
  return {
    data: {
      id: stringId(entry.id),
      bookId: stringId(entry.bookId),
      entryType: String(entry.entryType ?? ''),
      entryName: String(entry.entryName ?? ''),
      entryDescription: typeof entry.entryDescription === 'string' ? entry.entryDescription : null,
      attributes: typeof entry.attributes === 'string' ? entry.attributes : null,
      createdAt: String(entry.createdAt ?? ''),
      updatedAt: String(entry.updatedAt ?? ''),
    },
  };
}

export async function deleteCodexEntry(_bookId: string, id: string): Promise<void> {
  await requestFactory<{ message: string }>(`/api/codex/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/* ── Export ─────────────────────────────────────────── */

export async function exportBook(
  bookId: string,
  input: {
    format: string;
    includeCodex?: boolean;
    includeMetadata?: boolean;
    includeSynopsis?: boolean;
    includeSummaries?: boolean;
  },
): Promise<Blob> {
  const params = new URLSearchParams({
    format: input.format,
    includeCodex: String(Boolean(input.includeCodex)),
    includeMetadata: String(Boolean(input.includeMetadata)),
    includeSummaries: String(Boolean(input.includeSummaries)),
    download: 'true',
  });
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/export?${params.toString()}`, {
    method: 'GET',
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  return res.blob();
}

export async function generateBookSummary(
  bookId: string,
  prompt?: string,
  selectedModel?: string,
): Promise<{ data: string }> {
  const data = await requestFactory<string>('/api/generate/summary', {
    method: 'POST',
    body: JSON.stringify({ bookId: Number(bookId), prompt, selectedModel }),
  });
  return { data };
}

/* ── Plot ──────────────────────────────────────────── */

export type PlotThread = import('@hivemagnus/proser-contracts').PlotThreadSummary;

export async function getPlotThreads(bookId: string): Promise<{ data: PlotThread[] }> {
  const result = await requestFactory<{ threads: PlotThread[] }>(
    `/api/books/${encodeURIComponent(bookId)}/plot-threads`,
  );
  return { data: result.threads };
}

// ─── Image API ─────────────────────────────────────────

export interface ImageAssetRecord {
  id: string;
  sha256?: string;
  width?: number;
  height?: number;
  url: string;
  prompt: string | null;
  entityType: string | null;
  entityId: string | null;
  bookId: string | null;
  createdAt: string;
}

function protectedImageUrl(id: string | number, fallback: string) {
  const normalizedId = String(id ?? '').trim();
  if (normalizedId) {
    return `/api/images/${encodeURIComponent(normalizedId)}/content`;
  }
  return fallback.startsWith('/api/') ? fallback : '';
}

export async function listImages(params: {
  bookId?: string;
  entityType?: string;
  entityId?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: ImageAssetRecord[]; total: number }> {
  const query = new URLSearchParams();
  if (params.bookId) query.set('bookId', params.bookId);
  if (params.entityType) query.set('entityType', params.entityType);
  if (params.entityId) query.set('entityId', params.entityId);
  query.set('page', String(params.page ?? 1));
  query.set('pageSize', String(params.limit ?? 50));
  const result = await requestFactory<{ items: ImageAssetRecord[]; total: number }>(
    `/api/images/list?${query.toString()}`,
  );
  return {
    ...result,
    items: result.items.map((item) => ({
      ...item,
      id: stringId(item.id),
      bookId: item.bookId == null ? null : stringId(item.bookId),
      entityId: item.entityId == null ? null : stringId(item.entityId),
      url: protectedImageUrl(item.id, item.url),
    })),
  };
}

export async function uploadImageFile(
  file: File,
  opts?: { bookId?: string; entityType?: string; entityId?: string },
): Promise<{ id: string; url: string }> {
  const form = new FormData();
  form.append('file', file);
  if (opts?.bookId) form.append('bookId', opts.bookId);
  if (opts?.entityType) form.append('entityType', opts.entityType);
  if (opts?.entityId) form.append('entityId', opts.entityId);

  const res = await fetch('/api/images/upload', { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Upload failed');
    throw new FactoryRequestError(res.status, text);
  }
  const json = (await res.json()) as FactoryEnvelope<{ id: string; url: string }>;
  return {
    ...json.data,
    url: protectedImageUrl(json.data.id, json.data.url),
  };
}

export async function generateImage(params: {
  prompt: string;
  bookId?: string;
  entityType?: string;
  entityId?: string;
  width?: number;
  height?: number;
}): Promise<{ urls: string[]; assets: Array<{ id: string; url: string; prompt: string }> }> {
  const result = await requestFactory<{
    urls: string[];
    assets: Array<{ id: string; url: string; prompt: string }>;
  }>('/api/images/generate', {
    method: 'POST',
    body: JSON.stringify({
      prompt: params.prompt,
      provider: 'forge',
      bookId: params.bookId,
      entityType: params.entityType,
      entityId: params.entityId,
      width: params.width ?? 768,
      height: params.height ?? 512,
    }),
  });
  const assets = (result.assets ?? []).map((asset) => ({
    ...asset,
    url: protectedImageUrl(asset.id, asset.url),
  }));
  return { ...result, assets, urls: assets.map((asset) => asset.url) };
}

export async function generateFluxImage(params: {
  prompt: string;
  n?: number;
  bookId?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  cfgScale?: number;
  distilledCfgScale?: number;
  samplerName?: string;
  scheduler?: string;
  model?: string;
  responseFormat?: 'url' | 'b64_json';
}): Promise<{ urls: string[]; assets?: Array<{ id: string; url: string; prompt: string }> }> {
  const result = await requestFactory<{
    urls: string[];
    assets?: Array<{ id: string; url: string; prompt: string }>;
  }>('/api/images/generate/flux', {
    method: 'POST',
    body: JSON.stringify({
      prompt: params.prompt,
      n: params.n,
      bookId: params.bookId,
      width: params.width ?? 1024,
      height: params.height ?? 1024,
      steps: params.steps,
      seed: params.seed,
      cfg_scale: params.cfgScale,
      distilled_cfg_scale: params.distilledCfgScale,
      sampler_name: params.samplerName,
      scheduler: params.scheduler,
      model: params.model,
      response_format: params.responseFormat,
    }),
  });
  const assets = result.assets?.map((asset) => ({
    ...asset,
    url: protectedImageUrl(asset.id, asset.url),
  }));
  return { ...result, assets, urls: assets?.map((asset) => asset.url) ?? [] };
}

export async function suggestImagePrompt(
  bookId: string,
  targetType: string,
  info?: Record<string, unknown>,
): Promise<{ prompt: string }> {
  return requestFactory<{ prompt: string }>('/api/images/suggest-prompt', {
    method: 'POST',
    body: JSON.stringify({ bookId, targetType, info }),
  });
}

export async function deleteImage(id: string): Promise<void> {
  await requestFactory<{ deleted: boolean }>(`/api/images/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export type WorkflowType =
  | 'full_book'
  | 'quality_review'
  | 'improve_quality'
  | 'guided_improve'
  | 'editorial_optimize'
  | 'revision_campaign_analysis';
export interface WorkflowStatus {
  runId: string;
  workflowType: WorkflowType;
  parentRunId?: string | null;
  bookId: number;
  status: string;
  /** Factory-authoritative terminal state. Optional only for rolling-deploy compatibility. */
  terminal?: boolean;
  /** Monotonic Factory-managed revision for rejecting stale status responses. */
  statusVersion?: number;
  phase: string;
  progress?: { completed?: number; total?: number; percent?: number };
  sourceRevisionId?: string | null;
  resultRevisionId?: string | null;
  lastHeartbeatAt?: string | null;
  failureReason?: string | null;
  manuscript: { scenes: number; words: number };
  activeCheckpoint?: {
    id: string;
    checkpointType: string;
    summary: string;
    artifactRefs: string[];
  } | null;
  resourceVersions?: {
    checkpoints: string;
    artifacts: string;
    publication: string;
    editorial?: string;
  };
  children: Array<{
    id: string;
    workflowType: WorkflowType;
    status: string;
    phase: string;
    progress?: unknown;
  }>;
  findings?: {
    total: number;
    open: number;
    implemented: number;
    verified: number;
    waived: number;
    stale: number;
    superseded: number;
  } | null;
  editorial?: {
    id: string;
    passPack: { key: EditorialPassKey; version: string };
    policyVersion: string;
    autonomy: EditorialAutonomy;
    outcome?: EditorialOutcome | null;
    summary?: EditorialRunSummary | null;
  } | null;
}

export interface WorkflowCheckpointSummary {
  id: string;
  checkpointType: string;
  status: string;
  decision?: string | null;
  reason?: string | null;
  createdAt: string;
  decidedAt?: string | null;
}

export interface WorkflowArtifactSummary {
  id: string;
  artifactType: string;
  scopeType?: string | null;
  scopeId?: string | null;
  sourceRevisionId?: string | null;
  resultRevisionId?: string | null;
  createdAt: string;
}

export interface WorkflowPublicationSummary {
  status: string;
  gateReport?: {
    pass?: boolean;
    revisionId?: string;
    gates?: Array<{ gate: string; pass: boolean; evidence?: unknown }>;
  } | null;
  artifactManifest?: {
    revisionId?: string;
    artifacts?: Array<{ filename: string; mediaType?: string; sha256?: string; bytes?: number }>;
  } | null;
  validationReport?: { pass?: boolean; checks?: unknown } | null;
}

export interface QualityReviewSummary {
  id: string;
  workflowRunId: string;
  sourceRevisionId: string;
  modelUsed: string;
  rubricVersion: string;
  scopeType: string;
  status: string;
  score?: number | null;
  stale: boolean;
  coverage: Record<string, number>;
  aggregates: {
    total: number;
    open: number;
    implemented: number;
    verified: number;
    waived: number;
    stale: number;
    superseded: number;
  };
  createdAt: string;
}

export interface QualityFindingSummary {
  id: string;
  reviewRunId: string;
  scopeType: string;
  scopeId?: number | null;
  category: string;
  severity: string;
  confidence: number;
  message: string;
  evidence?: string | null;
  recommendation?: string | null;
  implemented: boolean;
  verificationStatus: string;
  verificationEvidence?: string | null;
  waived: boolean;
  stale: boolean;
  superseded: boolean;
  reviewStale: boolean;
  activeOnCurrentRevision: boolean;
}

export interface BookFindingSummary extends QualityFindingSummary {
  model: string;
  review: {
    id: string;
    workflowRunId: string;
    sourceRevisionId: string;
    modelUsed: string;
    rubricVersion: string;
    status: string;
    createdAt: string;
  };
}

export interface WorkflowCheckpointDetailPage {
  id: string;
  checkpointType: string;
  proposalChunk: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
}

export interface ManuscriptRevisionSummary {
  id: string;
  parentRevisionId?: string | null;
  workflowRunId?: string | null;
  contentHash: string;
  wordCount: number;
  changedScopes: unknown;
  createdAt: string;
}

export interface InferenceModelSummary {
  id: string;
  name?: string;
}

export function listInferenceModels() {
  return requestFactory<InferenceModelSummary[]>('/api/models');
}

export function startFullBook(
  input: {
    premise: string;
    title?: string;
    genre?: string;
    audience?: string;
    targetWords?: number;
    reviewModels?: string[];
  },
  idempotencyKey: string,
) {
  return requestFactory<WorkflowStatus>('/api/workflows/full-book', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function startQualityReview(
  input: {
    bookId: number;
    model: string;
    rubricVersion?: string;
    scope?: { type: 'book' | 'act' | 'chapter' | 'scene'; id?: number };
  },
  idempotencyKey: string,
) {
  return requestFactory<WorkflowStatus>('/api/workflows/quality-review', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ scope: { type: 'book' }, rubricVersion: 'publishable-v1', ...input }),
  });
}

export function startImproveQuality(
  input: {
    bookId: number;
    reviewRunIds: string[];
    findingIds?: string[];
    model?: string;
  },
  idempotencyKey: string,
) {
  return requestFactory<WorkflowStatus>('/api/workflows/improve-quality', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function startGuidedImprove(
  input: {
    bookId: number;
    instruction: string;
    model?: string;
    scope?: { type: 'book' | 'act' | 'chapter' | 'scene'; id?: number };
    acceptanceCriteria?: string[];
  },
  idempotencyKey: string,
) {
  return requestFactory<WorkflowStatus>('/api/workflows/guided-improve', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function getWorkflow(runId: string, signal?: AbortSignal) {
  return requestFactory<WorkflowStatus>(`/api/workflows/${encodeURIComponent(runId)}`, { signal });
}
export function listBookWorkflows(bookId: string, signal?: AbortSignal) {
  return requestFactory<WorkflowStatus[]>(`/api/books/${encodeURIComponent(bookId)}/workflows`, {
    signal,
  });
}
export function listWorkflowCheckpoints(runId: string, signal?: AbortSignal) {
  return requestFactory<WorkflowCheckpointSummary[]>(
    `/api/workflows/${encodeURIComponent(runId)}/checkpoints`,
    { signal },
  );
}
export function getWorkflowCheckpointDetail(
  runId: string,
  checkpointId: string,
  offset = 0,
  signal?: AbortSignal,
) {
  return requestFactory<WorkflowCheckpointDetailPage>(
    `/api/workflows/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}?offset=${offset}`,
    { signal },
  );
}
export function listWorkflowArtifacts(runId: string, signal?: AbortSignal) {
  return requestFactory<WorkflowArtifactSummary[]>(
    `/api/workflows/${encodeURIComponent(runId)}/artifacts`,
    { signal },
  );
}
export function getWorkflowPublication(runId: string, signal?: AbortSignal) {
  return requestFactory<WorkflowPublicationSummary>(
    `/api/workflows/${encodeURIComponent(runId)}/publication`,
    { signal },
  );
}
export function controlWorkflow(runId: string, action: 'pause' | 'resume' | 'cancel') {
  return requestFactory<WorkflowStatus>(`/api/workflows/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    body: '{}',
  });
}
export function decideWorkflowCheckpoint(
  runId: string,
  checkpointId: string,
  decision: 'approved' | 'rejected',
  reason?: string,
) {
  return requestFactory<WorkflowStatus>(
    `/api/workflows/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/decision`,
    { method: 'POST', body: JSON.stringify({ decision, reason }) },
  );
}
export function listBookReviews(bookId: string, signal?: AbortSignal) {
  return requestFactory<QualityReviewSummary[]>(
    `/api/books/${encodeURIComponent(bookId)}/reviews`,
    { signal },
  );
}
export function listReviewFindings(reviewRunId: string) {
  return requestFactory<QualityFindingSummary[]>(
    `/api/reviews/${encodeURIComponent(reviewRunId)}/findings`,
  );
}
export function waiveQualityFinding(findingId: string, waived: boolean, waiverReason?: string) {
  return requestFactory<QualityFindingSummary>(`/api/findings/${encodeURIComponent(findingId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ waived, waiverReason }),
  });
}
export function listBookFindings(
  bookId: string,
  filters: {
    state?: string;
    model?: string;
    severity?: string;
    scope?: string;
    cursor?: string;
    limit?: number;
  } = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== 'all') params.set(key, String(value));
  });
  return requestFactory<{
    items: Array<Omit<BookFindingSummary, 'model'>>;
    nextCursor: string | null;
    limit: number;
  }>(`/api/books/${encodeURIComponent(bookId)}/findings?${params}`, { signal }).then((page) => ({
    ...page,
    items: page.items.map((item) => ({ ...item, model: item.review.modelUsed })),
  }));
}
export function listBookRevisions(bookId: string, signal?: AbortSignal) {
  return requestFactory<ManuscriptRevisionSummary[]>(
    `/api/books/${encodeURIComponent(bookId)}/revisions`,
    { signal },
  );
}
export function rollbackBookRevision(bookId: string, revisionId: string) {
  return requestFactory<{ bookId: number; restoredRevisionId: string; resultRevisionId: string }>(
    `/api/books/${encodeURIComponent(bookId)}/revisions/${encodeURIComponent(revisionId)}/rollback`,
    { method: 'POST', body: '{}' },
  );
}

export type EditorialPassKey =
  | 'line_edit_safe'
  | 'dialogue'
  | 'voice_preservation'
  | 'scene_energy'
  | 'continuity'
  | 'name_originality'
  | 'final_polish'
  | 'custom';
export type EditorialAutonomy = 'review_only' | 'propose_only' | 'safe_auto' | 'max_quality_auto';
export type EditorialOutcome =
  | 'completed_with_changes'
  | 'completed_no_changes'
  | 'completed_with_skips'
  | 'completed_review_only'
  | 'completed_proposals_only'
  | 'superseded_by_new_revision';

export interface EditorialPassPack {
  key: EditorialPassKey;
  version: string;
  displayName: string;
  description: string;
  supportedScopes: Array<'book' | 'act' | 'chapter' | 'scene'>;
  defaultAutonomy: EditorialAutonomy;
  allowedRisk: Array<'low' | 'medium'>;
  mayChange: string[];
  mustPreserve: string[];
  defaultBudget: {
    maxChangedWordsPercentPerScene: number;
    maxChangedWordsPercentTotal: number;
    maxProposals: number;
    maxCandidatesPerProposal: number;
    maxInferenceTokens: number;
    maxJudgeEscalations: number;
  };
}

export interface EditorialRunSummary {
  runId: string;
  status: 'completed';
  outcome: EditorialOutcome;
  bookId: number;
  scope: { type: 'book' | 'act' | 'chapter' | 'scene'; id?: number };
  sourceRevisionId: string;
  resultRevisionId: string | null;
  passPack: { key: EditorialPassKey; version: string };
  policyVersion: string;
  profile: { id: string | null; version: string; hash: string };
  counts: {
    scopesReviewed: number;
    findingsCreated: number;
    proposalsGenerated: number;
    proposalsApplied: number;
    originalWins: number;
    noClearWinner: number;
    skipped: number;
    verificationPassed: number;
    verificationFailed: number;
  };
  change: { changedWords: number; changedWordsPercent: number };
  quality: {
    hardInvariantsPassed: boolean;
    judgeAgreementRate: number;
    styleDriftWithinProfile: boolean;
  };
  unresolved: { count: number; topCategories: string[] };
}

export interface EditorialProposalSummary {
  id: string;
  scopeType: string;
  scopeId?: number | null;
  passKey: EditorialPassKey;
  passVersion: string;
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  status: string;
  skipReason?: string | null;
  originalText: string;
  verificationStatus: string;
  stale?: boolean;
  canUndo?: boolean;
  candidates?: Array<{
    id: string;
    candidateType: 'original' | 'generated';
    outputText: string;
    wordCount: number;
  }>;
}

export interface EditorialProfile {
  id: string;
  name: string;
  version: string;
  bookId?: number | null;
  active: boolean;
  configHash: string;
  config: Record<string, unknown>;
}

export interface EditorialBenchmark {
  id: string;
  suiteKey: string;
  suiteVersion: string;
  status: string;
  metrics?: Record<string, number> | null;
  reportHash?: string | null;
  report?: {
    release?: {
      deterministic: boolean;
      blocking: Record<string, boolean>;
      warnings: string[];
    };
    metrics?: Record<string, number>;
  } | null;
  createdAt?: string;
  finishedAt?: string | null;
}

export function listEditorialPasses() {
  return requestFactory<EditorialPassPack[]>('/api/editorial/pass-packs');
}

export function startEditorialOptimize(
  input: {
    bookId: number;
    scope: { type: 'book' | 'act' | 'chapter' | 'scene'; id?: number };
    objective?: string;
    passPack: EditorialPassKey;
    autonomy: EditorialAutonomy;
    profileId?: string;
    protectedElements?: string[];
    changeBudget?: Partial<EditorialPassPack['defaultBudget']>;
  },
  idempotencyKey: string,
) {
  return requestFactory<WorkflowStatus & { statusUrl: string }>(
    '/api/workflows/editorial-optimize',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export function listBookEditorialRuns(bookId: string) {
  return requestFactory<
    Array<{
      id: string;
      workflowRunId: string;
      passPackKey: EditorialPassKey;
      passPackVersion: string;
      autonomy: EditorialAutonomy;
      scopeType: string;
      scopeId?: number | null;
      status: string;
      outcome?: EditorialOutcome | null;
      sourceRevisionId: string;
      resultRevisionId?: string | null;
      evidenceSummary?: EditorialRunSummary | null;
      createdAt: string;
      finishedAt?: string | null;
    }>
  >(`/api/books/${encodeURIComponent(bookId)}/editorial-runs`);
}

export function getEditorialRun(runId: string) {
  return requestFactory<{
    workflowRunId: string;
    status: string;
    outcome?: EditorialOutcome | null;
    evidenceSummary?: EditorialRunSummary | null;
    workflowRun: Pick<
      WorkflowStatus,
      'status' | 'phase' | 'progress' | 'lastHeartbeatAt' | 'failureReason'
    >;
  }>(`/api/editorial/runs/${encodeURIComponent(runId)}`);
}

export function getEditorialSummary(runId: string) {
  return requestFactory<EditorialRunSummary>(
    `/api/editorial/runs/${encodeURIComponent(runId)}/summary`,
  );
}

export function listEditorialProposals(runId: string, cursor?: string) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestFactory<{ items: EditorialProposalSummary[]; nextCursor: string | null }>(
    `/api/editorial/runs/${encodeURIComponent(runId)}/proposals${query}`,
  );
}

export function getEditorialProposal(runId: string, proposalId: string) {
  return requestFactory<EditorialProposalSummary>(
    `/api/editorial/runs/${encodeURIComponent(runId)}/proposals/${encodeURIComponent(proposalId)}`,
  );
}

export function applyEditorialProposal(proposalId: string, candidateId: string) {
  return requestFactory<{ proposalId: string; resultRevisionId: string; applied: boolean }>(
    `/api/editorial/proposals/${encodeURIComponent(proposalId)}/apply`,
    { method: 'POST', body: JSON.stringify({ candidateId }) },
  );
}

export function undoEditorialProposal(proposalId: string) {
  return requestFactory<{ proposalId: string; resultRevisionId: string; undone: boolean }>(
    `/api/editorial/proposals/${encodeURIComponent(proposalId)}/undo`,
    { method: 'POST', body: '{}' },
  );
}

export function recordEditorialPreference(
  proposalId: string,
  input: {
    evidenceType:
      | 'choose_candidate'
      | 'choose_original'
      | 'reject_all'
      | 'undo_auto_edit'
      | 'manual_rewrite'
      | 'dismiss_finding'
      | 'explicit_profile_rule';
    candidateId?: string;
    rationaleTags?: string[];
  },
) {
  return requestFactory(`/api/editorial/proposals/${encodeURIComponent(proposalId)}/preference`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listEditorialProfiles() {
  return requestFactory<EditorialProfile[]>('/api/editorial/profiles');
}

export function createEditorialProfile(input: {
  name: string;
  bookId?: number;
  active?: boolean;
  config: Record<string, unknown>;
}) {
  return requestFactory<EditorialProfile>('/api/editorial/profiles', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function resolveEditorialProfile(bookId: string) {
  return requestFactory<{
    id: string | null;
    version: string;
    hash: string;
    name: string;
    config: Record<string, unknown>;
    preferenceSummary: Record<string, unknown>;
  }>(`/api/books/${encodeURIComponent(bookId)}/editorial-profile/resolved`);
}

export function activateEditorialProfile(bookId: string, profileId: string) {
  return requestFactory(`/api/books/${encodeURIComponent(bookId)}/editorial-profile/activate`, {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  });
}

export function listEditorialBenchmarks() {
  return requestFactory<EditorialBenchmark[]>('/api/editorial/benchmarks');
}

export function startEditorialBenchmark(
  input: { suiteKey?: string; passKey?: EditorialPassKey; live?: boolean; maximumCases?: number },
  idempotencyKey: string,
) {
  return requestFactory<EditorialBenchmark>('/api/editorial/benchmarks', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
    timeoutMs: 120_000,
  });
}
