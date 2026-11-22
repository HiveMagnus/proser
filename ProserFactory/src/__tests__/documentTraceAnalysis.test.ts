import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText, projectDocument } from '@/documents/model';
import { bindGeneratedTrace, analyzeBoundTrace, revalidateBoundCompare, recordBoundPreference, readDocumentTraceReview, cancelTraceAnalysis, readTraceAnalysis } from '@/documents/traceAnalysis';
import { SceneProseService } from '@/services/sceneProseService';
import { submitLiveProseJudge } from '@/services/liveProseJudgeService';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import { DocumentError } from '@/documents/errors';
import type { LiveProseJudgePayload } from '@/queues/liveProseJudgeQueue';

describe('revision-bound findings and atomic compare choices', () => {
  const previous = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let bookId: number; let sceneId: number; let githubId: string; let traceId: string; let analysisId: string;
  const db = () => databaseService.client;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    githubId = `trace-fixture-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Review author' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Disposable review fixture', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'The repeated phrase echoes in the quiet room.\n\nThe repeated phrase echoes in the quiet room.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
    const source = await documentService.read(userId, bookId, sceneId);
    for (const block of source.document.blocks) if (block.type === 'paragraph') block.runs[0].style = { bold: true, font: 'Georgia' };
    const cell = documentFromText('The protected table echoes 😀 é in the quiet room.', randomUUID).blocks[0]; if (cell.type !== 'paragraph') throw new Error('fixture');
    cell.runs[0].style = { italic: true };
    source.document.blocks.push({ type: 'table', id: randomUUID(), widths: [120], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [cell] }] }] });
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const body = await documentService.read(userId, bookId, sceneId);const layout=await documentService.scope(userId,bookId,'layout');const structure=await documentService.scope(userId,bookId,'structure');const actId=structure.content.chapters.find((chapter)=>chapter.id===body.chapterId)!.actId;
    await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:layout.bookRevisionId,expectedScopes:{layout:layout.revisionId,structure:structure.revisionId},payload:{fixture:'owned-chapter-layouts'}},async(tx)=>{const chapter=await tx.chapter.create({data:{actId,chapterNumber:2,title:'Other owned chapter'}});const contents=structuredClone(layout.content);contents.chapters[String(body.chapterId)]={...contents.book,fontSize:16};contents.chapters[String(chapter.id)]={...contents.book,fontSize:28};return {result:{chapterId:chapter.id},layout:contents};});
    const current = await documentService.read(userId, bookId, sceneId);
    traceId = randomUUID();
    await db().proseTrace.create({ data: { traceId, userId, bookId, sceneId, genreKey: 'fantasy', judgeStatus: 'deferred', candidates: { create: { ordinal: 1, stage: 'final', candidateType: 'generated', outputText: current.projection.text, wordCount: current.projection.wordCount } } } });
    const operationId = randomUUID();
    await db().documentInferenceOperation.create({ data: { id: operationId, bookId, userId, sceneId, requestHash: 'fixture', request: {}, sourceBookRevision: current.bookRevisionId, sourceSceneRevision: current.revisionId, sourceContentHash: current.contentHash, status: 'completed', result: { prose: current.projection.text, traceId } } });
    await documentService.mutateCatalog(userId, bookId, { operationId, expectedRevisionId: current.bookRevisionId, expectedScopes: {}, payload: { fixture: 'saved-generation' } }, async () => ({ result: {} }), 'ai');
    const analysis = await bindGeneratedTrace(userId, bookId, sceneId, traceId, operationId); analysisId = analysis.id;
    expect((await bindGeneratedTrace(userId, bookId, sceneId, traceId, operationId)).id).toBe(analysisId);
    await expect(bindGeneratedTrace(userId, bookId, sceneId, traceId, randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_OPERATION_CONFLICT' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db().documentCompareValidation.deleteMany({ where: { bookId } });
    await db().documentTraceTarget.deleteMany({ where: { bookId } });
    await db().documentTraceAnalysis.deleteMany({ where: { bookId } });
    await db().documentInferenceOperation.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => { if (previous === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previous; await db().user.delete({ where: { id: userId } }); });
  const judge = async () => submitLiveProseJudge((await db().documentTraceAnalysis.findUniqueOrThrow({ where: { id: analysisId } })).payload as unknown as LiveProseJudgePayload);
  const provider = (index = 1) => jest.spyOn(SceneProseService.prototype, 'analyzeDocument').mockImplementation(async (snapshot) => {
    const target = snapshot.targets[index];
    return { raw: JSON.stringify({ judgeSummary: { headline: 'Fixture', summary: 'Exact saved targets.', strengths: [], cautions: [] }, findings: [{ target: { targetId: target.targetId, from: 0, to: target.sourceText.length, sourceText: target.sourceText }, findingType: 'clarity', severity: 'suggestion', title: 'Precise finding', message: 'Review this passage.' }], compareCards: [{ target: { targetId: target.targetId, from: 0, to: target.sourceText.length, sourceText: target.sourceText }, title: 'Precise choice', message: 'Choose wording.', optionALabel: 'Keep', optionAText: target.sourceText, optionBLabel: 'Revise', optionBText: target.sourceText.replace('echoes', 'resounds') }] }), provenance: { providerId: 'fixture', params: {}, recipe: 'document-analysis', recipeVersion: '1.0.0' } };
  });
  const prepare = async (index = 1) => { const model = provider(index); await analyzeBoundTrace(traceId, await judge()); const review = (await readDocumentTraceReview(userId, bookId, sceneId))!; return { model, review, card: review.compareCards[0] }; };
  const validation = async (cardId: number) => { const source = await documentService.read(userId, bookId, sceneId); return revalidateBoundCompare(userId, bookId, traceId, cardId, { operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, expectedSceneRevisionId: source.revisionId }); };
  const auth = (value: request.Test) => value.set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Review author');

  test('same-body chapter transfer makes compare bindings stale under an unchanged layout scope and preserves exact original snapshots',async()=>{
    const {model,card}=await prepare();const verified=await validation(card.id);const source=await documentService.read(userId,bookId,sceneId);const manifest=await documentService.manifest(userId,bookId);const structure=await documentService.scope(userId,bookId,'structure');const destination=structure.content.chapters.find((chapter)=>chapter.id!==source.chapterId)!;const snapshot=(await db().documentTraceAnalysis.findUniqueOrThrow({where:{id:analysisId}})).snapshot;
    await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:manifest.revisionId,expectedScopes:{structure:structure.revisionId},payload:{fixture:'moved-compare-scene'}},async(tx)=>({result:await tx.scene.update({where:{id:sceneId},data:{chapterId:destination.id,sceneNumber:1}})}));const current=await documentService.read(userId,bookId,sceneId);expect(current.revisionId).toBe(source.revisionId);expect(current.contentHash).toBe(source.contentHash);expect((await documentService.manifest(userId,bookId)).scopes!.layout).toEqual(manifest.scopes!.layout);
    await expect(validation(card.id)).rejects.toMatchObject({code:'DOCUMENT_TARGET_STALE',status:409});expect((await readDocumentTraceReview(userId,bookId,sceneId))!.compareCards[0].state).toBe('stale');const operationId=randomUUID();await expect(recordBoundPreference({userId,bookId,sceneId,traceId,compareCardId:card.id,chosen:'b',applyChosen:true,operationId,expectedRevisionId:current.bookRevisionId,expectedSceneRevisionId:current.revisionId,validationId:verified.id})).rejects.toMatchObject({status:412});expect(await db().documentOperation.findUnique({where:{id:operationId}})).toBeNull();const historicalId=randomUUID();await db().documentCompareValidation.create({data:{id:historicalId,targetId:verified.targetId,userId,bookId,bookRevisionId:current.bookRevisionId,sceneRevisionId:current.revisionId,contentHash:current.contentHash,target:JSON.parse(JSON.stringify(verified.target))}});const guardedId=randomUUID();await expect(recordBoundPreference({userId,bookId,sceneId,traceId,compareCardId:card.id,chosen:'b',applyChosen:true,operationId:guardedId,expectedRevisionId:current.bookRevisionId,expectedSceneRevisionId:current.revisionId,validationId:historicalId})).rejects.toMatchObject({code:'DOCUMENT_TARGET_STALE',status:409});expect(await db().documentOperation.findUnique({where:{id:guardedId}})).toBeNull();expect(await db().proseAction.count({where:{bookId,proseCompareCardId:card.id}})).toBe(0);expect((await db().documentTraceAnalysis.findUniqueOrThrow({where:{id:analysisId}})).snapshot).toEqual(snapshot);expect(model).toHaveBeenCalledTimes(1);
  });
  test('repeated quotation chooses the supplied paragraph; attribution, styles, table and original survive; lost acknowledgement commits once', async () => {
    const { model, card } = await prepare();
    await analyzeBoundTrace(traceId, await judge()); expect(model).toHaveBeenCalledTimes(1);
    const source = await documentService.read(userId, bookId, sceneId); const verified = await validation(card.id);
    const input = { userId, bookId, sceneId, traceId, compareCardId: card.id, chosen: 'b' as const, applyChosen: true, operationId: randomUUID(), expectedRevisionId: verified.bookRevisionId, expectedSceneRevisionId: verified.sceneRevisionId, validationId: verified.id };
    const receipt = await recordBoundPreference(input);
    expect(Object.hasOwn(receipt,"scenes")).toBe(false);
    expect(receipt.sceneReferences).toHaveLength(1);
    expect(JSON.stringify(receipt).length).toBeLessThan(10000);
    const current = await documentService.read(userId, bookId, sceneId);
    expect(current.projection.text).toBe(source.projection.text.replace('room.\n\nThe repeated phrase echoes', 'room.\n\nThe repeated phrase resounds'));
    expect(projectDocument(current.document, 'original').text).toBe(source.projection.text);
    expect(current.document.blocks[0]).toEqual(source.document.blocks[0]); expect(current.document.blocks[2]).toEqual(source.document.blocks[2]);
    const target = current.document.blocks[1]; if (target.type !== 'paragraph') throw new Error('fixture'); expect(target.runs.every((run) => run.style.bold && run.style.font === 'Georgia')).toBe(true);
    expect(current.document.changes.every((change) => change.authorId === userId && change.authorName === 'Review author' && change.origin === 'ai' && change.status === 'pending')).toBe(true);
    // Another guarded commit after application must not prevent exact receipt recovery.
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: current.revisionId, document: current.document }] });
    expect(await recordBoundPreference(input)).toEqual(receipt);
    expect(await db().proseAction.count({ where: { bookId, proseCompareCardId: card.id } })).toBe(1);
    await expect(recordBoundPreference({ ...input, chosen: 'a' })).rejects.toMatchObject({ code: 'DOCUMENT_OPERATION_CONFLICT' });
  });
  test('table-cell UTF16 target preserves Unicode and container identities', async () => {
    const { card } = await prepare(2); const verified = await validation(card.id); const before = await documentService.read(userId, bookId, sceneId);
    expect(card.target?.container.cellId).toBeDefined();
    await recordBoundPreference({ userId, bookId, sceneId, traceId, compareCardId: card.id, chosen: 'b', applyChosen: true, operationId: randomUUID(), expectedRevisionId: verified.bookRevisionId, expectedSceneRevisionId: verified.sceneRevisionId, validationId: verified.id });
    const after = await documentService.read(userId, bookId, sceneId);
    expect(after.projection.text).toContain('table resounds 😀 é'); expect(after.document.blocks.slice(0,2)).toEqual(before.document.blocks.slice(0,2));
    const table = after.document.blocks[2]; const original = before.document.blocks[2]; if (table.type !== 'table' || original.type !== 'table') throw new Error('fixture'); expect(table.rows[0].cells[0].id).toBe(original.rows[0].cells[0].id);
  });
  test('unrelated edits explicitly revalidate; target formatting edits become stale without relocation', async () => {
    const { card } = await prepare(); const source = await documentService.read(userId, bookId, sceneId); const first = source.document.blocks[0]; if (first.type !== 'paragraph') throw new Error('fixture'); first.runs[0].text = 'An unrelated saved passage.';
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const verified = await validation(card.id); expect(verified.sceneRevisionId).not.toBe(source.revisionId);
    const changed = await documentService.read(userId, bookId, sceneId); const second = changed.document.blocks[1]; if (second.type !== 'paragraph') throw new Error('fixture'); second.runs[0].style.italic = true;
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: changed.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: changed.revisionId, document: changed.document }] });
    await expect(validation(card.id)).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    expect((await readDocumentTraceReview(userId, bookId, sceneId))!.compareCards[0].state).toBe('stale');
    await expect(recordBoundPreference({ userId, bookId, sceneId, traceId, compareCardId: card.id, chosen: 'b', applyChosen: true, operationId: randomUUID(), expectedRevisionId: verified.bookRevisionId, expectedSceneRevisionId: verified.sceneRevisionId, validationId: verified.id })).rejects.toMatchObject({ status: 412 });
    expect(await db().proseAction.count({ where: { bookId } })).toBe(0);
  });
  test('HTTP preference requires preconditions and revalidation; ownership and retained editorial gates still apply', async () => {
    const { card } = await prepare();
    expect((await auth(request(app).post(`/api/books/${bookId}/scenes/${sceneId}/prose/preferences`).send({ traceId, compareCardId: card.id, chosen: 'b', applyChosen: true }))).status).toBe(428);
    const verified = await validation(card.id);
    await db().proseCompareCard.update({ where: { id: card.id }, data: { optionBText: 'A completely different text.' } });
    const input = { userId, bookId, sceneId, traceId, compareCardId: card.id, chosen: 'b' as const, applyChosen: true, operationId: randomUUID(), expectedRevisionId: verified.bookRevisionId, expectedSceneRevisionId: verified.sceneRevisionId, validationId: verified.id };
    await expect(recordBoundPreference(input)).rejects.toMatchObject({ code: 'EDITORIAL_PROPOSAL_NOT_APPLICABLE' });
    expect((await db().proseCompareCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('open');
    expect(await db().proseAction.count({ where: { bookId } })).toBe(0);
    await expect(readDocumentTraceReview(userId + 100000, bookId, sceneId)).rejects.toMatchObject({ status: 404 });
    await expect(readTraceAnalysis(userId + 100000, bookId, analysisId)).rejects.toMatchObject({ status: 404 });
  });
  test('unknown provider outcomes never replay; known context and terminal failures retain distinct evidence', async () => {
    const model = jest.spyOn(SceneProseService.prototype, 'analyzeDocument').mockRejectedValue(new Error('lost acknowledgement'));
    await expect(analyzeBoundTrace(traceId, await judge())).rejects.toThrow('lost acknowledgement');
    expect((await readTraceAnalysis(userId, bookId, analysisId)).status).toBe('unknown');
    await expect(analyzeBoundTrace(traceId, await judge())).rejects.toMatchObject({ status: 409 }); expect(model).toHaveBeenCalledTimes(1);
  });
  test.each([new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'Complete context cannot fit.', 413), new InferenceTerminalError('INFERENCE_TRUNCATED','length','structured','{"partial":true}')])('known preflight/terminal failure is failed rather than unknown: %s', async (error) => {
    jest.spyOn(SceneProseService.prototype, 'analyzeDocument').mockRejectedValue(error);
    await expect(analyzeBoundTrace(traceId, await judge())).rejects.toBe(error);
    const row = await readTraceAnalysis(userId, bookId, analysisId); expect(row.status).toBe('failed');
    if (error instanceof InferenceTerminalError) expect(row.result).toMatchObject({ raw: error.partialOutput, finishReason: 'length', retainedPartialOutput: true, partialOutputBytes: Buffer.byteLength(error.partialOutput) });
  });
  test('cancellation retains late provider bytes and prevents publishing findings or replaying inference', async () => {
    let release!: (result: Awaited<ReturnType<SceneProseService['analyzeDocument']>>) => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const model = jest.spyOn(SceneProseService.prototype, 'analyzeDocument').mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const effect = analyzeBoundTrace(traceId, await judge()).catch((error: unknown) => error); await entered;
    await cancelTraceAnalysis(userId, bookId, analysisId);
    release({ raw: '{"late":true}', provenance: { providerId: 'fixture', params: {}, recipe: 'document-analysis', recipeVersion: '1.0.0' } });
    await effect;
    const row = await readTraceAnalysis(userId, bookId, analysisId); expect(row.status).toBe('cancelled'); expect(row.result).toMatchObject({ raw: '{"late":true}' });
    expect(await db().documentTraceTarget.count({ where: { bookId } })).toBe(0);
    await expect(analyzeBoundTrace(traceId, await judge())).rejects.toMatchObject({ status: 409 }); expect(model).toHaveBeenCalledTimes(1);
  });
});
