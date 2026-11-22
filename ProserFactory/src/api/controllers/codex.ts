import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse, CreateCodexEntryRequest, UpdateCodexEntryRequest } from '../types';
import { codexService } from '../../services/codexService';
import logger from '../../lib/logger';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { respondSuccess } from '../utils/response';

export class CodexController {
  static async getCodexEntries(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const result = await codexService.listEntries(userId, bookId, {
      page: parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 50,
    });
    logger.info({ userId, bookId, entryCount: result.entries.length }, 'Retrieved codex entries');
    respondSuccess(res, result);
  }

  static async createCodexEntry(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const { entryType, entryName, entryDescription, attributes }: CreateCodexEntryRequest = req.body;
    const entry = await codexService.createEntry(userId, bookId, { entryType, entryName, entryDescription, attributes }, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, bookId, entryId: entry.id, entryType, entryName }, 'Created codex entry');
    respondSuccess(res, entry, 201);
  }

  static async getCodexEntry(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const entryId = parseInt(req.params.id);
    const entry = await codexService.getEntry(userId, entryId);
    logger.info({ userId, entryId }, 'Retrieved codex entry');
    respondSuccess(res, entry);
  }

  static async updateCodexEntry(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const entryId = parseInt(req.params.id);
    const body = (req.body || {}) as Record<string, unknown>;
    const entryType = (body.entryType ?? body.entry_type) as UpdateCodexEntryRequest['entryType'];
    const entryName = (body.entryName ?? body.entry_name) as string | undefined;
    const entryDescription = (body.entryDescription ?? body.entry_description) as string | undefined;
    const attributes = (body.attributes ?? body.attributes_json) as string | undefined;
    const updateData: UpdateCodexEntryRequest = {
      ...(entryType !== undefined ? { entryType } : {}),
      ...(entryName !== undefined ? { entryName } : {}),
      ...(entryDescription !== undefined ? { entryDescription } : {}),
      ...(attributes !== undefined ? { attributes } : {}),
    };
    const updated = await codexService.updateEntry(userId, entryId, updateData, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, entryId }, 'Updated codex entry');
    respondSuccess(res, updated);
  }

  static async deleteCodexEntry(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const entryId = parseInt(req.params.id);
    const receipt = await codexService.deleteEntry(userId, entryId, parseDocumentMutationPreconditions(req.body?.documentPreconditions));
    logger.info({ userId, entryId }, 'Deleted codex entry');
    respondSuccess(res, { message: 'Codex entry deleted successfully', ...(receipt ? { documentReceipt: receipt } : {}) });
  }
}
