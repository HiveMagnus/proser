import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { documentService, type CatalogPreconditions } from '@/documents/service';
import { documentFromText, canonicalDocument } from '@/documents/model';
import type { BookLayoutSnapshot } from '@/documents/scope-model';

describe('complete immutable book scopes', () => {
  let db: PrismaClient; let userId: number; let bookId: number; let sceneId: number; let chapterId: number; let actId: number; let codexId: number; let usageId: number;
  beforeAll(async () => {
    db = databaseService.client;
    const user = await db.user.create({ data: { githubId: `jest-document-scopes-${randomUUID()}`, username: 'Scope author' } }); userId = user.id;
    const book = await db.book.create({ data: { userId, title: 'Scope fixture original', summary: 'Original canon and structure', acts: { create: { actNumber: 1, title: 'Original act', chapters: { create: { chapterNumber: 1, title: 'Original chapter', scenes: { create: { sceneNumber: 1, prose: 'Original 😀', summary: 'Original scene', beatsMeta: Prisma.JsonNull } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; actId = book.acts[0].id; chapterId = book.acts[0].chapters[0].id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    const entry = await db.codexEntry.create({ data: { bookId, entryType: 'character', entryName: 'Original protagonist', attributes: '{"unicode":"é"}' } }); codexId = entry.id;
    const usage = await db.sceneCodexUsage.create({ data: { sceneId, codexId, rationale: 'Original linkage' } }); usageId = usage.id;
    await documentService.initialize(userId, bookId);
  });
  afterAll(async () => {
    await db.documentOperation.deleteMany({ where: { bookId } }); await db.bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db.documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db.bookDocumentRevision.deleteMany({ where: { bookId } });
    await db.sceneDocumentRevision.deleteMany({ where: { bookId } }); await db.bookDocumentHead.deleteMany({ where: { bookId } });
    await db.book.delete({ where: { id: bookId } }); await db.user.delete({ where: { id: userId } });
  });
  const conditions = async (payload: unknown): Promise<CatalogPreconditions> => {
    const manifest = await documentService.manifest(userId, bookId);
    return { operationId: randomUUID(), expectedRevisionId: manifest.revisionId, expectedScopes: { structure: manifest.scopes!.structure.revisionId, canon: manifest.scopes!.canon.revisionId, layout: manifest.scopes!.layout.revisionId }, payload };
  };
  test('scene layout snapshots are read-only and rejected saves leave the head and projection unchanged', async () => {
    const before = await documentService.read(userId, bookId, sceneId);
    const changed = structuredClone(before.document); changed.layout.fontSize += 1;
    const operationId = randomUUID();
    await expect(documentService.commit(userId, bookId, { schemaVersion: 1, operationId, expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document: changed }] })).rejects.toMatchObject({ code: 'DOCUMENT_LAYOUT_SCOPE_REQUIRED', status: 409 });
    expect(await db.documentOperation.findUnique({ where: { id: operationId } })).toBeNull();
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(before.document);
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(before.bookRevisionId);
  });
  test('scene editing reuses immutable structure/canon/layout references instead of rewriting the catalogs', async () => {
    const before = await documentService.read(userId, bookId, sceneId);
    const manifest = await documentService.manifest(userId, bookId);
    const scopeCount = await db.bookDocumentScopeRevision.count({ where: { bookId } });
    const document = structuredClone(before.document); const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0].style = { bold: true, color: '#123456' };
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document }] });
    expect((await documentService.manifest(userId, bookId)).scopes).toEqual(manifest.scopes);
    expect(await db.bookDocumentScopeRevision.count({ where: { bookId } })).toBe(scopeCount);
    expect((await documentService.scope(userId, bookId, 'canon')).content.usages[0].id).toBe(usageId);
    await expect(documentService.scope(userId + 100000, bookId, 'layout')).rejects.toThrow('Book not found');
  });
  test('book layout changes persist styles, section stories and authenticated review attribution without rewriting bodies', async () => {
    const source = await documentService.scope(userId, bookId, 'layout');
    const layout: BookLayoutSnapshot = structuredClone(source.content);
    layout.book.margins = [90, 80, 90, 80]; layout.chapters[String(chapterId)] = { ...layout.book, header: [] };
    layout.styles.paragraph.Submission = { lineSpacing: 2, firstLineIndent: 48 };
    const story = documentFromText('A foreword', randomUUID); const block = story.blocks[0]; if (block.type !== 'paragraph') throw new Error('fixture');
    const changeId = randomUUID(); block.runs[0].changeId = changeId;
    story.changes.push({ id: changeId, kind: 'insertion', status: 'pending', origin: 'import', importedAuthor: 'Forged imported identity', authorId: 99999, authorName: 'Forged', createdAt: '2000-01-01T00:00:00.000Z', targetRunIds: [block.runs[0].id] });
    layout.frontMatter.push({ id: randomUUID(), name: 'Foreword', document: story });
    const input = await conditions({ layout });
    const sceneCount = await db.sceneDocumentRevision.count({ where: { bookId } });
    const receipt = await documentService.mutateCatalog(userId, bookId, input, async () => ({ result: 'layout', layout }));
    expect(await documentService.mutateCatalog(userId, bookId, input, async () => { throw new Error('Idempotent callback must never run again'); })).toEqual(receipt);
    const saved = await documentService.scope(userId, bookId, 'layout');
    expect(saved.content.book.margins).toEqual([90, 80, 90, 80]);
    expect(saved.content.styles.paragraph.Submission.lineSpacing).toBe(2);
    expect(saved.content.frontMatter[0].document.changes[0]).toMatchObject({ authorId: userId, authorName: 'Scope author', origin: 'manual' });
    expect(saved.content.frontMatter[0].document.changes[0].importedAuthor).toBeUndefined();
    expect(await db.sceneDocumentRevision.count({ where: { bookId } })).toBe(sceneCount);
    await expect(documentService.mutateCatalog(userId, bookId, { ...input, operationId: randomUUID() }, async () => ({ result: 'stale', layout }))).rejects.toMatchObject({ status: 412 });
  });
  test('restoration returns body, structure, canon, layout, review and stable usage IDs; newer resources become tombstones', async () => {
    const target = await documentService.manifest(userId, bookId);
    const targetBody = await documentService.read(userId, bookId, sceneId);
    const targetStructure = await documentService.scope(userId, bookId, 'structure');
    const targetCanon = await documentService.scope(userId, bookId, 'canon');
    const targetLayout = await documentService.scope(userId, bookId, 'layout');
    const changedLayout = structuredClone(targetLayout.content); changedLayout.book.fontSize = 24; changedLayout.frontMatter[0].name = 'Changed foreword title';
    const input = await conditions({ operation: 'change all scopes' });
    const receipt = await documentService.mutateCatalog(userId, bookId, input, async (tx) => {
      await tx.book.update({ where: { id: bookId }, data: { title: 'Changed book' } });
      await tx.act.update({ where: { id: actId }, data: { title: 'Changed act' } });
      await tx.scene.update({ where: { id: sceneId }, data: { summary: 'Changed summary', beatsMeta: Prisma.DbNull } });
      await tx.codexEntry.update({ where: { id: codexId }, data: { entryName: 'Changed protagonist', deletedAt: new Date() } });
      await tx.sceneCodexUsage.update({ where: { id: usageId }, data: { rationale: 'Changed usage' } });
      const act = await tx.act.create({ data: { bookId, actNumber: 2, title: 'New act' } });
      const chapter = await tx.chapter.create({ data: { actId: act.id, chapterNumber: 1, title: 'New chapter' } });
      const scene = await tx.scene.create({ data: { chapterId: chapter.id, sceneNumber: 1, summary: 'New scene' } });
      const entry = await tx.codexEntry.create({ data: { bookId, entryType: 'location', entryName: 'New location' } });
      return { result: { actId: act.id, chapterId: chapter.id, sceneId: scene.id, codexId: entry.id }, layout: changedLayout };
    });
    const current = await documentService.read(userId, bookId, sceneId);
    const body = documentFromText('A later body', randomUUID);
    const changedBody = await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: current.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: current.revisionId, document: body }] });
    const restoreId = randomUUID();
    const restored = await documentService.restore(userId, bookId, target.revisionId, changedBody.revisionId, restoreId);
    expect(await documentService.restore(userId, bookId, target.revisionId, changedBody.revisionId, restoreId)).toEqual(restored);
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(targetBody.document);
    expect((await documentService.scope(userId, bookId, 'structure')).content).toEqual(targetStructure.content);
    expect((await documentService.scope(userId, bookId, 'canon')).content).toEqual(targetCanon.content);
    expect((await documentService.scope(userId, bookId, 'layout')).content).toEqual(targetLayout.content);
    expect((await db.act.findUniqueOrThrow({ where: { id: receipt.result.actId } })).deletedAt).not.toBeNull();
    expect((await db.chapter.findUniqueOrThrow({ where: { id: receipt.result.chapterId } })).deletedAt).not.toBeNull();
    expect((await db.scene.findUniqueOrThrow({ where: { id: receipt.result.sceneId } })).deletedAt).not.toBeNull();
    expect((await db.codexEntry.findUniqueOrThrow({ where: { id: receipt.result.codexId } })).deletedAt).not.toBeNull();
    expect((await db.sceneCodexUsage.findUniqueOrThrow({ where: { id: usageId } })).rationale).toBe('Original linkage');
    const sqlNull = await db.$queryRaw<Array<{ isNull: boolean }>>`SELECT (beats_meta IS NULL) AS "isNull" FROM scenes WHERE id = ${sceneId}`;
    expect(sqlNull[0].isNull).toBe(false); // JSON null is restored distinctly from SQL NULL.
    expect(canonicalDocument((await db.sceneDocumentRevision.findUniqueOrThrow({ where: { id: changedBody.scenes[0].revisionId } })).document)).toBe(canonicalDocument(body));
    await expect(documentService.restore(userId, bookId, target.revisionId, changedBody.revisionId, randomUUID())).rejects.toMatchObject({ status: 412 });
    // Future tombstones must neither block ordinary edits nor silently become
    // canonical membership again after a restoration.
    const afterRestore = await documentService.manifest(userId, bookId);
    const anotherLayout = structuredClone(targetLayout.content); anotherLayout.book.pageNumbers = !anotherLayout.book.pageNumbers;
    await documentService.mutateCatalog(userId, bookId, { operationId: randomUUID(), expectedRevisionId: afterRestore.revisionId, expectedScopes: { layout: afterRestore.scopes!.layout.revisionId }, payload: { layout: anotherLayout } }, async () => ({ result: null, layout: anotherLayout }));
    expect((await documentService.scope(userId, bookId, 'structure')).content).toEqual(targetStructure.content);
    expect((await documentService.manifest(userId, bookId)).scenes.map((reference) => reference.sceneId)).not.toContain(receipt.result.sceneId);
  });
  test('soft deletion uses the transaction client and cannot escape rollback', async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.scene.delete({ where: { id: sceneId } });
      await tx.codexEntry.deleteMany({ where: { id: codexId } });
      throw new Error('Cancel all writes');
    })).rejects.toThrow('Cancel all writes');
    expect((await db.scene.findUniqueOrThrow({ where: { id: sceneId } })).deletedAt).toBeNull();
    expect((await db.codexEntry.findUniqueOrThrow({ where: { id: codexId } })).deletedAt).toBeNull();
  });
  test('an unguarded changed scope or hard deletion rolls back catalog writes and its receipt', async () => {
    const manifest = await documentService.manifest(userId, bookId); const original = await db.book.findUniqueOrThrow({ where: { id: bookId } });
    const operationId = randomUUID();
    await expect(documentService.mutateCatalog(userId, bookId, { operationId, expectedRevisionId: manifest.revisionId, expectedScopes: { layout: manifest.scopes!.layout.revisionId }, payload: { title: 'Must roll back' } }, async (tx) => { await tx.book.update({ where: { id: bookId }, data: { title: 'Must roll back' } }); return { result: null }; })).rejects.toMatchObject({ status: 428 });
    expect((await db.book.findUniqueOrThrow({ where: { id: bookId } })).title).toBe(original.title);
    expect(await db.documentOperation.findUnique({ where: { id: operationId } })).toBeNull();
    await expect(documentService.mutateCatalog(userId, bookId, await conditions({ delete: sceneId }), async (tx) => { await tx.$executeRaw`DELETE FROM scenes WHERE id = ${sceneId}`; return { result: null }; })).rejects.toMatchObject({ code: 'DOCUMENT_HARD_DELETE_FORBIDDEN' });
    expect(await db.scene.findUnique({ where: { id: sceneId } })).not.toBeNull();
  });
});
