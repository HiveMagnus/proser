import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { runWorkflowEffect, readWorkflowEffect, cancelWorkflowEffect, workflowEffectPage, listWorkflowEffects } from '@/documents/workflowEffects';
import { workflowProseCandidate, workflowProseRevision } from '@/documents/workflowProse';
import { runWithWorkflowExecution } from '@/services/workflowExecutionContext';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { SceneProseService } from '@/services/sceneProseService';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import { workflowService } from '@/services/workflowService';
import { commitWorkflowDraft } from '@/documents/workflowDraft';
import * as liveJudge from '@/services/liveProseJudgeService';
import { workflowCheckpointSource, assertWorkflowCheckpointSource } from '@/documents/workflowCheckpoint';
import { scenesService } from '@/services/scenesService';

describe('canonical workflow provider effects', () => {
  const prior = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let bookId: number; let sceneId: number; let runId: string; let lease: string; let githubId: string;
  const db = () => databaseService.client;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; githubId = `effect-fixture-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Workflow effect author' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Disposable effect fixture', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: '' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id; await documentService.initialize(userId, bookId);
    lease = randomUUID(); runId = randomUUID();
    await db().workflowRun.create({ data: { id: runId, userId, bookId, workflowType: 'guided_improve', status: 'running', settings: { instruction: 'Fixture instruction' }, idempotencyKey: randomUUID(), leaseOwner: lease, leaseExpiresAt: new Date(Date.now() + 600000) } });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db().documentTraceAnalysis.deleteMany({ where: { bookId } });
    await db().sceneMemoryEvent.deleteMany({ where: { bookId } });
    await db().characterState.deleteMany({ where: { bookId } });
    await db().documentWorkflowEffect.deleteMany({ where: { bookId } }); await db().workflowRun.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => { if (prior === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = prior; await db().user.delete({ where: { id: userId } }); });
  const ownedLease = <T>(action: () => Promise<T>, owner = lease) => runWithWorkflowExecution({ runId, leaseOwner: owner, signal: new AbortController().signal }, action);
  const input = (effectKey = 'fixture') => ({ userId, bookId, runId, sceneId, effectKey, intent: { instruction: 'Exact owned request' }, timeoutMs: 300000 });
  const id = (key = 'fixture') => compatibilityOperationId('proser.workflow-provider.v1', { runId, effectKey: key });
  const auth = (value: request.Test) => value.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Workflow effect author');
  const retainedWinner = async (trace = false) => {
    const source = await documentService.read(userId, bookId, sceneId);
    const winner = { ordinal: 1, prose: 'Exact retained winner 😀 é.', wordCount: 5, ...(trace ? { traceId: randomUUID() } : {}) };
    if (winner.traceId) await db().proseTrace.create({ data: { traceId: winner.traceId, userId, bookId, sceneId, genreKey: 'fantasy', judgeStatus: 'deferred', candidates: { create: { ordinal: 1, stage: 'final', candidateType: 'generated', outputText: winner.prose, wordCount: winner.wordCount } } } });
    await ownedLease(() => runWorkflowEffect({ ...input(`draft:${sceneId}:candidate:1`), expectedRevisionId: source.bookRevisionId }, async () => ({ source: { bookRevisionId: source.bookRevisionId, sceneRevisionId: source.revisionId, contentHash: source.contentHash } }), async () => winner));
    const run = await db().workflowRun.findUniqueOrThrow({ where: { id: runId } });
    return { source, winner, run };
  };
  test('a missing preceding scene blocks later-scene inference before provider dispatch', async () => {
    const head = await documentService.manifest(userId, bookId);
    const chapterId = head.scenes.find((scene) => scene.sceneId === sceneId)!.chapterId;
    const [later] = await scenesService.batchCreateScenesForChapter({ userId, chapterId, scenes: [{ outline: 'A later consequence.' }], preconditions: { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { structure: head.scopes!.structure.revisionId } } });
    const source = await documentService.read(userId, bookId, later.id);
    const model = jest.spyOn(SceneProseService.prototype, 'generateProse');
    await expect(ownedLease(() => workflowProseCandidate(SceneProseService.getInstance(), { userId, bookId, runId, sceneId: later.id, ordinal: 1, source, context: { bookId, sceneId: later.id, title: 'Fixture' }, options: {} }))).rejects.toMatchObject({ code: 'DOCUMENT_WORKFLOW_CONTEXT_INCOMPLETE' });
    expect(model).not.toHaveBeenCalled();
    expect(await db().documentWorkflowEffect.count({ where: { bookId } })).toBe(0);
    expect((await documentService.read(userId, bookId, later.id)).projection.text).toBe('');
  });
  const draftTask = () => db().workflowTask.create({ data: { id: randomUUID(), runId, taskKey: `draft:scene:${sceneId}`, taskType: 'draft_scene', phase: 'drafting', scopeType: 'scene', scopeId: String(sceneId), ordinal: 0, dependencies: [], status: 'running' } });
  test('winner, native trace binding, task and scene memory commit once and recover after a later edit', async () => {
    jest.spyOn(liveJudge, 'enqueueLiveProseJudge').mockResolvedValue('queued');
    const { source, winner, run } = await retainedWinner(true); await draftTask();
    const receipt = await ownedLease(() => commitWorkflowDraft(run, source, winner, { selected: 1 }));
    const current = await documentService.read(userId, bookId, sceneId);
    expect(current.projection.text).toBe(winner.prose);
    expect(current.document.changes.every((change) => change.origin === 'workflow' && change.status === 'accepted')).toBe(true);
    const resolutions = await db().auditLog.findMany({ where: { entityType: 'scene', entityId: sceneId } });
    expect(resolutions.some((row) => (row.metadata as { resolution?: string } | null)?.resolution === 'authorized-workflow-automation')).toBe(true);
    expect((await db().workflowTask.findFirstOrThrow({ where: { runId } })).outputRevisionId).toBe(receipt.revisionId);
    expect((await db().documentTraceAnalysis.findUniqueOrThrow({ where: { traceId: winner.traceId } })).sourceSceneRevision).toBe(current.revisionId);
    expect(await db().sceneMemoryEvent.count({ where: { bookId } })).toBe(1);
    await ownedLease(() => documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: current.revisionId, document: current.document }] }));
    expect(await ownedLease(() => commitWorkflowDraft(run, source, winner, { selected: 1 }))).toEqual(receipt);
    expect(await db().workflowArtifact.count({ where: { runId, artifactType: 'scene_candidate_selection' } })).toBe(1);
    expect(await db().sceneMemoryEvent.count({ where: { bookId } })).toBe(1);
  });
  test('a side-record failure rolls back the document and receipt while retaining provider evidence for exact recovery', async () => {
    const { source, winner, run } = await retainedWinner();
    await expect(ownedLease(() => commitWorkflowDraft(run, source, winner, { selected: 1 }))).rejects.toBeDefined();
    expect((await documentService.read(userId, bookId, sceneId)).bookRevisionId).toBe(source.bookRevisionId);
    expect(await db().documentOperation.count({ where: { bookId } })).toBe(0);
    expect(await db().workflowArtifact.count({ where: { runId, artifactType: 'scene_candidate_selection' } })).toBe(0);
    expect((await readWorkflowEffect(userId, bookId, id(`draft:${sceneId}:candidate:1`))).status).toBe('completed');
    await draftTask(); await ownedLease(() => commitWorkflowDraft(run, source, winner, { selected: 1 }));
    expect((await documentService.read(userId, bookId, sceneId)).projection.text).toBe(winner.prose);
  });
  test('a changed candidate or stale complete source cannot be selected', async () => {
    const { source, winner, run } = await retainedWinner(); await draftTask();
    await expect(ownedLease(() => commitWorkflowDraft(run, source, { ...winner, prose: 'Forged prose' }, {}))).rejects.toMatchObject({ code: 'DOCUMENT_WORKFLOW_SELECTION_INVALID' });
    await ownedLease(() => documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] }));
    await expect(ownedLease(() => commitWorkflowDraft(run, source, winner, {}))).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE' });
    expect(await db().sceneMemoryEvent.count({ where: { bookId } })).toBe(0);
  });
  test('approved checkpoints bind formatting and book context rather than matching prose alone', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const proposal = { original: source.projection.text, revised: 'Proposal', sourceProof: workflowCheckpointSource(source) };
    expect(() => assertWorkflowCheckpointSource(proposal, source)).not.toThrow();
    const document = structuredClone(source.document); const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].style.bold = true;
    await ownedLease(() => documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document }] }));
    const current = await documentService.read(userId, bookId, sceneId);
    expect(current.projection.text).toBe(proposal.original);
    expect(() => assertWorkflowCheckpointSource(proposal, current)).toThrow('earlier complete source');
    expect(() => assertWorkflowCheckpointSource({ original: current.projection.text }, current)).toThrow('earlier complete source');
  });
  test('acknowledged result/request are retained and recovered once without preparing or invoking again', async () => {
    const prepare = jest.fn(async () => ({ prompt: 'Exact text 😀 é' })); const invoke = jest.fn(async () => ({ raw: 'Returned bytes 😀 é', model: 'fixture' }));
    const result = await ownedLease(() => runWorkflowEffect(input(), prepare, invoke));
    expect(await ownedLease(() => runWorkflowEffect(input(), prepare, invoke))).toEqual(result); expect(prepare).toHaveBeenCalledTimes(1); expect(invoke).toHaveBeenCalledTimes(1);
    const row = await readWorkflowEffect(userId, bookId, id()); expect(row.status).toBe('completed'); expect(row.sourceContentHash).toBe((await documentService.manifest(userId, bookId)).contentHash);
    await expect(ownedLease(() => runWorkflowEffect({ ...input(), intent: { instruction: 'Changed instruction' } }, prepare, invoke))).rejects.toMatchObject({ code: 'DOCUMENT_OPERATION_CONFLICT' });
    await db().documentWorkflowEffect.update({ where: { id: row.id }, data: { result: { schemaVersion: 1, data: { raw: 'Tampered' }, sha256: 'wrong' } } });
    await expect(ownedLease(() => runWorkflowEffect(input(), prepare, invoke))).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_INVALID', status: 503 });
  });
  test('unknown outcomes block replay and different-key evasion for the same run', async () => {
    const invoke = jest.fn(async () => { throw new Error('Lost provider acknowledgement'); });
    await expect(ownedLease(() => runWorkflowEffect(input(), async () => ({ prompt: 'source' }), invoke))).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_UNKNOWN' });
    expect((await readWorkflowEffect(userId, bookId, id())).status).toBe('unknown');
    await expect(ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke))).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_UNKNOWN' });
    await expect(ownedLease(() => runWorkflowEffect(input('different-key'), async () => ({}), invoke))).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_UNKNOWN' }); expect(invoke).toHaveBeenCalledTimes(1);
  });
  test('independent candidates may run together under the same live lease', async () => {
    let release!: () => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; }); const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = ownedLease(() => runWorkflowEffect(input('first'), async () => ({}), async () => { entered(); await hold; return { candidate: 1 }; })); await started;
    const second = await ownedLease(() => runWorkflowEffect(input('second'), async () => ({}), async () => ({ candidate: 2 })));
    expect(second).toEqual({ candidate: 2 }); release(); expect(await first).toEqual({ candidate: 1 });
  });
  test('late output after a lease replacement is retained but cannot apply; the new lease recovers it without inference', async () => {
    let release!: (value: { raw: string }) => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = jest.fn(() => new Promise<{ raw: string }>((resolve) => { release = resolve; entered(); }));
    const effect = ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke)).catch((error: unknown) => error); await started;
    const next = randomUUID(); await db().workflowRun.update({ where: { id: runId }, data: { leaseOwner: next } }); release({ raw: 'Retained late result' }); await effect;
    expect((await readWorkflowEffect(userId, bookId, id())).status).toBe('completed');
    expect(await ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke), next)).toEqual({ raw: 'Retained late result' }); expect(invoke).toHaveBeenCalledTimes(1);
    expect((await documentService.read(userId, bookId, sceneId)).projection.text).toBe('');
  });
  test('owner cancellation preserves late bytes and refuses replay or application', async () => {
    let release!: (value: { raw: string }) => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = jest.fn(() => new Promise<{ raw: string }>((resolve) => { release = resolve; entered(); }));
    const effect = ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke)).catch((error: unknown) => error); await started;
    await cancelWorkflowEffect(userId, bookId, id()); release({ raw: 'Late cancelled response' }); await effect;
    const row = await readWorkflowEffect(userId, bookId, id()); expect(row.status).toBe('cancelled'); expect(row.result).toMatchObject({ data: { raw: 'Late cancelled response' } });
    await expect(ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke))).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_CANCELLED' }); expect(invoke).toHaveBeenCalledTimes(1);
  });
  test('durable cancellation from another process aborts inference and retains a late acknowledgement', async () => {
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = jest.fn((_request: Record<string, never>, signal: AbortSignal) => new Promise<{ raw: string }>((resolve) => { signal.addEventListener('abort',() => resolve({ raw: 'Remote cancellation acknowledgement' }),{ once: true }); entered(); }));
    const effect = ownedLease(() => runWorkflowEffect(input(),async () => ({}),invoke)).catch((error: unknown) => error); await started;
    await db().documentWorkflowEffect.update({ where: { id: id() }, data: { status: 'cancelled', errorCode: 'OWNER_CANCELLED_PROVIDER_OUTCOME_UNCONFIRMED' } }); await effect;
    const row = await readWorkflowEffect(userId, bookId, id()); expect(row.status).toBe('cancelled'); expect(row.result).toMatchObject({ data: { raw: 'Remote cancellation acknowledgement' } }); expect(invoke).toHaveBeenCalledTimes(1);
  });
  test('known terminal failures retain exact partial evidence and never call the provider again', async () => {
    const error = new InferenceTerminalError('INFERENCE_TRUNCATED','length','structured','{"partial":true}');
    const invoke = jest.fn(async () => { throw error; });
    await expect(ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke))).rejects.toBe(error);
    await expect(ownedLease(() => runWorkflowEffect(input(), async () => ({}), invoke))).rejects.toMatchObject({ code: 'INFERENCE_TRUNCATED', partialOutput: error.partialOutput }); expect(invoke).toHaveBeenCalledTimes(1);
    expect((await readWorkflowEffect(userId, bookId, id())).result).toMatchObject({ providerOutcome: 'completed', raw: error.partialOutput, finishReason: 'length' });
  });
  test('stale sources fail before provider invocation and owner reads are bounded/private', async () => {
    const invoke = jest.fn(async () => ({}));
    await expect(ownedLease(() => runWorkflowEffect({ ...input(), expectedRevisionId: randomUUID() }, async () => ({}), invoke))).rejects.toMatchObject({ status: 412 }); expect(invoke).not.toHaveBeenCalled();
    await ownedLease(() => runWorkflowEffect(input(), async () => ({ prompt: 'Paragraph 😀 é '.repeat(1000) }), async () => ({ raw: 'owned result' })));
    const page = await workflowEffectPage(userId, bookId, id(), 'request', 0, 1024); expect('text' in page && page.text!.length).toBeLessThanOrEqual(1024); expect(page).toMatchObject({ hasMore: true, nextOffset: 1024 });
    await expect(readWorkflowEffect(userId + 100000, bookId, id())).rejects.toMatchObject({ status: 404 });
    const response = await auth(request(app).get(`/api/books/${bookId}/document-workflow-effects/${id()}`)); expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.body.data.request).toBeUndefined();
  });
  test('owned receipt enumeration pages every effect with stable cursors and rejects foreign cursors', async () => {
    for (const key of ['one','two','three']) await ownedLease(() => runWorkflowEffect(input(key), async () => ({}), async () => ({ key })));
    const first = await listWorkflowEffects(userId, bookId, runId, undefined, 2); expect(first.items).toHaveLength(2); expect(first.hasMore).toBe(true);
    const last = await listWorkflowEffects(userId, bookId, runId, first.nextCursor!, 2); expect(last.items).toHaveLength(1); expect(last.hasMore).toBe(false);
    expect(new Set([...first.items,...last.items].map((item) => item.id)).size).toBe(3);
    await expect(listWorkflowEffects(userId, bookId, runId, randomUUID())).rejects.toMatchObject({ status: 422 });
    await expect(listWorkflowEffects(userId + 100000, bookId, runId)).rejects.toMatchObject({ status: 404 });
  });
  test('candidate context/codex is frozen from canonical ownership and replay retains deferred feedback', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const model = jest.spyOn(SceneProseService.prototype,'generateProse').mockResolvedValue({ prose: 'An exact candidate.', wordCount: 3, codexUsed: [], model: 'fixture', skillFindings: [] });
    const descriptor = { userId, bookId, runId, sceneId, ordinal: 1, source, context: { bookId, sceneId, title: 'Forged UI title', targetWords: 900, useCodexRAG: true }, options: { timeoutMs: 600000 } };
    const service = SceneProseService.getInstance();
    await ownedLease(() => workflowProseCandidate(service, descriptor)); await ownedLease(() => workflowProseCandidate(service, descriptor)); expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][0].title).toBe('Disposable effect fixture'); expect(model.mock.calls[0][1]).toMatchObject({ frozenContext: true, noTransportReplay: true, autoReviseSkills: false, frozenSource: { sceneRevisionId: source.revisionId, contentHash: source.contentHash } });
  });
  test('workflow revision source is exact and does not run inference for a stale projection', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const model = jest.spyOn(SceneProseService.prototype,'reviewProse');
    await expect(ownedLease(() => workflowProseRevision(SceneProseService.getInstance(), { userId, bookId, runId, sceneId, effectKey: 'review', source, original: 'Unowned substitute text', instruction: {}, options: {} }))).rejects.toMatchObject({ status: 412 }); expect(model).not.toHaveBeenCalled();
  });
  test('a draft target filled after hierarchy loading cannot trigger replacement inference', async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const document = structuredClone(source.document); const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].text = 'Newly saved manual prose.';
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document }] });
    const current = await documentService.read(userId, bookId, sceneId); const model = jest.spyOn(SceneProseService.prototype, 'generateProse');
    await expect(ownedLease(() => workflowProseCandidate(SceneProseService.getInstance(), { userId, bookId, runId, sceneId, ordinal: 1, source: current, context: { bookId, sceneId, title: 'Owned book', targetWords: 900 }, options: {} }))).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE', status: 412 });
    expect(model).not.toHaveBeenCalled(); expect(await db().documentWorkflowEffect.count({ where: { runId } })).toBe(0); expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(current.document);
  });
  test('recovering acknowledged revisions cannot rebase them onto newer formatting or text', async () => {
    const source = await documentService.read(userId, bookId, sceneId); const model = jest.spyOn(SceneProseService.prototype,'reviewProse').mockResolvedValue({ revised: 'Owned model result' });
    const original = { userId, bookId, runId, sceneId, effectKey: 'format-bound-review', source, original: '', instruction: { instruction: 'Make a precise edit' }, options: {} };
    await ownedLease(() => workflowProseRevision(SceneProseService.getInstance(),original));
    const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].style = { italic: true };
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const changed = await documentService.read(userId, bookId, sceneId);
    await expect(ownedLease(() => workflowProseRevision(SceneProseService.getInstance(),{ ...original, source: changed }))).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE', status: 412 }); expect(model).toHaveBeenCalledTimes(1);
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(changed.document);
  });
  test('native guided workflow pauses on an unknown revision effect and never overwrites the scene', async () => {
    await db().workflowRun.update({ where: { id: runId }, data: { status: 'completed', leaseOwner: null, leaseExpiresAt: null } });
    const source = await documentService.read(userId, bookId, sceneId); const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0].text = Array.from({ length: 180 },(_,index) => `word${index}`).join(' '); paragraph.runs[0].style = { bold: true };
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const before = await documentService.read(userId, bookId, sceneId);
    const model = jest.spyOn(SceneProseService.prototype,'reviewProse').mockRejectedValue(new Error('Provider acknowledgement lost'));
    const run = await workflowService.start(userId,'guided_improve',{ bookId, scope: { type: 'scene', id: sceneId }, instruction: 'Improve clarity while retaining all established details.' },undefined,false,undefined,`effects-${randomUUID()}`);
    await expect(workflowService.process(run.runId)).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_UNKNOWN' });
    expect((await workflowService.status(userId,run.runId)).status).toBe('paused'); expect(model).toHaveBeenCalledTimes(1);
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(before.document);
    expect((await db().documentWorkflowEffect.findFirstOrThrow({ where: { runId: run.runId } })).status).toBe('unknown');
  });
});
