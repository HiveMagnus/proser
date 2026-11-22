import { randomUUID } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText, type DocumentAnchorLineage } from '@/documents/model';

describe('atomic scene block and review transfer', () => {
  const db = () => databaseService.client;
  let userId: number; let bookId: number; let firstId: number; let secondId: number;
  beforeAll(async () => { userId = (await db().user.create({ data: { githubId: `scope-transfer-${randomUUID()}`, username: 'Authenticated mover' } })).id; });
  beforeEach(async () => {
    const book = await db().book.create({ data: { userId, acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: [{ sceneNumber: 1, prose: 'Move 😀 é.' }, { sceneNumber: 2, prose: 'Keep destination.' }] } } } } } }, include: { acts: { include: { chapters: { include: { scenes: { orderBy: { sceneNumber: 'asc' } } } } } } } });
    bookId = book.id; [firstId,secondId] = book.acts[0].chapters[0].scenes.map((scene) => scene.id);
    await documentService.initialize(userId,bookId);
    const source = await documentService.read(userId,bookId,firstId); const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    const id = randomUUID(); paragraph.runs[0].changeId = id; paragraph.runs[0].style = { bold: true, font: 'Georgia' };
    source.document.changes.push({ id, kind: 'insertion', status: 'pending', origin: 'manual', authorId: 0, authorName: 'Untrusted input', createdAt: new Date().toISOString(), targetRunIds: [paragraph.runs[0].id] });
    source.document.comments.push({ id: randomUUID(), authorId: 0, authorName: 'Untrusted input', createdAt: new Date().toISOString(), text: 'Retain anchored comment.', resolved: false, anchors: [{ blockId: paragraph.id, runId: paragraph.runs[0].id, start: 0, end: paragraph.runs[0].text.length, sourceText: paragraph.runs[0].text }] });
    await documentService.commit(userId,bookId,{ schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: firstId, expectedRevisionId: source.revisionId, document: source.document }] });
  });
  afterEach(async () => {
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } }); await db().documentOperation.deleteMany({ where: { bookId } }); await db().bookDocumentHead.deleteMany({ where: { bookId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } }); await db().sceneDocumentRevision.deleteMany({ where: { bookId } }); await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => { await db().user.delete({ where: { id: userId } }); });
  const moving = async () => {
    const source = await documentService.read(userId,bookId,firstId); const target = await documentService.read(userId,bookId,secondId);
    const first = structuredClone(source.document); const second = structuredClone(target.document);
    second.blocks.push(...first.blocks); second.changes.push(...first.changes); second.comments.push(...first.comments);
    first.blocks = documentFromText('',randomUUID).blocks; first.changes = []; first.comments = [];
    return { source, target, input: { schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId: firstId, expectedRevisionId: source.revisionId, document: first }, { sceneId: secondId, expectedRevisionId: target.revisionId, document: second }] } };
  };
  test('stable blocks, runs, comments and pending attribution move in one acknowledged receipt', async () => {
    const { source, target, input } = await moving(); const paragraph = source.document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
    const span = { blockId: paragraph.id, runId: paragraph.runs[0].id, from: 0, to: paragraph.runs[0].text.length };
    const anchorLineage: DocumentAnchorLineage[] = [{ kind: 'move', source: { sceneId: firstId,...span }, target: { sceneId: secondId,...span } }];
    const request = { ...input, anchorLineage }; const receipt = await documentService.commit(userId,bookId,request);
    const saved = await documentService.read(userId,bookId,secondId); const empty = await documentService.read(userId,bookId,firstId);
    expect(saved.bookRevisionId).toBe(empty.bookRevisionId); expect(receipt.scenes).toHaveLength(2);
    expect(saved.document.blocks).toEqual([...target.document.blocks,...source.document.blocks]);
    expect(saved.document.changes).toEqual(source.document.changes); expect(saved.document.comments).toEqual(source.document.comments);
    expect(saved.document.changes[0].authorName).toBe('Authenticated mover'); expect(empty.projection.text).toBe('');
    expect(receipt.anchorLineage?.[0]).toMatchObject({ kind: 'move', sourceSceneRevisionId: source.revisionId, targetSceneRevisionId: saved.revisionId, sourceTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await documentService.commit(userId,bookId,request)).toEqual(receipt);
  });
  test('altered attribution or a copied identity rolls back every scene', async () => {
    const { source, input } = await moving(); input.scenes[1].document.comments[0].authorName = 'Forged author';
    await expect(documentService.commit(userId,bookId,input)).rejects.toMatchObject({ code: 'DOCUMENT_REVIEW_TRANSFER_INVALID' });
    expect((await documentService.read(userId,bookId,firstId)).bookRevisionId).toBe(source.bookRevisionId);
    const duplicate = await moving(); duplicate.input.scenes[0].document.blocks = structuredClone(source.document.blocks); duplicate.input.scenes[0].document.changes = structuredClone(source.document.changes); duplicate.input.scenes[0].document.comments = structuredClone(source.document.comments);
    await expect(documentService.commit(userId,bookId,duplicate.input)).rejects.toMatchObject({ code: 'DOCUMENT_SCOPE_IDENTITY_CONFLICT' });
    expect((await documentService.read(userId,bookId,firstId)).bookRevisionId).toBe(source.bookRevisionId);
  });
  test('stale destination revisions reject the entire move before either projection changes', async () => {
    const { source, target, input } = await moving(); input.scenes[1].expectedRevisionId = randomUUID();
    await expect(documentService.commit(userId,bookId,input)).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE', status: 412 });
    expect((await documentService.read(userId,bookId,firstId)).document).toEqual(source.document);
    expect((await documentService.read(userId,bookId,secondId)).document).toEqual(target.document);
  });
  test('complete scene restoration journals inverse lineage and preserves review provenance', async () => {
    const { source, target, input } = await moving(); const moved = await documentService.commit(userId, bookId, input);
    const currentFirst = await documentService.read(userId, bookId, firstId); const currentSecond = await documentService.read(userId, bookId, secondId);
    const original = source.document.blocks[0]; if (original.type !== 'paragraph') throw new Error('fixture');
    const restoration = { schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: moved.revisionId, scenes: [{ sceneId: firstId, expectedRevisionId: currentFirst.revisionId, restoreFromRevisionId: source.revisionId, document: source.document }, { sceneId: secondId, expectedRevisionId: currentSecond.revisionId, restoreFromRevisionId: target.revisionId, document: target.document }], anchorLineage: [{ kind: 'restore' as const, source: { sceneId: secondId, blockId: original.id, runId: original.runs[0].id, from: 0, to: original.runs[0].text.length }, target: { sceneId: firstId, blockId: original.id, runId: original.runs[0].id, from: 0, to: original.runs[0].text.length } }] };
    const restored = await documentService.commit(userId, bookId, restoration);
    expect((await documentService.read(userId, bookId, firstId)).document).toEqual(source.document);
    expect((await documentService.read(userId, bookId, secondId)).document).toEqual(target.document);
    expect(restored.scenes.map((scene) => scene.restoredFromRevisionId)).toEqual([source.revisionId, target.revisionId]);
    expect(restored.anchorLineage?.[0].kind).toBe('restore');
    expect((await db().sceneDocumentRevision.findUniqueOrThrow({ where: { id: currentSecond.revisionId } })).document).toEqual(JSON.parse(JSON.stringify(currentSecond.document)));
    expect(await documentService.commit(userId, bookId, restoration)).toEqual(restored);
    expect(await db().auditLog.count({ where: { userId, entityId: bookId, metadata: { path: ['action'], equals: 'restore-document-scene-scope' } } })).toBe(2);
  });
  test('restoration cannot forge content or use another scene revision, and stale heads reject', async () => {
    const { source, target, input } = await moving(); const moved = await documentService.commit(userId, bookId, input);
    const current = await documentService.read(userId, bookId, secondId);
    const invalid = { schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: moved.revisionId, scenes: [{ sceneId: secondId, expectedRevisionId: current.revisionId, restoreFromRevisionId: source.revisionId, document: target.document }] };
    await expect(documentService.commit(userId, bookId, invalid)).rejects.toMatchObject({ code: 'DOCUMENT_RESTORATION_INVALID' });
    invalid.scenes[0].restoreFromRevisionId = target.revisionId; invalid.scenes[0].document = structuredClone(target.document);
    invalid.scenes[0].document.layout.fontSize += 1;
    await expect(documentService.commit(userId, bookId, invalid)).rejects.toMatchObject({ code: 'DOCUMENT_RESTORATION_INVALID' });
    invalid.scenes[0].document = target.document; invalid.expectedRevisionId = source.bookRevisionId;
    await expect(documentService.commit(userId, bookId, invalid)).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE', status: 412 });
    expect((await documentService.read(userId, bookId, secondId)).revisionId).toBe(current.revisionId);
  });
  test('incomplete historical conversions cannot authorize scene journal restoration', async () => {
    const { source, target, input } = await moving(); const moved = await documentService.commit(userId, bookId, input);
    await db().documentLegacyRevisionMapping.create({ data: { legacyRevisionId: randomUUID(), bookId, documentRevisionId: source.bookRevisionId, legacyContentHash: '0'.repeat(64), fidelity: { completeDocument: false } } });
    const current = await documentService.read(userId, bookId, secondId);
    await expect(documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: moved.revisionId, scenes: [{ sceneId: secondId, expectedRevisionId: current.revisionId, restoreFromRevisionId: target.revisionId, document: target.document }] })).rejects.toMatchObject({ code: 'DOCUMENT_RESTORATION_INCOMPLETE' });
    expect((await documentService.read(userId, bookId, secondId)).revisionId).toBe(current.revisionId);
  });
  test('inverse split restores original run identities only with complete owned revision proof', async () => {
    const first = await documentService.read(userId, bookId, firstId); const second = await documentService.read(userId, bookId, secondId);
    const original = second.document.blocks[0]; if (original.type !== 'paragraph') throw new Error('fixture');
    const splitAt = 5; const suffix = { type: 'paragraph' as const, id: randomUUID(), style: { ...original.style }, runs: [{ ...original.runs[0], id: randomUUID(), text: original.runs[0].text.slice(splitAt) }] };
    const nextFirst = structuredClone(first.document); nextFirst.blocks.push(suffix);
    const nextSecond = structuredClone(second.document); const prefix = nextSecond.blocks[0]; if (prefix.type !== 'paragraph') throw new Error('fixture'); prefix.runs[0].text = original.runs[0].text.slice(0, splitAt);
    const sourcePoint = { sceneId: secondId, blockId: original.id, runId: original.runs[0].id, from: splitAt, to: original.runs[0].text.length };
    const targetPoint = { sceneId: firstId, blockId: suffix.id, runId: suffix.runs[0].id, from: 0, to: suffix.runs[0].text.length };
    const split = await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: first.bookRevisionId, scenes: [{ sceneId: firstId, expectedRevisionId: first.revisionId, document: nextFirst }, { sceneId: secondId, expectedRevisionId: second.revisionId, document: nextSecond }], anchorLineage: [{ kind: 'split', source: sourcePoint, target: targetPoint }] });
    const inverse = { schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: split.revisionId, scenes: [{ sceneId: firstId, expectedRevisionId: split.scenes[0].revisionId, document: first.document, restoreFromRevisionId: first.revisionId }, { sceneId: secondId, expectedRevisionId: split.scenes[1].revisionId, document: second.document, restoreFromRevisionId: second.revisionId }], anchorLineage: [{ kind: 'restore' as const, source: targetPoint, target: sourcePoint }] };
    const restored = await documentService.commit(userId, bookId, inverse);
    expect(restored.anchorLineage?.[0]).toMatchObject({ kind: 'restore', source: { runId: suffix.runs[0].id }, target: { runId: original.runs[0].id } });
    expect((await documentService.read(userId, bookId, secondId)).document).toEqual(second.document);
    const missingProof = { ...inverse, operationId: randomUUID(), expectedRevisionId: restored.revisionId, scenes: inverse.scenes.map((scene, index) => ({ ...scene, expectedRevisionId: restored.scenes[index].revisionId, restoreFromRevisionId: undefined })) };
    await expect(documentService.commit(userId, bookId, missingProof)).rejects.toMatchObject({ code: 'DOCUMENT_LINEAGE_INVALID' });
  });
});
