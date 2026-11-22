import { randomUUID } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText, type ProserDocument } from '@/documents/model';
import { reviewStateAtRevision } from '@/documents/reviewState';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';
import { workflowService } from '@/services/workflowService';

describe('revision-bound resolved review publication gate', () => {
  const db = () => databaseService.client; const old = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let bookId: number; let sceneId: number; let runId: string;
  beforeAll(async () => { process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; userId = (await db().user.create({ data: { githubId: `release-review-${randomUUID()}`, username: 'Release reviewer' } })).id; });
  beforeEach(async () => { const book = await db().book.create({ data: { userId, acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Release body.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } }); bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id; await documentService.initialize(userId, bookId); runId = randomUUID(); await db().workflowRun.create({ data: { id: runId, bookId, userId, workflowType: 'full_book', status: 'running', settings: {}, idempotencyKey: randomUUID() } }); });
  afterEach(async () => { await db().workflowRun.deleteMany({ where: { bookId } }); await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } }); await db().book.delete({ where: { id: bookId } }); });
  afterAll(async () => { if (old === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = old; await db().user.delete({ where: { id: userId } }); });
  const review = (document: ProserDocument) => {
    const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); const changeId = randomUUID(); paragraph.runs[0].changeId = changeId;
    document.changes.push({ id: changeId, kind: 'insertion', status: 'pending', origin: 'manual', authorId: 0, authorName: 'Untrusted', createdAt: '2000-01-01T00:00:00.000Z', targetRunIds: [paragraph.runs[0].id] });
    document.comments.push({ id: randomUUID(), authorId: 0, authorName: 'Untrusted', createdAt: '2000-01-01T00:00:00.000Z', text: 'Resolve before release', resolved: false, anchors: [{ blockId: paragraph.id, runId: paragraph.runs[0].id, start: 0, end: 1, sourceText: paragraph.runs[0].text.slice(0, 1) }] }); return document;
  };
  const gates = (revisionId: string) => (workflowService as unknown as { releaseGates: (runId: string, revisionId: string, targetWords: number, exports: boolean) => Promise<{ gates: Array<{ gate: string; pass: boolean; evidence: unknown }> }> }).releaseGates(runId, revisionId, 2, true);
  test('body and all four owned story kinds block release; resolution never changes historical gate evidence', async () => {
    const emptyRevision = await manuscriptRevisionService.capture(bookId); const source = await documentService.read(userId, bookId, sceneId);
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: review(source.document) }] });
    const layout = await documentService.scope(userId, bookId, 'layout'); layout.content.frontMatter = [{ id: randomUUID(), name: 'Foreword', document: review(documentFromText('Foreword', randomUUID)) }]; layout.content.backMatter = [{ id: randomUUID(), name: 'Afterword', document: review(documentFromText('Afterword', randomUUID)) }]; layout.content.headerFooterStories = (['header', 'footer'] as const).map((kind) => ({ id: randomUUID(), owner: 'book', kind, document: review(documentFromText(kind, randomUUID)) }));
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: layout.bookRevisionId, expectedScopes: { layout: layout.revisionId }, payload: { layout: layout.content } }, async () => ({ result: null, layout: layout.content }));
    const pendingRevision = await manuscriptRevisionService.capture(bookId); const pending = await reviewStateAtRevision(userId, bookId, pendingRevision); expect(pending).toMatchObject({ pendingChanges: 5, unresolvedComments: 5 }); expect((await gates(pendingRevision)).gates.find((gate) => gate.gate === 'resolved_document_review')?.pass).toBe(false); expect(await reviewStateAtRevision(userId, bookId, emptyRevision)).toMatchObject({ pendingChanges: 0, unresolvedComments: 0 });
    const resolve = (document: ProserDocument) => { document.changes.forEach((change) => { change.status = 'accepted'; }); document.comments.forEach((comment) => { comment.resolved = true; }); };
    const current = await documentService.read(userId, bookId, sceneId); resolve(current.document); await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: current.revisionId, document: current.document }] });
    const latest = await documentService.scope(userId, bookId, 'layout'); [...latest.content.frontMatter, ...latest.content.backMatter, ...latest.content.headerFooterStories!].forEach((story) => resolve(story.document)); await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: latest.bookRevisionId, expectedScopes: { layout: latest.revisionId }, payload: { layout: latest.content } }, async () => ({ result: null, layout: latest.content }));
    const resolvedRevision = await manuscriptRevisionService.capture(bookId); expect(await reviewStateAtRevision(userId, bookId, resolvedRevision)).toMatchObject({ pendingChanges: 0, unresolvedComments: 0 }); expect((await gates(resolvedRevision)).gates.find((gate) => gate.gate === 'resolved_document_review')?.pass).toBe(true); expect(await reviewStateAtRevision(userId, bookId, pendingRevision)).toEqual(pending);
  });
  test('foreign ownership and incomplete historical mappings fail before approval', async () => {
    const revision = await manuscriptRevisionService.capture(bookId); await expect(reviewStateAtRevision(userId + 99999, bookId, revision)).rejects.toMatchObject({ status: 404 });
    const legacyId = randomUUID(); await db().documentLegacyRevisionMapping.create({ data: { legacyRevisionId: legacyId, bookId, documentRevisionId: revision, legacyContentHash: '0'.repeat(64), fidelity: { completeDocument: false } } }); await expect(reviewStateAtRevision(userId, bookId, legacyId)).rejects.toMatchObject({ code: 'DOCUMENT_REVIEW_SOURCE_INCOMPLETE', status: 409 });
  });
});
