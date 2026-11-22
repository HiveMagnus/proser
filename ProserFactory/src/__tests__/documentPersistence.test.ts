import { randomUUID } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText } from '@/documents/model';
import type { PrismaClient } from '@prisma/client';
import { StructureController } from '@/api/controllers/structure';
import type { AuthenticatedRequest } from '@/api/types';
import type { Response } from 'express';
describe('structured document persistence', () => {
let db: PrismaClient;
let userId: number; let bookId: number; let sceneId: number;
beforeAll(async () => {
  db = databaseService.client;
  const user = await db.user.create({ data: { githubId: `jest-document-${randomUUID()}`, username: 'Document fixture' } }); userId = user.id;
  const book = await db.book.create({ data: { userId, title: 'Disposable document fixture', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Original 😀\n\nSecond paragraph' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
  bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id;
});
afterAll(async () => {
  await db.documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
  await db.documentOperation.deleteMany({ where: { bookId } });
  await db.bookDocumentRevision.deleteMany({ where: { bookId } });
  await db.bookDocumentScopeRevision.deleteMany({ where: { bookId } });
  await db.sceneDocumentRevision.deleteMany({ where: { bookId } });
  await db.bookDocumentHead.deleteMany({ where: { bookId } });
  await db.book.delete({ where: { id: bookId } }); await db.user.delete({ where: { id: userId } });
});
test('backfill is idempotent, preserving exact originals and refusing cross-owner access', async () => {
  const head = await documentService.initialize(userId, bookId);
  expect(await documentService.initialize(userId, bookId)).toBe(head);
  const read = await documentService.read(userId, bookId, sceneId);
  expect(read.projection.text).toBe('Original 😀\n\nSecond paragraph');
  expect((await db.sceneDocumentRevision.findUniqueOrThrow({ where: { id: read.revisionId } })).originalProse).toBe(read.projection.text);
  await expect(documentService.read(userId + 1000000, bookId, sceneId)).rejects.toThrow('Book not found');
});
test('durable commit, receipt recovery, immutable history, stale-tab rejection and full document restore', async () => {
  const before = await documentService.read(userId, bookId, sceneId);
  const document = documentFromText('Revised text', randomUUID);
  const paragraph = document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture');
  paragraph.runs[0].style = { bold: true, font: 'Georgia', size: 20 };
  const input = { schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document }] };
  const receipt = await documentService.commit(userId, bookId, input);
  expect(await documentService.commit(userId, bookId, input)).toEqual(receipt);
  expect(await documentService.operation(userId, bookId, input.operationId)).toEqual(receipt);
  const after = await documentService.read(userId, bookId, sceneId);
  expect(after.document).toEqual(document);
  expect((await db.scene.findUniqueOrThrow({ where: { id: sceneId } })).prose).toBe('Revised text');
  await expect(documentService.commit(userId, bookId, { ...input, operationId: randomUUID() })).rejects.toMatchObject({ status: 412 });
  await expect(documentService.commit(userId, bookId, { ...input, scenes: [{ ...input.scenes[0], document: before.document }] })).rejects.toMatchObject({ status: 409 });
  await documentService.restore(userId, bookId, before.bookRevisionId, after.bookRevisionId, randomUUID());
  expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(before.document);
  expect((await db.sceneDocumentRevision.findUniqueOrThrow({ where: { id: after.revisionId } })).document).toEqual(document);
});
test('concurrent writes serialize on the book head and preserve the winning revision', async () => {
  const before = await documentService.read(userId, bookId, sceneId);
  const requests = ['Concurrent first', 'Concurrent second'].map((text) => ({ schemaVersion: 1 as const, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document: documentFromText(text, randomUUID) }] }));
  const results = await Promise.allSettled(requests.map((input) => documentService.commit(userId, bookId, input)));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' ? rejected.reason.status : null).toBe(412);
  const winner = results.find((result) => result.status === 'fulfilled');
  expect((await documentService.read(userId, bookId, sceneId)).bookRevisionId).toBe(winner?.status === 'fulfilled' ? winner.value.revisionId : null);
});
test('an invalid second scene rolls back the entire first scene mutation and receipt', async () => {
  const before = await documentService.read(userId, bookId, sceneId);
  const operationId = randomUUID();
  const count = await db.sceneDocumentRevision.count({ where: { bookId } });
  await expect(documentService.commit(userId, bookId, { schemaVersion: 1, operationId, expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document: documentFromText('Must roll back', randomUUID) }, { sceneId: sceneId + 100000, expectedRevisionId: randomUUID(), document: documentFromText('Missing scene', randomUUID) }] })).rejects.toMatchObject({ status: 412 });
  expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(before.document);
  expect(await db.sceneDocumentRevision.count({ where: { bookId } })).toBe(count);
  expect(await db.documentOperation.findUnique({ where: { id: operationId } })).toBeNull();
});
test('legacy projection drift is refused rather than overwriting an untracked writer', async () => {
  const before = await documentService.read(userId, bookId, sceneId);
  await db.scene.update({ where: { id: sceneId }, data: { prose: 'Legacy writer content' } });
  await expect(documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document: before.document }] })).rejects.toMatchObject({ code: 'DOCUMENT_AUTHORITY_DRIFT' });
  expect((await db.scene.findUniqueOrThrow({ where: { id: sceneId } })).prose).toBe('Legacy writer content');
  await db.scene.update({ where: { id: sceneId }, data: { prose: before.projection.text } });
});
test('a corrupted head cannot acknowledge a document write or advance immutable history', async () => {
  const before = await documentService.read(userId, bookId, sceneId);
  const head = await db.bookDocumentHead.findUniqueOrThrow({ where: { bookId } });
  const count = await db.bookDocumentRevision.count({ where: { bookId } });
  const operationId = randomUUID();
  try {
    await db.bookDocumentHead.update({ where: { bookId }, data: { manifest: { schemaVersion: 1, scenes: [] } } });
    await expect(documentService.commit(userId, bookId, { schemaVersion: 1, operationId, expectedRevisionId: head.revisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document: before.document }] })).rejects.toMatchObject({ code: 'DOCUMENT_MANIFEST_INVALID', status: 503 });
    expect(await db.bookDocumentRevision.count({ where: { bookId } })).toBe(count);
    expect(await db.documentOperation.findUnique({ where: { id: operationId } })).toBeNull();
  } finally { await db.bookDocumentHead.update({ where: { bookId }, data: { manifest: JSON.parse(JSON.stringify(head.manifest)) } }); }
  expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(before.document);
});
test('structure saves retain act/chapter/scene IDs and manuscript content', async () => {
  const before = await db.scene.findUniqueOrThrow({ where: { id: sceneId }, include: { chapter: { include: { act: true } } } });
  const status = jest.fn(); const response = { headersSent: false, status, json: jest.fn() }; status.mockReturnValue(response);
  await StructureController.saveStructure({ user: { id: userId }, params: { bookId: String(bookId) }, body: { acts: [{ id: before.chapter.actId, title: 'Updated act', chapters: [{ id: before.chapterId, title: 'Updated chapter' }] }] } } as unknown as AuthenticatedRequest, response as unknown as Response);
  const after = await db.scene.findUniqueOrThrow({ where: { id: sceneId }, include: { chapter: { include: { act: true } } } });
  expect(after.chapterId).toBe(before.chapterId); expect(after.chapter.actId).toBe(before.chapter.actId);
  expect(after.prose).toBe(before.prose); expect(after.chapter.title).toBe('Updated chapter');
  expect(after.chapter.act.title).toBe('Updated act');
});
});
