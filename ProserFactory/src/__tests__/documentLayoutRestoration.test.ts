import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText } from '@/documents/model';
import type { BookLayoutSnapshot, DocumentLayoutCommitInput } from '@/documents/scope-model';

describe('exact complete owned layout journal restoration', () => {
  const db = () => databaseService.client; const oldAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  let userId: number; let githubId: string; let bookId: number; let sceneId: number;
  beforeAll(async () => { process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; githubId = `layout-restore-${randomUUID()}`; userId = (await db().user.create({ data: { githubId, username: 'Layout restorer' } })).id; });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Scene body stays exact.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } }); bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id; await documentService.initialize(userId, bookId);
  });
  afterEach(async () => { await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } }); await db().imageAsset.deleteMany({ where: { bookId } }); await db().book.delete({ where: { id: bookId } }); });
  afterAll(async () => { if (oldAuthority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = oldAuthority; await db().user.delete({ where: { id: userId } }); });
  const auth = (call: request.Test) => call.set('x-user-id', String(userId)).set('x-github-id', githubId);
  const input = async (layout: BookLayoutSnapshot, restoreFromRevisionId?: string): Promise<DocumentLayoutCommitInput> => { const source = await documentService.scope(userId, bookId, 'layout'); return { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, expectedScopes: { layout: source.revisionId }, layout, ...(restoreFromRevisionId ? { restoreFromRevisionId } : {}) }; };
  const post = (body: DocumentLayoutCommitInput) => auth(request(app).post(`/api/books/${bookId}/document-layout-commits`)).send(body);
  test('restoration returns pending review, original attribution and layout while preserving scene bodies and later immutable history', async () => {
    const source = await documentService.scope(userId, bookId, 'layout'); const document = documentFromText('A retained header', randomUUID); const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    const changeId = randomUUID(); paragraph.runs[0].changeId = changeId; paragraph.runs[0].style = { bold: true };
    document.changes.push({ id: changeId, kind: 'insertion', status: 'pending', origin: 'manual', authorId: 0, authorName: 'Untrusted', createdAt: '2000-01-01T00:00:00.000Z', targetRunIds: [paragraph.runs[0].id] });
    document.comments.push({ id: randomUUID(), authorId: 0, authorName: 'Untrusted', createdAt: '2000-01-01T00:00:00.000Z', text: 'Header review', resolved: false, anchors: [{ blockId: paragraph.id, runId: paragraph.runs[0].id, start: 0, end: 1, sourceText: 'A' }] });
    source.content.headerFooterStories = [{ id: randomUUID(), owner: 'book', kind: 'header', document }]; expect((await post(await input(source.content))).status).toBe(200);
    const target = await documentService.scope(userId, bookId, 'layout'); const body = await documentService.read(userId, bookId, sceneId); const changed = structuredClone(target.content); changed.book.margins = [80, 90, 80, 90]; changed.headerFooterStories![0].document.changes[0].status = 'accepted'; changed.headerFooterStories![0].document.comments[0].resolved = true;
    expect((await post(await input(changed))).status).toBe(200); const later = await documentService.scope(userId, bookId, 'layout');
    const restoration = await input(target.content, target.revisionId); const response = await post(restoration); expect(response.status).toBe(200); expect(response.body.data.result).toMatchObject({ changedScope: 'layout', restoredFromLayoutRevisionId: target.revisionId });
    const restored = await documentService.scope(userId, bookId, 'layout'); expect(restored.content).toEqual(target.content); expect(restored.revisionId).not.toBe(target.revisionId); expect(restored.revisionId).not.toBe(later.revisionId);
    expect((await documentService.read(userId, bookId, sceneId)).revisionId).toBe(body.revisionId);
    expect((await documentService.layoutRevision(userId, bookId, later.revisionId)).content).toEqual(later.content); expect((await post(restoration)).body.data).toEqual(response.body.data);
    const audit = await db().auditLog.findFirst({ where: { userId, entityId: bookId, metadata: { path: ['operationId'], equals: restoration.operationId } } }); expect(audit?.metadata).toMatchObject({ action: 'restore-document-layout-scope', restoredFromLayoutRevisionId: target.revisionId, revisionId: response.body.data.revisionId });
    const exact = await auth(request(app).get(`/api/books/${bookId}/document-layout-revisions/${target.revisionId}`)); expect(exact.status).toBe(200); expect(exact.body.data).toMatchObject({ revisionId: target.revisionId, contentHash: target.contentHash, content: target.content }); expect(exact.body.data.bookRevisionId).toBeUndefined();
  });
  test('forged content, unavailable sources, stale book/scope refs and incomplete history cannot authorize restoration', async () => {
    const target = await documentService.scope(userId, bookId, 'layout'); const forged = structuredClone(target.content); forged.book.fontSize += 1;
    const invalid = await input(forged, target.revisionId); expect((await post(invalid)).status).toBe(409); expect(await db().documentOperation.findUnique({ where: { id: invalid.operationId } })).toBeNull();
    expect((await post(await input(target.content, randomUUID()))).status).toBe(409);
    const changed = structuredClone(target.content); changed.book.margins = [80, 80, 80, 80]; expect((await post(await input(changed))).status).toBe(200);
    expect((await post({ ...invalid, operationId: randomUUID(), layout: target.content })).status).toBe(412);
    const current = await input(target.content, target.revisionId); expect((await post({ ...current, expectedScopes: { layout: randomUUID() } })).status).toBe(412);
    await db().documentLegacyRevisionMapping.create({ data: { legacyRevisionId: randomUUID(), bookId, documentRevisionId: target.bookRevisionId, legacyContentHash: '0'.repeat(64), fidelity: { completeDocument: false } } });
    const incomplete = await post(current); expect(incomplete.status).toBe(409); expect(incomplete.body.error.code).toBe('DOCUMENT_RESTORATION_INCOMPLETE');
    const missing = await auth(request(app).post(`/api/books/${bookId}/document-layout-commits`)).send({ schemaVersion: 1, layout: target.content }); expect(missing.status).toBe(428);
    const foreign = await request(app).get(`/api/books/${bookId}/document-layout-revisions/${target.revisionId}`).set('x-user-id', String(userId + 99999)).set('x-github-id', 'foreign-layout-owner'); expect(foreign.status).toBeGreaterThanOrEqual(400);
  });
  test('a complete restoration still verifies owned immutable story assets before moving the head', async () => {
    const source = await documentService.scope(userId, bookId, 'layout'); const asset = await db().imageAsset.create({ data: { userId, bookId, name: 'layout-restoration-fixture.png', url: '/images/layout-restoration-fixture.png', configJson: JSON.stringify({ sha256: 'a'.repeat(64) }) } });
    const document = documentFromText('', randomUUID); document.blocks.push({ type: 'image', id: randomUUID(), assetId: asset.id, sha256: 'a'.repeat(64), alt: 'Retained image', width: 20, height: 20 }); source.content.headerFooterStories = [{ id: randomUUID(), owner: 'book', kind: 'footer', document }]; expect((await post(await input(source.content))).status).toBe(200);
    const target = await documentService.scope(userId, bookId, 'layout'); const empty = structuredClone(target.content); empty.headerFooterStories = []; expect((await post(await input(empty))).status).toBe(200);
    // Simulate storage loss outside the document boundary in this isolated DB.
    await db().imageAsset.delete({ where: { id: asset.id } }); const before = await documentService.manifest(userId, bookId);
    expect((await post(await input(target.content, target.revisionId))).status).toBeGreaterThanOrEqual(400); expect((await documentService.manifest(userId, bookId)).revisionId).toBe(before.revisionId);
  });
});
