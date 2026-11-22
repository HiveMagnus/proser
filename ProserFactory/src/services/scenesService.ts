import { databaseService, Scene } from '../lib/database';
import type { Prisma } from '@prisma/client';
import { invalidateExport, invalidateStructure } from '../lib/redis/contentCache';
import { assertWorkflowLease } from './workflowExecutionContext';
import { documentAuthorityEnabled, documentService, DocumentError, type DocumentOrigin } from '@/documents/service';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import { documentFromText, projectDocument } from '@/documents/model';
import { randomUUID } from 'node:crypto';

export interface SceneWritePreconditions extends DocumentMutationPreconditions {
  origin?: DocumentOrigin;
  regeneration?: boolean;
}
function requiredPreconditions(value?: SceneWritePreconditions, body = false): SceneWritePreconditions {
  if (!value?.operationId || !value.expectedRevisionId || !value.expectedScopes || (body && !value.expectedSceneRevisionId)) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Operation ID, book and affected scope/scene revisions are required.', 428);
  return value;
}


export interface SceneWriteResult extends Scene {
  documentRevision?: { operationId: string; bookRevisionId: string; sceneRevisionId: string; contentHash: string };
}

export interface CreateSceneInput {
  userId: number;
  chapterId: number;
  prose?: string;
  summary?: string;
  outline?: string;
  selectedImageId?: number | null;
  preconditions?: SceneWritePreconditions;
}

export interface BatchCreateSceneInput {
  userId: number;
  chapterId: number;
  scenes: Array<{ prose?: string; summary?: string; outline?: string; selectedImageId?: number | null }>;
  preconditions?: SceneWritePreconditions;
}


class ScenesService {
  public async createSceneForChapter(input: CreateSceneInput): Promise<SceneWriteResult> {
    const { userId, chapterId, prose, summary, outline, selectedImageId } = input;
    const prisma = databaseService.client;
    const chapter = await prisma.chapter.findFirst({ where: { id: chapterId, act: { book: { userId } } }, include: { act: { select: { bookId: true } } } });
    if (!chapter) { const err = new Error('Chapter not found'); err.name = 'NotFoundError'; throw err; }

    if (documentAuthorityEnabled()) return (await this.batchCreateScenesForChapter({ userId, chapterId, scenes: [{ prose, summary, outline, selectedImageId }], preconditions: input.preconditions }))[0];

    const result: Scene = await prisma.$transaction(async (tx) => {
      const last = await tx.scene.findFirst({ where: { chapterId }, orderBy: { sceneNumber: 'desc' } });
      const nextNumber = (last?.sceneNumber ?? 0) + 1;
      const data: Parameters<typeof documentService.legacyCreateScene>[3] = { chapterId, sceneNumber: nextNumber };
      if (prose !== undefined) { data.prose = prose ?? null; }
      if (summary !== undefined) { data.summary = summary ?? null; }
      if (outline !== undefined) { data.outline = outline ?? null; }
      if (selectedImageId !== undefined) data.selectedImageId = selectedImageId || 0;
      const created: Scene = await documentService.legacyCreateScene(tx, userId, chapter.act.bookId, data);
      return created;
    });

    const bookId = chapter.act.bookId as number;
    try { await invalidateStructure(bookId); await invalidateExport(bookId); } catch {}
    return result;
  }

  public async batchCreateScenesForChapter(input: BatchCreateSceneInput): Promise<SceneWriteResult[]> {
    const { userId, chapterId, scenes } = input;
    const prisma = databaseService.client;
    if (!Array.isArray(scenes) || scenes.length === 0) return [];
    const chapter = await prisma.chapter.findFirst({ where: { id: chapterId, act: { book: { userId } } }, include: { act: { select: { bookId: true } } } });
    if (!chapter) { const err = new Error('Chapter not found'); err.name = 'NotFoundError'; throw err; }

    if (documentAuthorityEnabled()) {
      const expected = requiredPreconditions(input.preconditions);
      const receipt = await documentService.mutateCatalog(userId, chapter.act.bookId, { ...expected, payload: { command: 'create-scenes', chapterId, scenes } }, async (tx) => {
        const activeChapter = await tx.chapter.findFirst({ where: { id: chapterId, deletedAt: null, act: { deletedAt: null, bookId: chapter.act.bookId } } });
        if (!activeChapter) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Chapter not found.', 404);
        // Include tombstones when allocating numbers: their identity and unique
        // keys remain preserved until the reviewed active-order constraint ships.
        const last = await tx.scene.aggregate({ where: { chapterId }, _max: { sceneNumber: true } });
        const rows: Scene[] = []; const newDocuments = [];
        for (const [index, scene] of scenes.entries()) {
          const document = documentFromText(scene.prose ?? '', randomUUID); const projection = projectDocument(document);
          const row = await tx.scene.create({ data: { chapterId, sceneNumber: Math.max(0, last._max.sceneNumber ?? 0) + index + 1, summary: scene.summary, outline: scene.outline, selectedImageId: scene.selectedImageId || 0 } });
          rows.push({ ...row, prose: projection.text, wordCount: projection.wordCount });
          newDocuments.push({ sceneId: row.id, document });
        }
        return { result: rows, newDocuments };
      }, expected.origin);
      return receipt.result.map((row) => ({ ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null, updatedAt: row.updatedAt ? new Date(row.updatedAt) : null, documentRevision: {
        operationId: receipt.operationId, bookRevisionId: receipt.revisionId,
        sceneRevisionId: receipt.manifest.scenes.find((reference) => reference.sceneId === row.id)!.revisionId,
        contentHash: receipt.manifest.scenes.find((reference) => reference.sceneId === row.id)!.contentHash,
      } }));
    }

    const created: Scene[] = await prisma.$transaction(async (tx) => {
      const last = await tx.scene.findFirst({ where: { chapterId }, orderBy: { sceneNumber: 'desc' } });
      const startNumber = (last?.sceneNumber ?? 0) + 1;
      const rows: Scene[] = [];
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i] ?? {};
        const data: Parameters<typeof documentService.legacyCreateScene>[3] = { chapterId, sceneNumber: startNumber + i };
        if (s.prose !== undefined) { data.prose = s.prose ?? null; }
        if (s.summary !== undefined) { data.summary = s.summary ?? null; }
        if (s.outline !== undefined) { data.outline = s.outline ?? null; }
        if (s.selectedImageId !== undefined) data.selectedImageId = s.selectedImageId || 0;
        rows.push(await documentService.legacyCreateScene(tx, userId, chapter.act.bookId, data));
      }
      return rows;
    });

    const bookId = chapter.act.bookId as number;
    try { await invalidateStructure(bookId); await invalidateExport(bookId); } catch {}
    return created;
  }

  public async updateSceneProse(userId: number, sceneId: number, patch: { prose?: string; summary?: string; outline?: string; selectedImageId?: number | null }, preconditions?: SceneWritePreconditions): Promise<SceneWriteResult> {
    const prisma = databaseService.client;
    const scene = await prisma.scene.findFirst({ where: { id: sceneId, deletedAt: documentAuthorityEnabled() ? {} : null, chapter: { act: { book: { userId } } } }, include: { chapter: { include: { act: { select: { bookId: true } } } } } });
    if (!scene) { const err = new Error('Scene not found'); err.name = 'NotFoundError'; throw err; }

    if (documentAuthorityEnabled()) {
      const expected = requiredPreconditions(preconditions, patch.prose !== undefined);
      const origin = expected.origin ?? 'manual';
      const receipt = await documentService.mutateCatalog(userId, scene.chapter.act.bookId, { ...expected, payload: { command: 'update-scene', sceneId, patch } }, async (tx) => {
        if (scene.deletedAt) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Scene not found.', 404);
        const metadata: Prisma.SceneUncheckedUpdateInput = {};
        if (patch.summary !== undefined) metadata.summary = patch.summary;
        if (patch.outline !== undefined) metadata.outline = patch.outline;
        if (patch.selectedImageId !== undefined) metadata.selectedImageId = patch.selectedImageId || 0;
        const row = await tx.scene.update({ where: { id: sceneId }, data: metadata });
        if (patch.prose === undefined) return { result: row };
        const document = await documentService.replacementDocument(tx, scene.chapter.act.bookId, sceneId, expected.expectedSceneRevisionId!, patch.prose, userId, origin, expected.regeneration);
        const projection = projectDocument(document);
        return { result: { ...row, prose: projection.text, wordCount: projection.wordCount }, changedDocuments: [{ sceneId, expectedRevisionId: expected.expectedSceneRevisionId!, document }] };
      }, origin);
      const reference = receipt.manifest.scenes.find((item) => item.sceneId === sceneId)!;
      return { ...receipt.result, createdAt: receipt.result.createdAt ? new Date(receipt.result.createdAt) : null, updatedAt: receipt.result.updatedAt ? new Date(receipt.result.updatedAt) : null, documentRevision: { operationId: receipt.operationId, bookRevisionId: receipt.revisionId, sceneRevisionId: reference.revisionId, contentHash: reference.contentHash } };
    }

    await assertWorkflowLease();
    const updated: Scene = await documentService.legacyWriteScene(userId, scene.chapter.act.bookId, sceneId, { ...patch, ...(patch.selectedImageId !== undefined ? { selectedImageId: patch.selectedImageId || 0 } : {}) });

    const bookId = scene.chapter.act.bookId as number;
    try { await invalidateStructure(bookId); await invalidateExport(bookId); } catch {}
    return updated;
  }
  public async reorderScenes(userId: number, bookId: number, chapterId: number, sceneIds: number[], preconditions?: SceneWritePreconditions) {
    const expected = requiredPreconditions(preconditions);
    return documentService.mutateCatalog(userId, bookId, { ...expected, payload: { command: 'reorder-scenes', chapterId, sceneIds } }, async (tx) => {
      const chapter = await tx.chapter.findFirst({ where: { id: chapterId, deletedAt: null, act: { bookId, deletedAt: null } } });
      if (!chapter) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Chapter not found in this book.', 404);
      const scenes = await tx.scene.findMany({ where: { chapterId, deletedAt: null }, select: { id: true } });
      if (new Set(sceneIds).size !== sceneIds.length || sceneIds.length !== scenes.length || sceneIds.some((id) => !scenes.some((scene) => scene.id === id))) throw new DocumentError('DOCUMENT_ORDER_INVALID', 'Reorder must identify every active scene in this chapter exactly once.', 409);
      await this.assignSceneOrder(tx, chapterId, sceneIds);
      return { result: { chapterId, sceneIds } };
    }, expected.origin);
  }
  public async deleteScene(userId: number, bookId: number, sceneId: number, preconditions?: SceneWritePreconditions) {
    const expected = requiredPreconditions(preconditions);
    return documentService.mutateCatalog(userId, bookId, { ...expected, payload: { command: 'delete-scene', sceneId } }, async (tx) => {
      const scene = await tx.scene.findFirst({ where: { id: sceneId, deletedAt: null, chapter: { act: { bookId } } } });
      if (!scene) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Scene not found in this book.', 404);
      await tx.scene.update({ where: { id: sceneId }, data: { deletedAt: new Date() } });
      const siblings = await tx.scene.findMany({ where: { chapterId: scene.chapterId, deletedAt: null }, orderBy: { sceneNumber: 'asc' }, select: { id: true } });
      await this.assignSceneOrder(tx, scene.chapterId, siblings.map((sibling) => sibling.id));
      return { result: { sceneId } };
    }, expected.origin);
  }
  private async assignSceneOrder(tx: Prisma.TransactionClient, chapterId: number, sceneIds: number[]) {
    const all = await tx.scene.findMany({ where: { chapterId, deletedAt: {} }, select: { id: true } });
    // Negative identity keys are collision-free, including tombstoned rows.
    for (const scene of all) await tx.scene.update({ where: { id: scene.id }, data: { sceneNumber: -scene.id } });
    for (const [index, id] of sceneIds.entries()) await tx.scene.update({ where: { id }, data: { sceneNumber: index + 1 } });
  }

}

export const scenesService = new ScenesService();
