import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse } from '../types';
import { actsService } from '../../services/actsService';
import logger from '../../lib/logger';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { respondSuccess } from '../utils/response';

export class ActsController {
  static async createAct(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const { title, summary } = req.body as { title?: string; summary?: string };
    const act = await actsService.createAct(userId, bookId, { title, summary }, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, bookId, actId: act.id }, 'Created act');
    respondSuccess(res, { act }, 201);
  }

  static async updateAct(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const actId = parseInt(req.params.actId);
    const { title, summary } = req.body as { title?: string; summary?: string };
    const selectedImageIdRaw = req.body?.selected_image_id ?? req.body?.selectedImageId;
    const selectedImageId = selectedImageIdRaw !== undefined ? Number(selectedImageIdRaw) : undefined;
    const updated = await actsService.updateAct(userId, bookId, actId, { title, summary, selectedImageId }, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, bookId, actId }, 'Updated act');
    respondSuccess(res, { act: updated });
  }

  static async deleteAct(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const actId = parseInt(req.params.actId);
    const receipt = await actsService.deleteAct(userId, bookId, actId, parseDocumentMutationPreconditions(req.body?.documentPreconditions));
    logger.info({ userId, bookId, actId }, 'Deleted act');
    respondSuccess(res, { message: 'Act deleted', ...(receipt ? { documentReceipt: receipt } : {}) });
  }
}
