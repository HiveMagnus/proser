import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse } from '../types';
import { chaptersService } from '../../services/chaptersService';
import logger from '../../lib/logger';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { respondSuccess } from '../utils/response';

export class ChaptersController {
  static async createChapter(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const actId = parseInt(req.params.actId);
    const { title, summary } = req.body as { title?: string; summary?: string };
    const chapter = await chaptersService.createChapter(userId, bookId, actId, { title, summary }, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, bookId, actId, chapterId: chapter.id }, 'Created chapter');
    respondSuccess(res, { chapter }, 201);
  }

  static async updateChapter(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const chapterId = parseInt(req.params.chapterId);
    const { title, summary } = req.body as { title?: string; summary?: string };
    const selectedImageIdRaw = req.body?.selected_image_id ?? req.body?.selectedImageId;
    const selectedImageId = selectedImageIdRaw !== undefined ? Number(selectedImageIdRaw) : undefined;
    const updated = await chaptersService.updateChapter(userId, bookId, chapterId, { title, summary, selectedImageId }, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, bookId, chapterId }, 'Updated chapter');
    respondSuccess(res, { chapter: updated });
  }

  static async deleteChapter(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const chapterId = parseInt(req.params.chapterId);
    const receipt = await chaptersService.deleteChapter(userId, bookId, chapterId, parseDocumentMutationPreconditions(req.body?.documentPreconditions));
    logger.info({ userId, bookId, chapterId }, 'Deleted chapter');
    respondSuccess(res, { message: 'Chapter deleted', ...(receipt ? { documentReceipt: receipt } : {}) });
  }
}
