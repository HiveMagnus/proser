import { databaseService, withDatabaseBusyRetry } from '../lib/database';
import { BookRepository } from '../core/persistence/bookRepository';
import { NotFoundError } from '../lib/errors';
import logger from '../lib/logger';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import { readCanonicalBookProjection } from '@/documents/readProjection';
import { catalogCommand, catalogResult } from '@/documents/catalogCommands';

class BooksService {
  async listBooks(userId: number, opts: { page?: number; pageSize?: number; ids?: number[] }) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, opts.pageSize ?? 20);
    const where = { userId, ...(documentAuthorityEnabled() ? { deletedAt: null } : {}), ...(opts.ids ? { id: { in: opts.ids } } : {}) };
    const total = await databaseService.client.book.count({ where });
    if (documentAuthorityEnabled()) {
      const identities = await databaseService.client.book.findMany({ where, select: { id: true }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize });
      const books = [];
      for (const identity of identities) {
        const projection = await readCanonicalBookProjection(userId, identity.id, { includeNotes: false });
        // List cards retain revision-bound counts and navigation metadata, never
        // document bodies, note contents or duplicate codex entries.
        const { notes: _notes, codexEntries: _codexEntries, ...metadata } = projection;
        books.push(metadata);
      }
      return { books, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
    }
    const books = await databaseService.client.book.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { acts: true, codexEntries: true, notes: true } },
        acts: {
          select: {
            chapters: {
              select: {
                scenes: {
                  select: { wordCount: true },
                },
              },
            },
          },
        },
      },
    });

    const booksWithWordCount = books.map((book) => ({
      ...book,
      wordCount: book.acts.reduce(
        (bookTotal, act) =>
          bookTotal + act.chapters.reduce(
            (chapterTotal, chapter) =>
              chapterTotal + chapter.scenes.reduce(
                (sceneTotal, scene) => sceneTotal + (scene.wordCount ?? 0),
                0,
              ),
            0,
          ),
        0,
      ),
    }));

    return {
      books: booksWithWordCount,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async createBook(userId: number, data: { title?: string; genre?: string; targetAudience?: string; summary?: string }, operationId?: string) {
    const repo = new BookRepository(databaseService.client);
    return repo.create({
      userId,
      title: data.title || null,
      genre: data.genre || null,
      targetAudience: data.targetAudience || null,
      summary: data.summary || null,
    }, operationId);
  }

  async getBook(userId: number, bookId: number, options: { includeProse?: boolean } = {}) {
    if (documentAuthorityEnabled()) return readCanonicalBookProjection(userId, bookId, options);
    const book = await databaseService.client.book.findFirst({
      where: { id: bookId, userId },
      include: {
        acts: { include: { chapters: { include: { scenes: true } } } },
        codexEntries: true,
        notes: true,
        _count: { select: { acts: true, codexEntries: true, notes: true } }
      }
    });
    if (!book) throw new NotFoundError('Book not found');
    return book;
  }

  async updateBook(userId: number, bookId: number, rawBody: Record<string, unknown>, expected?: DocumentMutationPreconditions) {
    const updateData: Record<string, unknown> = { ...rawBody };
    // normalize snake_case
    if (rawBody?.selected_image_id !== undefined && updateData.selectedImageId === undefined) {
      updateData.selectedImageId = Number(rawBody.selected_image_id) || 0;
    }
    if (rawBody?.story_archetype_key !== undefined && updateData.storyArchetypeKey === undefined) {
      updateData.storyArchetypeKey = String(rawBody.story_archetype_key);
    }
    delete updateData.selected_image_id;
    delete updateData.story_archetype_key;

    // Normalize draftStatus
    if (typeof updateData.draftStatus === 'string') {
      const raw = String(updateData.draftStatus).trim().toLowerCase();
      const normalized = raw === 'completed' ? 'final' : raw;
      const allowed = ['draft', 'final'];
      if (allowed.includes(normalized)) {
        updateData.draftStatus = normalized;
      } else {
        delete updateData.draftStatus;
      }
    }

    // Whitelist allowed columns
    const allowedKeys = new Set([
      'title', 'genre', 'targetAudience', 'summary', 'tagline', 'storyOutline',
      'draftStatus', 'selectedImageId', 'storyArchetypeKey'
    ]);
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updateData)) {
      if (allowedKeys.has(k) && v !== undefined) sanitized[k] = v;
    }

    const existing = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!existing) throw new NotFoundError('Book not found');

    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'update-book', patch: sanitized }), async (tx) => ({ result: await tx.book.update({ where: { id: bookId }, data: { ...sanitized, updatedAt: new Date() } }) }));
      return catalogResult(receipt);
    }
    try {
      return await databaseService.client.book.update({
        where: { id: bookId },
        data: { ...sanitized, updatedAt: new Date() }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ bookId, userId, err: msg, sanitized }, 'Primary book update failed, attempting fallback without storyArchetypeKey');
      if (Object.prototype.hasOwnProperty.call(sanitized, 'storyArchetypeKey')) {
        const { storyArchetypeKey: _storyArchetypeKey, ...rest } = sanitized;
        return databaseService.client.book.update({
          where: { id: bookId },
          data: { ...rest, updatedAt: new Date() }
        });
      }
      throw e;
    }
  }

  async deleteBook(userId: number, bookId: number, expected?: DocumentMutationPreconditions) {
    const existing = await databaseService.client.book.findFirst({ where: { id: bookId, userId, deletedAt: documentAuthorityEnabled() ? {} : null } });
    if (!existing) throw new NotFoundError('Book not found');
    if (documentAuthorityEnabled()) return documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'delete-book', bookId }), async (tx) => {
      await tx.book.update({ where: { id: bookId }, data: { deletedAt: new Date() } });
      return { result: { bookId } };
    });
    await withDatabaseBusyRetry(() => databaseService.client.book.delete({ where: { id: bookId } }));
    // Audit log — fire-and-forget
    const { auditLog } = await import('@/services/auditLogService');
    auditLog.record(userId, 'delete', 'book', bookId, { title: existing.title });
    return undefined;
  }
}

export const booksService = new BooksService();
