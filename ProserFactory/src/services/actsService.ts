import { databaseService } from '../lib/database';
import { NotFoundError } from '../lib/errors';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import { catalogCommand, catalogResult } from '@/documents/catalogCommands';
import { orderActs } from '@/documents/structureOrder';
import { invalidateStructure, invalidateExport } from '../lib/redis/contentCache';

class ActsService {
  async createAct(userId: number, bookId: number, data: { title?: string; summary?: string }, expected?: DocumentMutationPreconditions) {
    const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
    if (!book) throw new NotFoundError('Book not found');
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'create-act', data }), async (tx) => {
        const maximum = await tx.act.aggregate({ where: { bookId }, _max: { actNumber: true } });
        return { result: await tx.act.create({ data: { bookId, actNumber: Math.max(0, maximum._max.actNumber ?? 0) + 1, ...data } }) };
      });
      return catalogResult(receipt);
    }
    const nextNumber = (await databaseService.client.act.count({ where: { bookId } })) + 1;
    const act = await databaseService.client.act.create({
      data: { bookId, actNumber: nextNumber, title: data.title ?? null, summary: data.summary ?? null }
    });
    await invalidateStructure(bookId);
    await invalidateExport(bookId);
    return act;
  }

  async updateAct(userId: number, bookId: number, actId: number, data: { title?: string; summary?: string; selectedImageId?: number }, expected?: DocumentMutationPreconditions) {
    const act = await databaseService.client.act.findFirst({ where: { id: actId, bookId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } } });
    if (!act) throw new NotFoundError('Act not found');
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'update-act', actId, data }), async (tx) => { if (act.deletedAt) throw new NotFoundError('Act not found'); return { result: await tx.act.update({ where: { id: actId }, data: { ...(data.title !== undefined ? { title: data.title } : {}), ...(data.summary !== undefined ? { summary: data.summary } : {}), ...(data.selectedImageId !== undefined ? { selectedImageId: data.selectedImageId || 0 } : {}) } }) }; });
      return catalogResult(receipt);
    }
    const updated = await databaseService.client.act.update({
      where: { id: actId },
      data: {
        title: data.title ?? null,
        summary: data.summary ?? null,
        ...(data.selectedImageId !== undefined ? { selectedImageId: data.selectedImageId || 0 } : {})
      }
    });
    await invalidateStructure(bookId);
    await invalidateExport(bookId);
    return updated;
  }

  async deleteAct(userId: number, bookId: number, actId: number, expected?: DocumentMutationPreconditions) {
    const act = await databaseService.client.act.findFirst({
      where: { id: actId, bookId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } },
      include: { chapters: { select: { id: true, scenes: { select: { id: true } } } } }
    });
    if (!act) throw new NotFoundError('Act not found');
    if (documentAuthorityEnabled()) return documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'delete-act', actId }), async (tx) => {
      if (act.deletedAt) throw new NotFoundError('Act not found');
      const now = new Date();
      await tx.scene.updateMany({ where: { chapter: { actId }, deletedAt: null }, data: { deletedAt: now } });
      await tx.chapter.updateMany({ where: { actId, deletedAt: null }, data: { deletedAt: now } });
      await tx.act.update({ where: { id: actId }, data: { deletedAt: now } });
      await orderActs(tx, bookId);
      return { result: { actId } };
    });
    await databaseService.client.$transaction(async (tx) => {
      for (const chapter of act.chapters) {
        if (chapter.scenes.length) {
          await tx.scene.deleteMany({ where: { chapterId: chapter.id } });
        }
      }
      if (act.chapters.length) {
        await tx.chapter.deleteMany({ where: { actId } });
      }
      await tx.act.delete({ where: { id: actId } });
      const remaining = await tx.act.findMany({ where: { bookId }, orderBy: { actNumber: 'asc' } });
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].actNumber !== i + 1) {
          await tx.act.update({ where: { id: remaining[i].id }, data: { actNumber: i + 1 } });
        }
      }
    });
    await invalidateStructure(bookId);
    await invalidateExport(bookId);
    return undefined;
  }
}

export const actsService = new ActsService();
