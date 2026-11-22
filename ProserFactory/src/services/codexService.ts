import { databaseService } from '../lib/database';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { documentAuthorityEnabled, documentService, type DocumentOrigin } from '@/documents/service';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import { assertOperatorApplication } from '@/documents/operatorEffects';
import { catalogCommand, catalogResult } from '@/documents/catalogCommands';
import { NotFoundError } from '../lib/errors';
import { stripSurroundingMarkup } from '../lib/utils/sanitize';
import { invalidateRagCodex } from '../lib/redis/contentCache';
import { indexCodexEntry, removeCodexEntryIndex } from '../lib/rag/indexer';

class CodexService {
  async createEntries(userId: number, bookId: number, raw: unknown, expected: DocumentMutationPreconditions, origin: DocumentOrigin = 'manual', operatorResult?: unknown) {
    const entries = z.array(z.object({ entryType: z.string().min(1).max(100), entryName: z.string().min(1).max(500), entryDescription: z.string().max(20000).optional(), attributes: z.string().max(20000).optional() }).strict()).min(1).max(200).parse(raw);
    const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'create-codex-batch', entries }), async (tx) => {
      if (operatorResult !== undefined) await assertOperatorApplication(tx, userId, bookId, expected.operationId, expected.expectedRevisionId, operatorResult);
      const result = [];
      for (const data of entries) result.push(await tx.codexEntry.create({ data: { ...data, bookId, entryName: stripSurroundingMarkup(data.entryName), entryDescription: data.entryDescription ?? '', attributes: data.attributes ?? null } }));
      return { result: { entries: result } };
    }, origin);
    await invalidateRagCodex(bookId);
    for (const entry of receipt.result.entries) indexCodexEntry(entry).catch(() => {});
    return catalogResult(receipt);
  }
  async listEntries(userId: number, bookId: number, opts: { page?: number; pageSize?: number }) {
    const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) throw new NotFoundError('Book not found');
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, opts.pageSize ?? 50);
    const total = await databaseService.client.codexEntry.count({ where: { bookId } });
    const entries = await databaseService.client.codexEntry.findMany({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize
    });
    return { entries, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  async createEntry(userId: number, bookId: number, data: { entryType: string; entryName: string; entryDescription?: string; attributes?: string }, expected?: DocumentMutationPreconditions) {
    const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) throw new NotFoundError('Book not found');
    const entryName = stripSurroundingMarkup(data.entryName);
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'create-codex', data }), async (tx) => ({ result: await tx.codexEntry.create({ data: { bookId, entryType: data.entryType, entryName, entryDescription: data.entryDescription ?? '', attributes: data.attributes ?? null } }) }));
      const entry = catalogResult(receipt);
      await invalidateRagCodex(bookId); indexCodexEntry(entry).catch(() => {});
      return entry;
    }
    const entry = await databaseService.client.codexEntry.create({
      data: {
        bookId,
        entryType: data.entryType,
        entryName,
        entryDescription: data.entryDescription || '',
        attributes: data.attributes ?? null,
      }
    });
    await invalidateRagCodex(bookId);
    // Index into unified RAG pipeline (fire-and-forget)
    indexCodexEntry(entry).catch(() => {});
    return entry;
  }

  async getEntry(userId: number, entryId: number) {
    const entry = await databaseService.client.codexEntry.findFirst({
      where: { id: entryId, book: { userId } },
      include: { book: true }
    });
    if (!entry) throw new NotFoundError('Codex entry not found');
    return entry;
  }

  async updateEntry(userId: number, entryId: number, data: { entryType?: string; entryName?: string; entryDescription?: string; attributes?: string }, expected?: DocumentMutationPreconditions) {
    const existing = await databaseService.client.codexEntry.findFirst({
      where: { id: entryId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } }
    });
    if (!existing) throw new NotFoundError('Codex entry not found');
    const updateData: Prisma.CodexEntryUpdateInput = { ...data, updatedAt: new Date() };
    if (updateData.entryName && typeof updateData.entryName === 'string') updateData.entryName = stripSurroundingMarkup(updateData.entryName);
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, existing.bookId, catalogCommand(expected, { command: 'update-codex', entryId, data }), async (tx) => {
        if (existing.deletedAt) throw new NotFoundError('Codex entry not found');
        return { result: await tx.codexEntry.update({ where: { id: entryId }, data: updateData }) };
      });
      const updated = catalogResult(receipt);
      await invalidateRagCodex(existing.bookId); indexCodexEntry(updated).catch(() => {});
      return updated;
    }
    const updated = await databaseService.client.codexEntry.update({
      where: { id: entryId },
      data: updateData
    });
    await invalidateRagCodex(existing.bookId);
    // Re-index into unified RAG pipeline (fire-and-forget)
    indexCodexEntry(updated).catch(() => {});
    return updated;
  }

  async deleteEntry(userId: number, entryId: number, expected?: DocumentMutationPreconditions) {
    const existing = await databaseService.client.codexEntry.findFirst({
      where: { id: entryId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } }
    });
    if (!existing) throw new NotFoundError('Codex entry not found');
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, existing.bookId, catalogCommand(expected, { command: 'delete-codex', entryId }), async (tx) => {
        if (existing.deletedAt) throw new NotFoundError('Codex entry not found');
        await tx.codexEntry.update({ where: { id: entryId }, data: { deletedAt: new Date() } });
        return { result: { entryId } };
      });
      await invalidateRagCodex(existing.bookId); removeCodexEntryIndex(existing.bookId, entryId).catch(() => {});
      return receipt;
    }
    await databaseService.client.codexEntry.delete({ where: { id: entryId } });
    await invalidateRagCodex(existing.bookId);
    // Remove from unified RAG index (fire-and-forget)
    removeCodexEntryIndex(existing.bookId, entryId).catch(() => {});
    // Audit log — fire-and-forget
    const { auditLog } = await import('@/services/auditLogService');
    auditLog.record(userId, 'delete', 'codex_entry', entryId, { entryName: existing.entryName, entryType: existing.entryType });
    return undefined;
  }
}

export const codexService = new CodexService();
