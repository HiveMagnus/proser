import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { paragraphsOf, minimalTextEdit } from '@/documents/model';
import { savePlotThread, addPlotThreadEvidence, readPlotThread, readPlotThreadMutation, removePlotThreadEvidence, listPlotThreads,
  requestPlotThreadReview, readPlotThreadReview, cancelPlotThreadReview, assessPlotThreadReview, verifyPlotThreadCritique, verifyPlotThreadProposalOutput, plotThreadChecks } from '@/documents/plotThreads';
import { createDocumentDiscussion, requestDocumentProposal, revalidateDocumentProposal, applyDocumentProposal } from '@/documents/proposals';
import { documentProposalPrompt } from '@/documents/proposalPrompt';
import { plotThreadReviewPrompt } from '@/documents/plotThreadPrompt';
import { SceneProseService } from '@/services/sceneProseService';
import { defaultModelRouter } from '@/lib/ai/router';
import { extractMemory } from '@/lib/memory/extractor';
import { retrievePlotThreads } from '@/lib/memory/retrieval';
import { CONFIG } from '@/core/config';
import type { PlotThreadReviewSnapshot, PlotThreadCritique, PlotThreadStage } from '@/documents/plot-thread-model';
import type { DocumentDiscussionSnapshot, DocumentProposalOutput } from '@/documents/proposal-model';
const db = () => databaseService.client;
const question = 'Will the apprentice discover who betrayed her?';
const texts = ['The apprentice found a broken red seal. Only her mentor used red wax. 😀', 'Her mentor denied the letter, but red wax clung to his sleeve.', 'The mentor confessed that he had betrayed her to save his son.'];
describe('Plot Threads saved workflow', () => {
  let userId: number, bookId: number, threadId: number, scenes: number[], githubId: string;
  const authority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    githubId = `plot-thread-test-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Thread author' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Apprentice thread fixture', acts: { create: { actNumber: 1, chapters: { create: texts.map((text, i) => ({ chapterNumber: i + 1, scenes: { create: { sceneNumber: 1, prose: text } } })) } } } } });
    bookId = book.id;
    await documentService.initialize(userId, bookId);
    scenes = (await documentService.manifest(userId, bookId)).scenes.map(scene => scene.sceneId);
    const receipt = await savePlotThread(userId, bookId, undefined, { operationId: randomUUID(), expectedVersion: 0, question });
    threadId = (receipt as { threadId: number }).threadId;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const head = await documentService.manifest(userId, bookId);
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { structure: head.scopes!.structure.revisionId }, payload: { fixture: 'retire-plot-thread-test' } }, async tx => ({ result: await tx.book.update({ where: { id: bookId }, data: { deletedAt: new Date() } }) }));
  });
  afterAll(() => { if (authority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = authority; });
  const attach = async (stage: PlotThreadStage, index: number, extra: Record<string, unknown> = {}) => {
    const source = await documentService.read(userId, bookId, scenes[index]);
    const paragraph = paragraphsOf(source.document)[0];
    const t = await readPlotThread(userId, bookId, threadId);
    const input = { operationId: randomUUID(), expectedVersion: t.version, stage, sceneId: scenes[index], expectedRevisionId: source.bookRevisionId, expectedSceneRevisionId: source.revisionId, expectedContentHash: source.contentHash,
      targets: [{ blockId: paragraph.id, from: 0, to: paragraph.runs[0].text.length, sourceText: paragraph.runs[0].text }], ...extra };
    const receipt = await addPlotThreadEvidence(userId, bookId, threadId, input);
    return { input, receipt };
  };
  const critique = (snapshot: PlotThreadReviewSnapshot, assessment: PlotThreadCritique['assessment'] = 'earned') => ({ assessment, summary: 'The red wax prepares the betrayal reveal, but the motive needs earlier pressure.', findings: [{ aspect: 'causality', explanation: 'The confession follows the red wax clue.', suggestion: 'Establish the danger to the mentor’s son before the reveal.', citations: [{ evidenceId: snapshot.evidence.at(-1)!.id, quote: snapshot.evidence.at(-1)!.source.targets[0].sourceText }] }] });
  const review = async () => {
    const t = await readPlotThread(userId, bookId, threadId), manifest = await documentService.manifest(userId, bookId);
    return requestPlotThreadReview(userId, bookId, threadId, { operationId: randomUUID(), expectedVersion: t.version, expectedRevisionId: manifest.revisionId });
  };
  test('creates a question, persists all stages and recovers exact mutation receipts without duplicates', async () => {
    const { input, receipt } = await attach('setup', 0);
    expect(await addPlotThreadEvidence(userId, bookId, threadId, input)).toEqual(receipt);
    expect(await readPlotThreadMutation(userId, bookId, input.operationId)).toEqual(receipt);
    await attach('escalation', 1); await attach('payoff', 2);
    const reopened = await readPlotThread(userId, bookId, threadId);
    expect(reopened.question).toBe(question); expect(reopened.evidence).toHaveLength(3); expect(reopened.checks).toEqual([]);
    expect(reopened.evidence[0].source.text).toBe(texts[0]);
    expect(reopened.evidence[0].source.anchors[0].sourceText).toBe(texts[0]);
    expect((await listPlotThreads(userId, bookId, false)).threads[0].coverage).toEqual({ setup: 1, escalation: 1, payoff: 1 });
    expect((await retrievePlotThreads({ bookId }))[0].threadKey).toBe(question);
    await expect(addPlotThreadEvidence(userId, bookId, threadId, { ...input, stage: 'payoff' })).rejects.toMatchObject({ code: 'DOCUMENT_OPERATION_CONFLICT' });
  });
  test('requires a nonempty question and isolates books, users and exact evidence', async () => {
    await expect(savePlotThread(userId, bookId, undefined, { operationId: randomUUID(), expectedVersion: 0 })).rejects.toMatchObject({ code: 'PLOT_THREAD_QUESTION_REQUIRED' });
    await expect(readPlotThread(userId + 99999, bookId, threadId)).rejects.toMatchObject({ status: 404 });
    await expect(readPlotThread(userId, bookId, threadId + 99999)).rejects.toMatchObject({ status: 404 });
    const response = await request(app).get(`/api/books/${bookId}/plot-threads/${threadId}`).set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Thread author');
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.body.data.question).toBe(question);
  });
  test('rejects forged quotation and Unicode boundaries without leaving evidence or a receipt', async () => {
    const source = await documentService.read(userId, bookId, scenes[0]), paragraph = paragraphsOf(source.document)[0], text = paragraph.runs[0].text;
    const input = { operationId: randomUUID(), expectedVersion: 1, stage: 'setup', sceneId: scenes[0], expectedRevisionId: source.bookRevisionId, expectedSceneRevisionId: source.revisionId, expectedContentHash: source.contentHash,
      targets: [{ blockId: paragraph.id, from: text.indexOf('😀'), to: text.indexOf('😀') + 1, sourceText: '\ud83d' }] };
    await expect(addPlotThreadEvidence(userId, bookId, threadId, input)).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    await expect(addPlotThreadEvidence(userId, bookId, threadId, { ...input, targets: [{ ...input.targets[0], from: 0, to: 5, sourceText: 'Forged' }] })).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    expect(await db().plotThreadEvidence.count({ where: { bookId } })).toBe(0);
    await expect(readPlotThreadMutation(userId, bookId, input.operationId)).rejects.toMatchObject({ status: 404 });
  });
  test('serializes competing versioned changes and retains removed and replaced excerpts', async () => {
    const responses = await Promise.allSettled(['First', 'Second'].map(notes => savePlotThread(userId, bookId, threadId, { operationId: randomUUID(), expectedVersion: 1, notes })));
    expect(responses.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(responses.filter(r => r.status === 'rejected')).toHaveLength(1);
    await attach('setup', 0);
    const original = (await readPlotThread(userId, bookId, threadId)).evidence[0];
    await attach('setup', 1, { replacesEvidenceId: original.id });
    expect((await db().plotThreadEvidence.findUniqueOrThrow({ where: { id: original.id } })).removedAt).not.toBeNull();
    const t = await readPlotThread(userId, bookId, threadId);
    await removePlotThreadEvidence(userId, bookId, threadId, t.evidence[0].id, { operationId: randomUUID(), expectedVersion: t.version });
    expect((await readPlotThread(userId, bookId, threadId)).evidence).toHaveLength(0);
    expect(await db().plotThreadEvidence.count({ where: { bookId } })).toBe(2);
  });
  test('checks missing linked stages and ordering without asserting absent manuscript content', async () => {
    await attach('payoff', 0); await attach('setup', 2);
    const t = await readPlotThread(userId, bookId, threadId);
    expect(t.checks).toContain('No escalation linked.');
    expect(t.checks.some(check => check.includes('payoff occurs at or before linked setup'))).toBe(true);
    expect(plotThreadChecks([])).toEqual(['No setup linked.', 'No escalation linked.', 'No payoff linked.']);
  });
  test('citations accept literal multi-paragraph excerpts but reject split Unicode graphemes', async () => {
    await attach('setup', 0); await attach('payoff', 2);
    jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot, 'weak')), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const r = await review(), snapshot = structuredClone(r.snapshot), evidence = snapshot.evidence[0];
    evidence.source.text += '\nAn exact second paragraph.';
    const cited = critique(snapshot, 'weak');
    cited.findings[0].citations = [{ evidenceId: evidence.id, quote: '😀\nAn exact second paragraph.' }];
    expect(() => verifyPlotThreadCritique(snapshot, cited)).not.toThrow();
    for (const quote of ['\ud83d', 'e']) {
      evidence.source.text = '😀 e\u0301';
      cited.findings[0].citations[0].quote = quote;
      expect(() => verifyPlotThreadCritique(snapshot, cited)).toThrow('unsupported evidence');
    }
  });
  test('catalog/layout changes and deleted scenes retain stale evidence and exact old receipts', async () => {
    const { input, receipt } = await attach('setup', 0);
    const original = (await readPlotThread(userId, bookId, threadId)).evidence[0];
    const layout = structuredClone((await documentService.scope(userId, bookId, 'layout')).content);
    layout.book.fontSize += 1;
    let head = await documentService.manifest(userId, bookId);
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { layout: head.scopes!.layout.revisionId }, payload: { layout } }, async () => ({ result: 'test layout change', layout }));
    expect((await readPlotThread(userId, bookId, threadId)).evidence[0]).toMatchObject({ stale: true, source: original.source });
    expect(await addPlotThreadEvidence(userId, bookId, threadId, input)).toEqual(receipt);
    head = await documentService.manifest(userId, bookId);
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { structure: head.scopes!.structure.revisionId }, payload: { deleteScene: scenes[0] } }, async tx => ({ result: await tx.scene.update({ where: { id: scenes[0] }, data: { deletedAt: new Date() } }) }));
    expect((await readPlotThread(userId, bookId, threadId)).evidence[0]).toMatchObject({ stale: true, source: original.source });
    expect(await readPlotThreadMutation(userId, bookId, input.operationId)).toEqual(receipt);
  });
  test.each([
    { flag: 'absent', value: undefined },
    { flag: 'disabled', value: false },
    { flag: 'enabled', value: true },
  ])('archives threads without erasing evidence and prevents extractor overwrite (memory flag $flag)', async ({ value }) => {
    await attach('setup', 0);
    const t = await readPlotThread(userId, bookId, threadId);
    const originalFlag = Object.getOwnPropertyDescriptor(CONFIG, 'RAG_MEMORY_ENABLED');
    try {
      if (value === undefined) delete CONFIG.RAG_MEMORY_ENABLED;
      else CONFIG.RAG_MEMORY_ENABLED = value;
      // Optional configuration keys may be absent in CI; replacement requires an existing key.
      CONFIG.RAG_MEMORY_ENABLED = true;
      const provider = defaultModelRouter.choose('generic');
      const inference = jest.spyOn(provider, 'generateText').mockResolvedValue(JSON.stringify({ events: [], state_changes: [], thread_updates: [{ thread_key: t.threadKey, status: 'resolved', description: 'Overwrite author question', confidence: 1 }] }));
      const extracted = await extractMemory({ bookId, sceneId: scenes[0], prose: 'A saved narrative sentence. '.repeat(30) });
      expect(inference).toHaveBeenCalledTimes(1);
      expect(extracted.threadUpdates).toHaveLength(1);
      expect((await readPlotThread(userId, bookId, threadId)).status).toBe('open');
      await savePlotThread(userId, bookId, threadId, { operationId: randomUUID(), expectedVersion: t.version, archived: true });
      expect((await listPlotThreads(userId, bookId, false)).threads).toHaveLength(0);
      expect((await listPlotThreads(userId, bookId, true)).threads).toHaveLength(1);
      expect((await retrievePlotThreads({ bookId }))).toHaveLength(0);
      expect((await readPlotThread(userId, bookId, threadId)).evidence).toHaveLength(1);
    } finally {
      jest.restoreAllMocks();
      if (originalFlag) Object.defineProperty(CONFIG, 'RAG_MEMORY_ENABLED', originalFlag);
      else delete CONFIG.RAG_MEMORY_ENABLED;
    }
  });
  test('persists earned and weak critiques, author judgment and exact review recovery without rewriting prose', async () => {
    await attach('setup', 0); await attach('escalation', 1); await attach('payoff', 2);
    const original = await documentService.manifest(userId, bookId);
    const inference = jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot)), provenance: { providerId: 'test-only', params: {}, recipe: 'plot-thread-review', recipeVersion: '1.0.0' } }));
    const r = await review(); expect(r.status).toBe('ready'); expect(r.result?.output?.assessment).toBe('earned');
    const t = await readPlotThread(userId, bookId, threadId);
    await assessPlotThreadReview(userId, bookId, threadId, r.id, { operationId: randomUUID(), expectedVersion: t.version, assessment: 'weak', notes: 'The son needs a setup.' });
    const input = await db().plotThreadReview.findUniqueOrThrow({ where: { id: r.id } });
    expect((await requestPlotThreadReview(userId, bookId, threadId, input.request)).id).toBe(r.id);
    const reopened = await readPlotThread(userId, bookId, threadId);
    expect(reopened.reviews[0].assessment).toBe('weak'); expect(reopened.reviews[0].result?.output?.assessment).toBe('earned'); expect(reopened.status).toBe('open');
    await savePlotThread(userId, bookId, threadId, { operationId: randomUUID(), expectedVersion: t.version, question });
    expect((await readPlotThreadReview(userId, bookId, threadId, r.id)).stale).toBe(false);
    expect(inference).toHaveBeenCalledTimes(1); expect((await documentService.manifest(userId, bookId)).revisionId).toBe(original.revisionId);
  });
  test('rejects invented citations, overconfident missing-stage assessment and malformed provider output', async () => {
    await attach('payoff', 2);
    jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot, 'weak')), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const r = await review(); expect(r.status).toBe('ready');
    expect(() => verifyPlotThreadCritique(r.snapshot, critique(r.snapshot, 'earned'))).toThrow('requires linked');
    const forged = critique(r.snapshot, 'weak'); forged.findings[0].citations[0].quote = 'Invented betrayal';
    expect(() => verifyPlotThreadCritique(r.snapshot, forged)).toThrow('unsupported evidence');
    forged.findings[0].citations[0].evidenceId = randomUUID();
    expect(() => verifyPlotThreadCritique(r.snapshot, forged)).toThrow();
    expect(() => plotThreadReviewPrompt({ ...r.snapshot, notes: 'Oversized context. '.repeat(4000) })).toThrow('model context budget');
  });
  test('unknown provider outcomes retain original operation and block duplicate snapshot dispatch', async () => {
    await attach('payoff', 2);
    const inference = jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockRejectedValue(new Error('Transport lost after dispatch'));
    const r = await review(); expect(r.status).toBe('unknown');
    const row = await db().plotThreadReview.findUniqueOrThrow({ where: { id: r.id } });
    expect((await requestPlotThreadReview(userId, bookId, threadId, row.request)).status).toBe('unknown');
    await expect(review()).rejects.toMatchObject({ code: 'PLOT_THREAD_REVIEW_UNRESOLVED' });
    expect(inference).toHaveBeenCalledTimes(1);
  });
  test('saved prose changes mark evidence and reviews stale and block proposals against an old review', async () => {
    await attach('payoff', 2);
    jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot, 'weak')), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const r = await review(), source = await documentService.read(userId, bookId, scenes[2]);
    paragraphsOf(source.document)[0].runs[0].text += ' Added consequence.';
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: scenes[2], expectedRevisionId: source.revisionId, document: source.document }] });
    expect((await readPlotThread(userId, bookId, threadId)).evidence[0].stale).toBe(true);
    expect((await readPlotThreadReview(userId, bookId, threadId, r.id)).stale).toBe(true);
    await expect(review()).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE' });
  });
  test('recovers retained provider bytes after a crash before critique validation without inference', async () => {
    await attach('payoff', 2);
    const inference = jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot, 'weak')), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const original = await review();
    const row = await db().plotThreadReview.findUniqueOrThrow({ where: { id: original.id } });
    const { output: _output, ...retained } = row.result as unknown as { raw: string; output: PlotThreadCritique };
    await db().plotThreadReview.update({ where: { id: row.id }, data: { status: 'running', result: retained, startedAt: new Date(Date.now() - 300000), completedAt: null } });
    inference.mockClear();
    expect((await readPlotThreadReview(userId, bookId, threadId, row.id)).status).toBe('ready');
    expect((await requestPlotThreadReview(userId, bookId, threadId, row.request)).result?.output).toEqual(original.result?.output);
    expect(inference).not.toHaveBeenCalled();
    await db().plotThreadReview.update({ where: { id: row.id }, data: { status: 'unknown', result: { raw: '{incomplete', provenance: {} } } });
    expect((await readPlotThreadReview(userId, bookId, threadId, row.id)).status).toBe('failed');
    expect((await db().plotThreadReview.findUniqueOrThrow({ where: { id: row.id } })).result).toMatchObject({ raw: '{incomplete' });
    expect(inference).not.toHaveBeenCalled();
  });
  test('cancellation after dispatch stays unknown and blocks another call until its original result arrives', async () => {
    await attach('payoff', 2);
    let started!: () => void, complete!: (value: Awaited<ReturnType<SceneProseService['reviewPlotThread']>>) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let snapshot!: PlotThreadReviewSnapshot;
    const inference = jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async frozen => {
      snapshot = frozen; started(); return new Promise(resolve => { complete = resolve; });
    });
    const originalRequest = review(); await entered;
    const row = await db().plotThreadReview.findFirstOrThrow({ where: { bookId, threadId } });
    expect((await cancelPlotThreadReview(userId, bookId, threadId, row.id)).status).toBe('unknown');
    expect((await db().auditLog.findFirst({ where: { entityType: 'book', entityId: bookId, metadata: { path: ['action'], equals: 'cancel-plot-thread-review' } } }))?.metadata).toMatchObject({ priorStatus: 'running', outcome: 'unknown-after-dispatch', reviewId: row.id });
    await expect(review()).rejects.toMatchObject({ code: 'PLOT_THREAD_REVIEW_UNRESOLVED' });
    complete({ raw: JSON.stringify(critique(snapshot, 'weak')), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } });
    expect((await originalRequest).status).toBe('ready');
    expect((await readPlotThreadReview(userId, bookId, threadId, row.id)).status).toBe('ready');
    expect(inference).toHaveBeenCalledTimes(1);
  });
  test('legacy dispatched cancellations remain uncertain rather than authorizing replacement inference', async () => {
    await attach('payoff', 2);
    const inference = jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockRejectedValue(new Error('Lost transport'));
    const original = await review();
    await db().plotThreadReview.update({ where: { id: original.id }, data: { status: 'cancelled' } });
    await expect(review()).rejects.toMatchObject({ code: 'PLOT_THREAD_REVIEW_UNRESOLVED' });
    expect((await readPlotThreadReview(userId, bookId, threadId, original.id)).status).toBe('unknown');
    expect((await db().auditLog.findFirst({ where: { entityType: 'book', entityId: bookId, metadata: { path: ['action'], equals: 'plot-thread-dispatched-cancellation-uncertain' } } }))?.metadata).toMatchObject({ priorStatus: 'cancelled', reviewId: original.id });
    expect(inference).toHaveBeenCalledTimes(1);
  });
  test('a pending request whose source changed receives a terminal no-dispatch receipt', async () => {
    await attach('payoff', 2);
    const inference = jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot, 'weak')), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const original = await review(), t = await readPlotThread(userId, bookId, threadId);
    const row = await db().plotThreadReview.findUniqueOrThrow({ where: { id: original.id } });
    await db().plotThreadReview.update({ where: { id: row.id }, data: { status: 'pending', result: Prisma.DbNull, startedAt: null, completedAt: null } });
    await savePlotThread(userId, bookId, threadId, { operationId: randomUUID(), expectedVersion: t.version, notes: 'Changed before dispatch' });
    inference.mockClear();
    const recovered = await requestPlotThreadReview(userId, bookId, threadId, row.request);
    expect(recovered.status).toBe('failed'); expect(recovered.errorCode).toBe('PLOT_THREAD_VERSION_CONFLICT');
    expect(inference).not.toHaveBeenCalled();
    expect((await readPlotThreadReview(userId, bookId, threadId, row.id)).status).toBe('failed');
    expect((await review()).status).toBe('ready'); expect(inference).toHaveBeenCalledTimes(1);
  });
  test('cited proposals require exact targets and apply once as pending tracked changes', async () => {
    await attach('setup', 0); await attach('escalation', 1); await attach('payoff', 2);
    jest.spyOn(SceneProseService.prototype, 'reviewPlotThread').mockImplementation(async snapshot => ({ raw: JSON.stringify(critique(snapshot)), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const r = await review(), e = r.snapshot.evidence[2], f = e.source.frame;
    const input = { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId: f.sceneId, expectedRevisionId: r.snapshot.bookRevisionId, expectedSceneRevisionId: f.sceneRevisionId, expectedContentHash: f.sceneContentHash, projection: 'final', targets: e.source.targets.map(({ blockId, from, to, sourceText }) => ({ blockId, from, to, sourceText })), plotThreadReviewId: r.id, plotThreadEvidenceId: e.id };
    await expect(createDocumentDiscussion(userId, bookId, { ...input, plotThreadEvidenceId: r.snapshot.evidence[0].id })).rejects.toMatchObject({ code: 'PLOT_THREAD_EVIDENCE_INVALID' });
    const discussion = await createDocumentDiscussion(userId, bookId, input);
    const discussionSnapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
    expect(discussionSnapshot.plotThread?.snapshot.question).toBe(question);
    const prompt = documentProposalPrompt(discussionSnapshot, 'Make a small causal connection.');
    expect(prompt).toContain(discussionSnapshot.targets[0].targetId);
    expect(prompt).not.toContain(e.source.targets[0].targetId);
    expect(() => verifyPlotThreadProposalOutput(discussionSnapshot, { reply: 'No change needed.', edits: [{ targetId: discussionSnapshot.targets[0].targetId, sourceText: discussionSnapshot.targets[0].sourceText, replacement: discussionSnapshot.targets[0].sourceText }] })).toThrow('leaves the passage unchanged');
    const inference = jest.spyOn(SceneProseService.prototype, 'proposeDocumentEdits').mockImplementation(async s => ({ raw: JSON.stringify({ reply: 'Tie the confession to the clue.', edits: [{ targetId: s.targets[0].targetId, sourceText: s.targets[0].sourceText, replacement: 'With red wax still on his sleeve, the mentor confessed that he had betrayed her to save his son.' }] }), provenance: { providerId: 'test-only', params: {}, recipe: 'test', recipeVersion: '1' } }));
    const proposalInput = { operationId: randomUUID(), instruction: 'Make a small causal connection.' };
    const p = await requestDocumentProposal(userId, bookId, discussion.id, proposalInput); expect(p.status).toBe('ready');
    const validation = await revalidateDocumentProposal(userId, bookId, p.id, { operationId: randomUUID(), expectedRevisionId: r.snapshot.bookRevisionId, expectedSceneRevisionId: f.sceneRevisionId });
    const output = (p.result as unknown as { output: DocumentProposalOutput }).output;
    const apply = { operationId: randomUUID(), expectedRevisionId: r.snapshot.bookRevisionId, expectedSceneRevisionId: f.sceneRevisionId, validationId: validation.id, targetIds: output.edits.map(edit => edit.targetId) };
    const receipt = await applyDocumentProposal(userId, bookId, p.id, apply);
    expect(await applyDocumentProposal(userId, bookId, p.id, apply)).toEqual(receipt);
    expect(inference).toHaveBeenCalledTimes(1);
    const changed = await documentService.read(userId, bookId, f.sceneId);
    expect(changed.document.changes.some(change => change.status === 'pending')).toBe(true);
    expect((await readPlotThread(userId, bookId, threadId)).reviews[0].stale).toBe(true);
    expect(minimalTextEdit(texts[2], output.edits[0].replacement).replacement.length).toBeLessThan(600);
  });
});
