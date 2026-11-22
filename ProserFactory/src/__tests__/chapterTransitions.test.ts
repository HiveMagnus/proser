import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { readChapterTransitions, verifyTransitionOutput } from '@/documents/chapterTransitions';
import { createDocumentDiscussion, requestDocumentProposal, revalidateDocumentProposal, applyDocumentProposal } from '@/documents/proposals';
import { documentProposalPrompt } from '@/documents/proposalPrompt';
import { SceneProseService } from '@/services/sceneProseService';
import { projectDocument } from '@/documents/model';
import type { DocumentDiscussionSnapshot } from '@/documents/proposal-model';

describe('saved chapter transitions', () => {
  const db = () => databaseService.client;
  let userId: number, bookId: number, githubId: string;
  const original = process.env.DOCUMENT_AUTHORITY_ENABLED;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true';
    githubId = `transition-test-${randomUUID()}`;
    userId = (await db().user.create({ data: { githubId, username: 'Transition author' } })).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Boundary source', acts: { create: [
      { actNumber: 2, chapters: { create: [1, 2].map(n => ({ chapterNumber: n, title: `Second act ${n}`, scenes: { create: { sceneNumber: 1, prose: `Second act opening ${n}.\n\nSecond act ending ${n}.` } } })) } },
      { actNumber: 1, chapters: { create: [1, 2].map(n => ({ chapterNumber: n, title: `First act ${n}`, scenes: { create: [{ sceneNumber: 1, prose: `First act opening ${n}.` }, { sceneNumber: 2, prose: `Earlier ${n}.\n\n${'Long interior. '.repeat(200)}\n\nActual final ${n} 😀` }] } })) } }
    ] } } });
    bookId = book.id;
    await documentService.initialize(userId, bookId);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // Retain immutable test receipts and history in the disposable test database.
    const head = await documentService.manifest(userId, bookId);
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { structure: head.scopes!.structure.revisionId }, payload: { fixture: 'retire-transition-test' } }, async tx => ({ result: await tx.book.update({ where: { id: bookId }, data: { deletedAt: new Date() } }) }));
  });
  afterAll(() => { if (original === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = original; });
  test('three boundaries follow act/chapter/scene order and include literal final Unicode text', async () => {
    const batch = await readChapterTransitions(userId, bookId);
    expect(batch.transitions).toHaveLength(3);
    expect(batch.transitions.map(t => [t.ending.label, t.opening.label])).toEqual([
      ['Act 1 · Chapter 1: First act 1', 'Act 1 · Chapter 2: First act 2'],
      ['Act 1 · Chapter 2: First act 2', 'Act 2 · Chapter 1: Second act 1'],
      ['Act 2 · Chapter 1: Second act 1', 'Act 2 · Chapter 2: Second act 2']
    ]);
    expect(batch.transitions[0].ending.text.endsWith('Actual final 1 😀')).toBe(true);
    expect(batch.transitions[0].ending.truncated).toBe(true);
    expect(batch.transitions[0].opening.text).toBe('First act opening 2.');
    expect(batch.transitions[0].opening.target?.sourceText).toBe('First act opening 2.');
  });
  test('empty edge scenes are disclosed without substituting previous prose and ownership is enforced', async () => {
    const batch = await readChapterTransitions(userId, bookId), first = batch.transitions[0];
    const source = await documentService.read(userId, bookId, first.ending.sceneId!);
    source.document.blocks = [];
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: source.sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    expect((await readChapterTransitions(userId, bookId)).transitions[0].ending.text).toBe('');
    await expect(readChapterTransitions(userId + 10000, bookId)).rejects.toMatchObject({ status: 404 });
    const response = await request(app).get(`/api/books/${bookId}/chapter-transitions`).set('x-user-id', String(userId)).set('x-github-id', githubId).set('x-username', 'Transition author');
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
  });
  test('long single-paragraph scenes offer a literal sentence target without changing paragraph boundaries', async () => {
    const initial = (await readChapterTransitions(userId, bookId)).transitions[0];
    const source = await documentService.read(userId, bookId, initial.opening.sceneId!);
    const block = source.document.blocks[0]; if (block.type !== 'paragraph') throw new Error('fixture');
    block.runs[0].text = 'The phone rang at 2:14 p.m., cutting through the room. ' + 'Later sentence. '.repeat(120);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: source.sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const transition = (await readChapterTransitions(userId, bookId)).transitions[0], target = transition.opening.target!;
    expect(target.sourceText).toBe('The phone rang at 2:14 p.m., cutting through the room.');
    const discussion = await createDocumentDiscussion(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId: source.sceneId, expectedRevisionId: transition.bookRevisionId, expectedSceneRevisionId: transition.opening.sceneRevisionId, expectedContentHash: transition.opening.contentHash, projection: 'final', targets: [target], transitionChapterId: transition.ending.chapterId });
    const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
    expect(snapshot.targets[0].paragraphText).toBe(block.runs[0].text);
    expect((await documentService.read(userId, bookId, source.sceneId)).document.blocks).toEqual(source.document.blocks);
  });
  test('opening sentence targets preserve titles in proper names rather than stopping at St.', async () => {
    const initial = (await readChapterTransitions(userId, bookId)).transitions[0];
    const source = await documentService.read(userId, bookId, initial.opening.sceneId!);
    const block = source.document.blocks[0]; if (block.type !== 'paragraph') throw new Error('fixture');
    block.runs[0].text = "The fluorescent lights in the basement of St. Jude’s hummed beneath Marcus’s shoes. " + 'Later sentence. '.repeat(120);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: source.sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    const target = (await readChapterTransitions(userId, bookId)).transitions[0].opening.target!;
    expect(target.sourceText).toBe('The fluorescent lights in the basement of St. Jude’s hummed beneath Marcus’s shoes.');
  });
  test('rejects a forged opening target and oversized or incomplete review output', async () => {
    const transition = (await readChapterTransitions(userId, bookId)).transitions[0], edge = transition.opening;
    const input = { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId: edge.sceneId, expectedRevisionId: transition.bookRevisionId, expectedSceneRevisionId: edge.sceneRevisionId, expectedContentHash: edge.contentHash, projection: 'final', targets: [{ ...edge.target, sourceText: 'Invented opening.' }], transitionChapterId: transition.ending.chapterId };
    await expect(createDocumentDiscussion(userId, bookId, input)).rejects.toMatchObject({ code: 'DOCUMENT_TRANSITION_INVALID' });
    expect(await db().documentDiscussion.findUnique({ where: { id: input.operationId } })).toBeNull();
    const target = { ...edge.target!, targetId: randomUUID(), paragraphText: edge.target!.sourceText, formatHash: 'hash', objectHash: 'hash', runIds: [], container: {}, editable: true };
    const snapshot = { transition, targets: [target] };
    expect(() => verifyTransitionOutput(snapshot, { reply: 'Continuity: Same time. Momentum: Moves. Reason to keep reading: Urgency.', edits: [{ targetId: target.targetId, sourceText: target.sourceText, replacement: 'X'.repeat(601) }] })).toThrow('edit budget');
    expect(() => verifyTransitionOutput(snapshot, { reply: 'Generic praise.', edits: [{ targetId: target.targetId, sourceText: target.sourceText, replacement: 'A small revision.' }] })).toThrow('continuity');
  });
  test('provider receives both frozen boundaries; predecessor edits invalidate revalidation and guarded apply without replay', async () => {
    const transition = (await readChapterTransitions(userId, bookId)).transitions[0], edge = transition.opening;
    const discussion = await createDocumentDiscussion(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), sessionId: randomUUID(), sceneId: edge.sceneId, expectedRevisionId: transition.bookRevisionId, expectedSceneRevisionId: edge.sceneRevisionId, expectedContentHash: edge.contentHash, projection: 'final', targets: [edge.target], transitionChapterId: transition.ending.chapterId });
    const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
    expect(snapshot.transition).toEqual(transition);
    expect(documentProposalPrompt(snapshot, 'Review.')).toContain('Actual final 1 😀');
    const inference = jest.spyOn(SceneProseService.prototype, 'proposeDocumentEdits').mockImplementation(async s => ({ raw: JSON.stringify({ reply: 'Continuity: Unresolved arrival.\nMomentum: Carries the threat.\nReason to keep reading: Who is waiting?', edits: [{ targetId: s.targets[0].targetId, sourceText: s.targets[0].sourceText, replacement: s.targets[0].sourceText.replace('opening', 'urgent opening') }] }), provenance: { providerId: 'test-only', params: {}, recipe: 'document-proposal', recipeVersion: s.templateVersion } }));
    const input = { operationId: randomUUID(), instruction: 'Review both edges.' };
    const proposal = await requestDocumentProposal(userId, bookId, discussion.id, input);
    expect(proposal.status).toBe('ready');
    expect((await requestDocumentProposal(userId, bookId, discussion.id, input)).id).toBe(proposal.id);
    const validated = await revalidateDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: transition.bookRevisionId, expectedSceneRevisionId: edge.sceneRevisionId });
    const ending = await documentService.read(userId, bookId, transition.ending.sceneId!);
    const block = ending.document.blocks[0]; if (block.type !== 'paragraph') throw new Error('fixture'); block.runs[0].text += ' Changed ending context.';
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: ending.bookRevisionId, scenes: [{ sceneId: ending.sceneId, expectedRevisionId: ending.revisionId, document: ending.document }] });
    const current = await documentService.read(userId, bookId, edge.sceneId!);
    await expect(revalidateDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, expectedSceneRevisionId: current.revisionId })).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    await expect(applyDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: transition.bookRevisionId, expectedSceneRevisionId: edge.sceneRevisionId, validationId: validated.id, targetIds: [snapshot.targets[0].targetId] })).rejects.toMatchObject({ status: 412 });
    // Even a validation record for the new opening revision cannot erase the
    // original predecessor binding; application independently checks the book.
    const historicalId = randomUUID();
    await db().documentProposalValidation.create({ data: { id: historicalId, proposalId: proposal.id, bookId, userId, bookRevisionId: current.bookRevisionId, sceneRevisionId: current.revisionId, contentHash: current.contentHash, targets: JSON.parse(JSON.stringify(snapshot.targets)) } });
    await expect(applyDocumentProposal(userId, bookId, proposal.id, { operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, expectedSceneRevisionId: current.revisionId, validationId: historicalId, targetIds: [snapshot.targets[0].targetId] })).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_STALE' });
    expect(inference).toHaveBeenCalledTimes(1);
    expect(projectDocument(current.document).text).toBe(edge.text);
  });
});
