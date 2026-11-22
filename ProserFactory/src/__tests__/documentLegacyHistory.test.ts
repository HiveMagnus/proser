import { randomUUID, createHash } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { previewLegacyHistory, convertLegacyHistory } from '@/documents/legacyHistory';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';

describe('preserved legacy manuscript history conversion', () => {
  const db = () => databaseService.client;
  let userId: number; let bookId: number; let sceneId: number; let chapterId: number; let revisionId: string;
  const previousAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  beforeAll(async () => { process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; userId = (await db().user.create({ data: { githubId: `history-${randomUUID()}`, username: 'History fixture' } })).id; });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, title: 'Preserved current catalog', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Current saved prose.' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; chapterId = book.acts[0].chapters[0].id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
    revisionId = randomUUID();
    const snapshot = { scenes: [{ id: sceneId, chapterId, sceneNumber: 1, prose: '  Historical\r\nUnicode 😀é\n\n\t尾\n', summary: null, outline: 'old outline' }], codex: [] };
    await db().manuscriptRevision.create({ data: { id: revisionId, bookId, snapshot, contentHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), wordCount: 4, changedScopes: [] } });
  });
  afterEach(async () => {
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } }); await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => { await db().user.delete({ where: { id: userId } }); if (previousAuthority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previousAuthority; });
  test('preview and consented replay preserve exact originals, hashes and head without inventing lost history', async () => {
    const original = await db().manuscriptRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const before = await documentService.manifest(userId, bookId);
    const preview = await previewLegacyHistory(userId, bookId, revisionId);
    if (preview.status !== 'preview') throw new Error('fixture');
    expect(preview.report.completeDocument).toBe(false); expect(preview.report.sceneNullEvidence[0].originalNullDistinctionKnown).toBe(true);
    expect(await db().documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId: revisionId } })).toBeNull();
    await expect(convertLegacyHistory(userId, bookId, revisionId, '0'.repeat(64))).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_CONSENT_REQUIRED' });
    const converted = await convertLegacyHistory(userId, bookId, revisionId, preview.reportHash);
    expect(await convertLegacyHistory(userId, bookId, revisionId, preview.reportHash)).toBe(converted);
    expect(await db().manuscriptRevision.findUniqueOrThrow({ where: { id: revisionId } })).toEqual(original);
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(before.revisionId);
    const projected = await manuscriptRevisionService.snapshotRevision(bookId, revisionId);
    expect(projected.scenes[0].prose).toBe((original.snapshot as { scenes: Array<{ prose: string }> }).scenes[0].prose);
    await expect(manuscriptRevisionService.restore(bookId, revisionId, undefined, { userId, expectedRevisionId: before.revisionId, operationId: randomUUID() })).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_RESTORE_INCOMPLETE' });
    await expect(documentService.restore(userId, bookId, converted, before.revisionId, randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_RESTORE_INCOMPLETE' });
  });
  test('head changes require a new scaffold report before consented conversion', async () => {
    const before = await previewLegacyHistory(userId, bookId, revisionId); if (before.status !== 'preview') throw new Error('fixture');
    const source = await documentService.read(userId, bookId, sceneId); const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].style.bold = true;
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    await expect(convertLegacyHistory(userId, bookId, revisionId, before.reportHash)).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_CONSENT_REQUIRED' });
    expect(await db().documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId: revisionId } })).toBeNull();
  });
  test('unknown HTML and lost identities fail visibly without changing snapshots', async () => {
    const original = await db().manuscriptRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const snapshot = original.snapshot as { scenes: Array<{ id: number; prose: string }>; codex: [] };
    snapshot.scenes[0].prose = '<p><svg>Unsupported original</svg></p>';
    await db().manuscriptRevision.update({ where: { id: revisionId }, data: { snapshot } });
    await expect(previewLegacyHistory(userId, bookId, revisionId)).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_HTML_UNSUPPORTED' });
    snapshot.scenes[0].prose = 'plain'; snapshot.scenes[0].id = 99999999;
    await db().manuscriptRevision.update({ where: { id: revisionId }, data: { snapshot } });
    await expect(previewLegacyHistory(userId, bookId, revisionId)).rejects.toMatchObject({ code: 'DOCUMENT_LEGACY_HISTORY_IDENTITIES_MISSING' });
    await expect(previewLegacyHistory(userId + 999999, bookId, revisionId)).rejects.toThrow('Book not found');
    expect(await db().documentLegacyRevisionMapping.findUnique({ where: { legacyRevisionId: revisionId } })).toBeNull();
  });
});
