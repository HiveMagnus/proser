import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse } from '../types';
import { databaseService } from '../../lib/database';
import logger from '../../lib/logger';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { respondSuccess } from '../utils/response';
import { getStructureCache, cacheStructure, invalidateStructure } from '../../lib/redis/contentCache';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import type { Prisma } from '@prisma/client';
import { catalogCommand } from '@/documents/catalogCommands';
import { orderActs, orderChapters } from '@/documents/structureOrder';
import { readCanonicalBookProjection } from '@/documents/readProjection';
interface SaveStructureRequest {
  acts: Array<{
    id?: number;
    title?: string;
    summary?: string;
    chapters: Array<{
      id?: number;
      title?: string;
      summary?: string;
    }>;
  }>;
}

export class StructureController {
  static async getStructure(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
      if (!book) throw new NotFoundError('Book not found');
      if (documentAuthorityEnabled()) {
        const projection = await readCanonicalBookProjection(userId, bookId);
        res.setHeader('Cache-Control', 'private, no-store');
        respondSuccess(res, { acts: projection.acts, tombstones: projection.tombstones, projection: projection.projection, sourceBookRevisionId: projection.sourceBookRevisionId, contentHash: projection.contentHash });
        return;
      }
      // Try cache
      const cached = await getStructureCache(bookId);
      if (cached.data) { respondSuccess(res, cached.data); return; }
      const acts = await databaseService.client.act.findMany({
        where: { bookId, deletedAt: null },
        orderBy: { actNumber: 'asc' },
        include: { chapters: { where: { deletedAt: null }, orderBy: { chapterNumber: 'asc' }, include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: 'asc' } } } } }
      });
      const payload = { acts };
      await cacheStructure(bookId, payload);
      respondSuccess(res, payload);
    } catch (error) {
      logger.error({ error, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to get structure');
      throw error;
    }
  }

  static async saveStructure(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const { acts }: SaveStructureRequest = req.body;
      if (!acts || !Array.isArray(acts)) throw new ValidationError('Acts array is required');
      const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
      if (!book) throw new NotFoundError('Book not found');
      const save = async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId} FOR UPDATE`;
        const allActs = await tx.act.findMany({ where: { bookId }, orderBy: { actNumber: 'asc' }, include: { chapters: { orderBy: { chapterNumber: 'asc' } } } });
        const existingActs = allActs.filter((act) => !act.deletedAt);
        const actIds = acts.flatMap((act) => act.id === undefined ? [] : [act.id]);
        if (new Set(actIds).size !== actIds.length || actIds.some((id) => !existingActs.some((act) => act.id === id))) throw new ValidationError('Invalid or duplicate act identity');
        // Free ordering slots in two passes while retaining every entity and scene.
        for (const act of allActs) await tx.act.update({ where: { id: act.id }, data: { actNumber: -act.id } });
        const usedActs = new Set<number>();
        for (let i = 0; i < acts.length; i++) {
          const actData = acts[i];
          const existing = actData.id === undefined ? (documentAuthorityEnabled() ? undefined : existingActs[i]) : existingActs.find((act) => act.id === actData.id);
          if (existing && usedActs.has(existing.id)) throw new ValidationError('Duplicate act identity');
          const data = { actNumber: i + 1, ...(actData.title !== undefined ? { title: actData.title || null } : {}), ...(actData.summary !== undefined ? { summary: actData.summary || null } : {}) };
          const newAct = existing ? await tx.act.update({ where: { id: existing.id }, data }) : await tx.act.create({ data: { bookId, ...data } });
          usedActs.add(newAct.id);
          const allChapters = existing?.chapters ?? []; const chapters = allChapters.filter((chapter) => !chapter.deletedAt);
          const chapterIds = actData.chapters.flatMap((chapter) => chapter.id === undefined ? [] : [chapter.id]);
          if (new Set(chapterIds).size !== chapterIds.length || chapterIds.some((id) => !chapters.some((chapter) => chapter.id === id))) throw new ValidationError('Invalid or duplicate chapter identity');
          for (const chapter of allChapters) await tx.chapter.update({ where: { id: chapter.id }, data: { chapterNumber: -chapter.id } });
          const usedChapters = new Set<number>();
          for (let j = 0; j < actData.chapters.length; j++) {
            const chapterData = actData.chapters[j];
            const current = chapterData.id === undefined ? (documentAuthorityEnabled() ? undefined : chapters[j]) : chapters.find((chapter) => chapter.id === chapterData.id);
            if (current && usedChapters.has(current.id)) throw new ValidationError('Duplicate chapter identity');
            const metadata = { chapterNumber: j + 1, ...(chapterData.title !== undefined ? { title: chapterData.title || null } : {}), ...(chapterData.summary !== undefined ? { summary: chapterData.summary || null } : {}) };
            const chapter = current ? await tx.chapter.update({ where: { id: current.id }, data: metadata }) : await tx.chapter.create({ data: { actId: newAct.id, ...metadata } });
            usedChapters.add(chapter.id);
          }
          let nextChapter = actData.chapters.length + 1;
          for (const chapter of chapters) if (!usedChapters.has(chapter.id)) await tx.chapter.update({ where: { id: chapter.id }, data: { chapterNumber: nextChapter++ } });
        }
        // Omission is not deletion. Deletion requires a separate explicit operation.
        let nextAct = acts.length + 1;
        for (const act of existingActs) if (!usedActs.has(act.id)) await tx.act.update({ where: { id: act.id }, data: { actNumber: nextAct++ } });
        if (documentAuthorityEnabled()) return tx.act.findMany({ where: { bookId, deletedAt: null }, orderBy: { actNumber: 'asc' }, include: { chapters: { where: { deletedAt: null }, orderBy: { chapterNumber: 'asc' }, include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: 'asc' }, select: { id: true, chapterId: true, sceneNumber: true, summary: true, outline: true, beatsMeta: true, selectedImageId: true, createdAt: true, deletedAt: true } } } } } });
        return tx.act.findMany({ where: { bookId, deletedAt: null }, orderBy: { actNumber: 'asc' }, include: { chapters: { where: { deletedAt: null }, orderBy: { chapterNumber: 'asc' }, include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: 'asc' } } } } } });
      };
      const expected = parseDocumentMutationPreconditions(req.body.documentPreconditions);
      const receipt = documentAuthorityEnabled() ? await documentService.mutateCatalog(userId, bookId, { operationId: expected?.operationId ?? '', expectedRevisionId: expected?.expectedRevisionId ?? '', expectedScopes: expected?.expectedScopes ?? {}, payload: { command: 'save-structure', acts } }, async (tx) => ({ result: await save(tx) })) : undefined;
      const result = receipt ? receipt.result : await databaseService.client.$transaction(save);
      logger.info({ userId, bookId, actCount: acts.length }, 'Saved book structure');
      await invalidateStructure(bookId);
      const committedActs = receipt ? result.map((act) => ({ ...act, chapters: act.chapters.map((chapter) => ({ ...chapter, scenes: chapter.scenes.map((scene) => {
        const source = receipt.manifest.scenes.find((reference) => reference.sceneId === scene.id);
        if (!source) throw new ValidationError('Committed scene metadata is absent from the document manifest');
        return { ...scene, wordCount: source.wordCount, projection: 'final', sourceBookRevisionId: receipt.revisionId, sourceSceneRevisionId: source.revisionId, contentHash: source.contentHash };
      }) })) })) : result;
      respondSuccess(res, { acts: committedActs, ...(receipt ? { documentReceipt: receipt } : {}) }, 201);
    } catch (error) {
      logger.error({ error, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to save structure');
      throw error;
    }
  }

  static async reorderActs(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const { reorderedActs } = req.body as { reorderedActs: Array<{ id: number }> };
      if (!reorderedActs || !Array.isArray(reorderedActs)) throw new ValidationError('reorderedActs array required');
      const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
      if (!book) throw new NotFoundError('Book not found');
      const order = async (tx: Prisma.TransactionClient) => { await orderActs(tx, bookId, reorderedActs.map((act) => act.id)); return { result: { bookId } }; };
      const receipt = documentAuthorityEnabled() ? await documentService.mutateCatalog(userId, bookId, catalogCommand(parseDocumentMutationPreconditions(req.body.documentPreconditions), { command: 'reorder-acts', reorderedActs }), order) : undefined;
      if (!receipt) await databaseService.client.$transaction(order);
      logger.info({ userId, bookId }, 'Reordered acts');
      await invalidateStructure(bookId);
      respondSuccess(res, { message: 'Acts reordered successfully', ...(receipt ? { documentReceipt: receipt } : {}) });
    } catch (error) {
      logger.error({ error, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to reorder acts');
      throw error;
    }
  }

  static async reorderChapters(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const actId = parseInt(req.params.actId);
      const { reorderedChapters } = req.body as { reorderedChapters: Array<{ id: number }> };
      if (!reorderedChapters || !Array.isArray(reorderedChapters)) throw new ValidationError('reorderedChapters array required');
      const act = await databaseService.client.act.findFirst({ where: { id: actId, bookId, deletedAt: null, book: { userId } } });
      if (!act) throw new NotFoundError('Act not found');
      const order = async (tx: Prisma.TransactionClient) => { await orderChapters(tx, actId, reorderedChapters.map((chapter) => chapter.id)); return { result: { actId } }; };
      const receipt = documentAuthorityEnabled() ? await documentService.mutateCatalog(userId, bookId, catalogCommand(parseDocumentMutationPreconditions(req.body.documentPreconditions), { command: 'reorder-chapters', actId, reorderedChapters }), order) : undefined;
      if (!receipt) await databaseService.client.$transaction(order);
      logger.info({ userId, bookId, actId }, 'Reordered chapters');
      await invalidateStructure(bookId);
      respondSuccess(res, { message: 'Chapters reordered successfully', ...(receipt ? { documentReceipt: receipt } : {}) });
    } catch (error) {
      logger.error({ error, actId: req.params.actId, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to reorder chapters');
      throw error;
    }
  }
}
