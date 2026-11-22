import { Response } from 'express';
import { AuthenticatedRequest, ApiResponse, CreateBookRequest } from '../types';
import { booksService } from '../../services/booksService';
import { databaseService } from '../../lib/database';
import { invalidateStructure, invalidateExport } from '../../lib/redis/contentCache';
import logger from '../../lib/logger';
import { respondSuccess, respondError, ErrorCodes } from '../utils/response';
import { documentAuthorityEnabled, documentService, DocumentError } from '@/documents/service';
import { catalogCommand } from '@/documents/catalogCommands';
import { parseDocumentMutationPreconditions } from '@/api/schemas/documents';
import { includeCompatibilityProse } from '@/documents/readProjection';
import { claimNovaResource, novaVisibleBookIds } from '../middleware/novaGrant';

export class BooksController {
  static async getBooks(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const visibleIds = await novaVisibleBookIds(req);
    const result = await booksService.listBooks(userId, {
      page: parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 20,
      ...(visibleIds ? { ids: visibleIds } : {}),
    });
    logger.info({ userId, bookCount: result.books.length }, 'Retrieved user books');
    respondSuccess(res, result);
  }

  static async createBook(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const { title, genre, targetAudience, summary }: CreateBookRequest = req.body;
    const newBook = await booksService.createBook(userId, { title, genre, targetAudience, summary }, req.body.operationId);
    await claimNovaResource(req, 'book', newBook.id);
    logger.info({ userId, bookId: newBook.id, title }, 'Created new book');
    respondSuccess(res, newBook, 201);
  }

  static async getBook(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.id);
    const book = await booksService.getBook(userId, bookId, { includeProse: includeCompatibilityProse(req.query.includeProse) });
    res.setHeader('Cache-Control', 'private, no-store');
    logger.info({ userId, bookId }, 'Retrieved book details');
    respondSuccess(res, book);
  }

  static async updateBook(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.id);
    const updatedBook = await booksService.updateBook(userId, bookId, req.body, parseDocumentMutationPreconditions(req.body.documentPreconditions));
    logger.info({ userId, bookId }, 'Updated book');
    respondSuccess(res, updatedBook);
  }

  static async deleteBook(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.id);
    const receipt = await booksService.deleteBook(userId, bookId, parseDocumentMutationPreconditions(req.body?.documentPreconditions));
    logger.info({ userId, bookId }, 'Deleted book');
    respondSuccess(res, { message: 'Book deleted successfully', ...(receipt ? { documentReceipt: receipt } : {}) });
  }

  /**
   * POST /:bookId/reset — Wipe all generated content for a book:
   * acts, chapters, scenes, workflow history, revisions, reviews,
   * memory events, character states, plot threads, skill runs, codex usage.
   * Preserves the book record, codex entries, and notes.
   */
  static async resetBook(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = parseInt(req.params.bookId);
    const signal = req.operationSignal;
    signal?.throwIfAborted();

    // Verify ownership
    const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) {
      respondError(res, ErrorCodes.NOT_FOUND, 'Book not found', 404);
      return;
    }
    signal?.throwIfAborted();

    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(parseDocumentMutationPreconditions(req.body?.documentPreconditions), { command: 'reset-book-structure' }), async (tx) => {
        signal?.throwIfAborted();
        if (await tx.workflowRun.count({ where: { bookId, status: { in: ['running', 'queued'] } } })) throw new DocumentError('DOCUMENT_WORKFLOW_ACTIVE', 'Pause or cancel active book workflows before resetting structure.', 409);
        const now = new Date();
        await tx.scene.updateMany({ where: { chapter: { act: { bookId } }, deletedAt: null }, data: { deletedAt: now } });
        await tx.chapter.updateMany({ where: { act: { bookId }, deletedAt: null }, data: { deletedAt: now } });
        await tx.act.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt: now } });
        await tx.sceneCodexUsage.updateMany({ where: { scene: { chapter: { act: { bookId } } }, deletedAt: null }, data: { deletedAt: now } });
        signal?.throwIfAborted();
        return { result: { bookId } };
      });
      respondSuccess(res, { message: 'Book structure reset; revisions and workflow evidence preserved', documentReceipt: receipt }); return;
    }
    await databaseService.client.$transaction(async (prisma) => {
      // Keep the destructive reset atomic. Cancellation between statements
      // throws from the transaction and rolls every prior deletion back.
      signal?.throwIfAborted();
      await prisma.workflowRun.deleteMany({ where: { bookId } });
      signal?.throwIfAborted();
      await prisma.manuscriptRevision.deleteMany({ where: { bookId } });
      signal?.throwIfAborted();
      await prisma.sceneMemoryEvent.deleteMany({ where: { bookId } });
      await prisma.characterState.deleteMany({ where: { bookId } });
      await prisma.plotThread.deleteMany({ where: { bookId } });
      signal?.throwIfAborted();
      await prisma.skillRun.deleteMany({ where: { bookId } });
      await prisma.act.deleteMany({ where: { bookId } });
      signal?.throwIfAborted();
    }, { maxWait: 5_000, timeout: 110_000 });

    // 6. Invalidate caches
    signal?.throwIfAborted();
    try { await invalidateStructure(bookId); await invalidateExport(bookId); } catch {}

    signal?.throwIfAborted();
    logger.info({ userId, bookId }, 'Book content reset');
    respondSuccess(res, { message: 'Book content reset successfully' });
  }
}
