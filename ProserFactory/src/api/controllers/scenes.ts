import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse } from '../types';
import { databaseService } from '../../lib/database';
import { NotFoundError, ValidationError } from '../../lib/errors';
import logger from '../../lib/logger';
import { respondSuccess } from '../utils/response';
import { invalidateStructure, invalidateExport } from '../../lib/redis/contentCache';
import { scenesService } from '../../services/scenesService';
import { documentAuthorityEnabled, DocumentError } from '@/documents/service';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { generateOwnedScene } from '@/documents/generation';
import { readCanonicalScenes, includeCompatibilityProse } from '@/documents/readProjection';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { SceneProseService, type SceneProseResult } from '../../services/sceneProseService';

const defaultRagTokenBudget = (): number =>
  Number.parseInt(process.env.RAG_TOKEN_BUDGET || '120000', 10) || 120000;

export class ScenesController {
  /**
   * GET /api/books/:bookId/scenes — flat list of all scenes in a book,
   * enriched with act_number and chapter_number for the UI.
   */
  static async getAllScenes(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);

      const book = await databaseService.client.book.findFirst({
        where: { id: bookId, userId },
        select: { id: true },
      });
      if (!book) throw new NotFoundError('Book not found');

      if (documentAuthorityEnabled()) { res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, await readCanonicalScenes(userId, bookId, { includeProse: includeCompatibilityProse(req.query.includeProse, true) })); return; }
      const scenes = await databaseService.client.scene.findMany({
        where: {
          deletedAt: null,
          chapter: { act: { bookId, book: { userId } } },
        },
        include: {
          chapter: {
            select: {
              id: true,
              title: true,
              chapterNumber: true,
              act: { select: { id: true, title: true, actNumber: true } },
            },
          },
        },
        orderBy: [
          { chapter: { act: { actNumber: 'asc' } } },
          { chapter: { chapterNumber: 'asc' } },
          { sceneNumber: 'asc' },
        ],
      });

      const enriched = scenes.map((s) => ({
        id: s.id,
        sceneNumber: s.sceneNumber,
        prose: s.prose,
        summary: s.summary,
        outline: s.outline,
        wordCount: s.wordCount,
        selectedImageId: s.selectedImageId,
        chapterId: s.chapterId,
        chapterTitle: s.chapter.title,
        chapterNumber: s.chapter.chapterNumber,
        actId: s.chapter.act.id,
        actTitle: s.chapter.act.title,
        actNumber: s.chapter.act.actNumber,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));

      respondSuccess(res, { scenes: enriched });
    } catch (error) {
      logger.error({ error, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to get all scenes');
      throw error;
    }
  }

  static async batchCreateScenes(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      if (!await databaseService.client.chapter.findFirst({ where: { id: Number(req.params.chapterId), deletedAt: documentAuthorityEnabled() ? {} : null, act: { bookId: Number(req.params.bookId), deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } } }, select: { id: true } })) throw new NotFoundError('Chapter not found');
      const chapterId = parseInt(req.params.chapterId);
  const { scenes } = req.body as { scenes: Array<{ prose?: string; summary?: string }> };
  if (!Array.isArray(scenes) || scenes.length === 0) throw new ValidationError('scenes array required');
  const created = await scenesService.batchCreateScenesForChapter({ userId, chapterId, scenes, preconditions: parseDocumentMutationPreconditions(req.body.documentPreconditions) });
  respondSuccess(res, { scenes: created }, 201);
    } catch (error) {
      logger.error({ error, chapterId: req.params.chapterId, userId: req.user?.id }, 'Failed batch create scenes');
      throw error;
    }
  }
  static async reorderScenes(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const chapterId = parseInt(req.params.chapterId);
      const { reorderedScenes } = req.body as { reorderedScenes: Array<{ id: number }> };
  if (!Array.isArray(reorderedScenes)) throw new ValidationError('reorderedScenes array required');
  const chapter = await databaseService.client.chapter.findFirst({ where: { id: chapterId, act: { book: { userId } } }, include: { act: { select: { bookId: true } } } });
  if (!chapter || chapter.act.bookId !== Number(req.params.bookId)) throw new NotFoundError('Chapter not found');
      if (documentAuthorityEnabled()) {
        const receipt = await scenesService.reorderScenes(userId, Number(req.params.bookId), chapterId, reorderedScenes.map((scene) => scene.id), parseDocumentMutationPreconditions(req.body.documentPreconditions));
        respondSuccess(res, { message: 'Scenes reordered successfully', documentReceipt: receipt }); return;
      }
      // Two-phase update to prevent unique constraint collisions on (chapterId, sceneNumber)
      await databaseService.client.$transaction(async (tx) => {
        const tempOffset = 1000;
        for (let i = 0; i < reorderedScenes.length; i++) {
          await tx.scene.update({ where: { id: reorderedScenes[i].id }, data: { sceneNumber: tempOffset + i + 1 } });
        }
        for (let i = 0; i < reorderedScenes.length; i++) {
          await tx.scene.update({ where: { id: reorderedScenes[i].id }, data: { sceneNumber: i + 1 } });
        }
      });
  const bookId = chapter.act.bookId; await invalidateStructure(bookId); await invalidateExport(bookId);
  respondSuccess(res, { message: 'Scenes reordered successfully' });
    } catch (error) {
      logger.error({ error, chapterId: req.params.chapterId, userId: req.user?.id }, 'Failed to reorder scenes');
      throw error;
    }
  }
  static async getScenes(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const chapterId = parseInt(req.params.chapterId);
      const chapter = await databaseService.client.chapter.findFirst({ where: { id: chapterId, act: { book: { userId } } }, include: { act: { select: { bookId: true } } } });
  if (!chapter) throw new NotFoundError('Chapter not found');
      if (documentAuthorityEnabled()) { res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, await readCanonicalScenes(userId, chapter.act.bookId, { chapterId, includeProse: includeCompatibilityProse(req.query.includeProse, true) })); return; }
      const scenes = await databaseService.client.scene.findMany({ where: { chapterId }, orderBy: { sceneNumber: 'asc' } });
  respondSuccess(res, { scenes });
    } catch (error) {
      logger.error({ error, chapterId: req.params.chapterId, userId: req.user?.id }, 'Failed to get scenes');
      throw error;
    }
  }

  static async getScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const sceneId = parseInt(req.params.sceneId);

      if (documentAuthorityEnabled()) { const projection = await readCanonicalScenes(userId, bookId, { sceneIds: [sceneId], includeProse: includeCompatibilityProse(req.query.includeProse, true) }); const scene = projection.scenes[0]; if (!scene) throw new NotFoundError('Scene not found'); res.setHeader('Cache-Control', 'private, no-store'); respondSuccess(res, { ...projection, scenes: undefined, scene }); return; }
      const scene = await databaseService.client.scene.findFirst({
        where: {
          id: sceneId,
          deletedAt: null,
          chapter: { act: { bookId, book: { userId } } },
        },
        include: {
          chapter: {
            select: {
              id: true,
              title: true,
              chapterNumber: true,
              act: { select: { id: true, title: true, actNumber: true } },
            },
          },
        },
      });
      if (!scene) throw new NotFoundError('Scene not found');

      respondSuccess(res, {
        scene: {
          id: scene.id,
          sceneNumber: scene.sceneNumber,
          prose: scene.prose,
          summary: scene.summary,
          outline: scene.outline,
          wordCount: scene.wordCount,
          selectedImageId: scene.selectedImageId,
          chapterId: scene.chapterId,
          chapterTitle: scene.chapter.title,
          chapterNumber: scene.chapter.chapterNumber,
          actId: scene.chapter.act.id,
          actTitle: scene.chapter.act.title,
          actNumber: scene.chapter.act.actNumber,
          createdAt: scene.createdAt,
          updatedAt: scene.updatedAt,
        },
      });
    } catch (error) {
      logger.error({ error, sceneId: req.params.sceneId, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to get scene');
      throw error;
    }
  }

  static async createScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      if (!await databaseService.client.chapter.findFirst({ where: { id: Number(req.params.chapterId), deletedAt: documentAuthorityEnabled() ? {} : null, act: { bookId: Number(req.params.bookId), deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } } }, select: { id: true } })) throw new NotFoundError('Chapter not found');
      const chapterId = parseInt(req.params.chapterId);
  const { prose, summary, outline } = req.body as { prose?: string; summary?: string; outline?: string };
  const selectedImageIdRaw = req.body?.selected_image_id ?? req.body?.selectedImageId;
  const selectedImageId = selectedImageIdRaw !== undefined ? Number(selectedImageIdRaw) : undefined;
  const scene = await scenesService.createSceneForChapter({ userId, chapterId, prose, summary, outline, selectedImageId, preconditions: parseDocumentMutationPreconditions(req.body.documentPreconditions) });
  respondSuccess(res, { scene }, 201);
    } catch (error) {
      logger.error({ error, chapterId: req.params.chapterId, userId: req.user?.id }, 'Failed to create scene');
      throw error;
    }
  }

  static async updateScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      if (!await databaseService.client.scene.findFirst({ where: { id: Number(req.params.sceneId), deletedAt: documentAuthorityEnabled() ? {} : null, chapter: { act: { bookId: Number(req.params.bookId), book: { userId } } } }, select: { id: true } })) throw new NotFoundError('Scene not found');
      const sceneId = parseInt(req.params.sceneId);
  const { prose, summary, outline } = req.body as { prose?: string; summary?: string; outline?: string };
    const selectedImageIdRaw = req.body?.selected_image_id ?? req.body?.selectedImageId;
    const selectedImageId = selectedImageIdRaw !== undefined ? Number(selectedImageIdRaw) : undefined;
      const updated = await scenesService.updateSceneProse(userId, sceneId, { prose, summary, outline, selectedImageId }, parseDocumentMutationPreconditions(req.body.documentPreconditions));
      respondSuccess(res, { scene: updated });
    } catch (error) {
      logger.error({ error, sceneId: req.params.sceneId, userId: req.user?.id }, 'Failed to update scene');
      throw error;
    }
  }

  static async deleteScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const sceneId = parseInt(req.params.sceneId);
      if (documentAuthorityEnabled()) {
        const receipt = await scenesService.deleteScene(userId, Number(req.params.bookId), sceneId, parseDocumentMutationPreconditions(req.body?.documentPreconditions));
        respondSuccess(res, { message: 'Scene deleted', documentReceipt: receipt }); return;
      }

  const scene = await databaseService.client.scene.findFirst({ where: { id: sceneId, chapter: { act: { book: { userId } } } }, include: { chapter: { include: { act: { select: { bookId: true } } } } } });
  if (!scene || scene.chapter.act.bookId !== Number(req.params.bookId)) throw new NotFoundError('Scene not found');
      await databaseService.client.$transaction(async (tx) => {
        // Soft-delete while freeing its scene number to avoid unique constraint
        // collisions on (chapterId, sceneNumber) during sibling renumbering.
        await tx.scene.update({
          where: { id: sceneId },
          data: {
            deletedAt: new Date(),
            sceneNumber: 1_000_000 + sceneId,
          },
        });

        const siblings = await tx.scene.findMany({
          where: { chapterId: scene.chapterId, deletedAt: null },
          orderBy: { sceneNumber: 'asc' },
        });

        // Two-phase renumber to avoid transient unique collisions.
        const tempOffset = 2_000_000;
        for (let i = 0; i < siblings.length; i++) {
          await tx.scene.update({ where: { id: siblings[i].id }, data: { sceneNumber: tempOffset + i + 1 } });
        }
        for (let i = 0; i < siblings.length; i++) {
          await tx.scene.update({ where: { id: siblings[i].id }, data: { sceneNumber: i + 1 } });
        }
      });
  const bookId = scene.chapter.act.bookId; await invalidateStructure(bookId); await invalidateExport(bookId);
  // Audit log — fire-and-forget
  import('@/services/auditLogService').then(({ auditLog }) => auditLog.record(userId, 'delete', 'scene', sceneId, { chapterId: scene.chapterId }));
  respondSuccess(res, { message: 'Scene deleted' });
    } catch (error) {
      logger.error({ error, sceneId: req.params.sceneId, userId: req.user?.id }, 'Failed to delete scene');
      throw error;
    }
  }

  /**
   * POST /api/books/:bookId/scenes/:sceneId/regenerate
   * Re-generate prose for an existing scene using SceneProseService.
   * Automatically resolves full context (book, act, chapter, previous scene continuity).
   */
  static async regenerateScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const sceneId = parseInt(req.params.sceneId);

      // Verify ownership: scene → chapter → act → book
      const scene = await databaseService.client.scene.findFirst({
        where: { id: sceneId, chapter: { act: { bookId, book: { userId } } } },
      });
      if (!scene) throw new NotFoundError('Scene not found');

      const { useCodexRAG, codexTypes, codexK, tokenBudget, selectedModel } = req.body;

      const context = {
        bookId,
        sceneId,
        title: '', // enrichSceneContext will fill from DB
        useCodexRAG: useCodexRAG !== false, // default true
        codexTypes: codexTypes ? (codexTypes as string).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        codexK: codexK ? Number(codexK) : undefined,
        tokenBudget: tokenBudget ? Number(tokenBudget) : defaultRagTokenBudget(),
      };

      const options = {
        selectedModel,
        timeoutMs: Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000,
        retries: 2,
      };

      if (documentAuthorityEnabled()) {
        const expected = parseDocumentMutationPreconditions(req.body.documentPreconditions);
        if (!expected) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Saved book/scene revisions and an operation ID are required before regeneration.', 428);
        const result = await generateOwnedScene(userId, { bookId, sceneId, expected, context, options: { selectedModel, timeoutMs: options.timeoutMs } });
        respondSuccess(res, result); return;
      }
      logger.info({ bookId, sceneId, useCodexRAG: context.useCodexRAG }, 'Regenerating scene prose');

      const service = SceneProseService.getInstance();
      const result = await service.generateProse(context, options);

      // Persist generated prose + word count
      const updated = await scenesService.updateSceneProse(userId, sceneId, {
        prose: result.prose,
        summary: undefined, // preserve existing
      });

      await invalidateExport(bookId);

      respondSuccess(res, {
        scene: updated,
        generation: {
          wordCount: result.wordCount,
          codexUsed: result.codexUsed,
          model: result.model,
          skillFindings: result.skillFindings,
        },
      });
    } catch (error) {
      logger.error({ error, sceneId: req.params.sceneId, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to regenerate scene');
      throw error;
    }
  }

  /**
   * POST /api/books/:bookId/chapters/:chapterId/scenes/generate
   * Create a new scene and optionally generate prose for it.
   * If `generate: true` in body, runs SceneProseService after creation.
   */
  static async createAndGenerateScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    try {
      const userId = req.user!.id;
      const bookId = parseInt(req.params.bookId);
      const chapterId = parseInt(req.params.chapterId);

      // Verify chapter belongs to book and user
      const chapter = await databaseService.client.chapter.findFirst({
        where: { id: chapterId, act: { bookId, book: { userId } } },
      });
      if (!chapter) throw new NotFoundError('Chapter not found');

      const { prose, summary, outline, generate, useCodexRAG, codexTypes, codexK, tokenBudget, selectedModel } = req.body;

      // Create the scene
      let scene = await scenesService.createSceneForChapter({
        userId,
        chapterId,
        prose,
        summary,
        outline,
        preconditions: parseDocumentMutationPreconditions(req.body.documentPreconditions),
      });

      let generation: Pick<SceneProseResult, 'wordCount' | 'codexUsed' | 'model' | 'skillFindings'> | undefined = undefined;

      // Optionally generate prose
      if (generate) {
        const context = {
          bookId,
          sceneId: scene.id,
          title: '', // enrichSceneContext fills from DB
          useCodexRAG: useCodexRAG !== false,
          codexTypes: codexTypes ? (codexTypes as string).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
          codexK: codexK ? Number(codexK) : undefined,
          tokenBudget: tokenBudget ? Number(tokenBudget) : defaultRagTokenBudget(),
        };

        const options = {
          selectedModel,
          timeoutMs: Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000,
          retries: 2,
        };

        logger.info({ bookId, chapterId, sceneId: scene.id, generate: true }, 'Generating prose for new scene');

        const service = SceneProseService.getInstance();
        let result: SceneProseResult;
        if (documentAuthorityEnabled() && scene.documentRevision) {
          const committed = scene.documentRevision;
          const saved = await generateOwnedScene(userId, { bookId, sceneId: scene.id, expected: { operationId: req.body.generationOperationId ?? compatibilityOperationId('proser.create-scene-generation.v1', { parentOperationId: committed.operationId, sceneId: scene.id }), expectedRevisionId: committed.bookRevisionId, expectedSceneRevisionId: committed.sceneRevisionId, expectedScopes: {} }, context, options: { selectedModel, timeoutMs: options.timeoutMs } });
          scene = saved.scene; result = saved.generation;
        } else {
          result = await service.generateProse(context, options);
          await scenesService.updateSceneProse(userId, scene.id, { prose: result.prose });
        }

        generation = {
          wordCount: result.wordCount,
          codexUsed: result.codexUsed,
          model: result.model,
          skillFindings: result.skillFindings,
        };
      }

      await invalidateStructure(bookId);
      await invalidateExport(bookId);

      // Re-fetch to get final state
      const final = documentAuthorityEnabled() ? scene : await databaseService.client.scene.findUnique({ where: { id: scene.id } });

      respondSuccess(res, { scene: final, generation }, 201);
    } catch (error) {
      logger.error({ error, chapterId: req.params.chapterId, bookId: req.params.bookId, userId: req.user?.id }, 'Failed to create and generate scene');
      throw error;
    }
  }
}
