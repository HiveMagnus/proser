import { databaseService } from '../lib/database';
import { NotFoundError } from '../lib/errors';
import { documentAuthorityEnabled, documentService } from '@/documents/service';
import type { DocumentMutationPreconditions } from '@/documents/scope-model';
import { catalogCommand, catalogResult } from '@/documents/catalogCommands';
import { orderChapters } from '@/documents/structureOrder';
import { invalidateStructure, invalidateExport } from '../lib/redis/contentCache';

class ChaptersService {
  async createChapter(userId: number, bookId: number, actId: number, data: { title?: string; summary?: string }, expected?: DocumentMutationPreconditions) {
    const act = await databaseService.client.act.findFirst({
      where: { id: actId, bookId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } },
      include: { chapters: true }
    });
    if (!act) throw new NotFoundError('Act not found');
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'create-chapter', actId, data }), async (tx) => {
        if (act.deletedAt) throw new NotFoundError('Act not found');
        const maximum = await tx.chapter.aggregate({ where: { actId }, _max: { chapterNumber: true } });
        return { result: await tx.chapter.create({ data: { actId, chapterNumber: Math.max(0, maximum._max.chapterNumber ?? 0) + 1, ...data } }) };
      });
      return catalogResult(receipt);
    }
    const chapterNumber = act.chapters.length + 1;
    const chapter = await databaseService.client.chapter.create({
      data: { actId, chapterNumber, title: data.title ?? null, summary: data.summary ?? null }
    });
    await invalidateStructure(bookId);
    await invalidateExport(bookId);
    return chapter;
  }

  async updateChapter(userId: number, bookId: number, chapterId: number, data: { title?: string; summary?: string; selectedImageId?: number }, expected?: DocumentMutationPreconditions) {
    const chapter = await databaseService.client.chapter.findFirst({
      where: { id: chapterId, deletedAt: documentAuthorityEnabled() ? {} : null, act: { bookId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } } }
    });
    if (!chapter) throw new NotFoundError('Chapter not found');
    if (documentAuthorityEnabled()) {
      const receipt = await documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'update-chapter', chapterId, data }), async (tx) => { if (chapter.deletedAt) throw new NotFoundError('Chapter not found'); return { result: await tx.chapter.update({ where: { id: chapterId }, data: { ...(data.title !== undefined ? { title: data.title } : {}), ...(data.summary !== undefined ? { summary: data.summary } : {}), ...(data.selectedImageId !== undefined ? { selectedImageId: data.selectedImageId || 0 } : {}) } }) }; });
      return catalogResult(receipt);
    }
    const updated = await databaseService.client.chapter.update({
      where: { id: chapterId },
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

  async deleteChapter(userId: number, bookId: number, chapterId: number, expected?: DocumentMutationPreconditions) {
    const chapter = await databaseService.client.chapter.findFirst({
      where: { id: chapterId, deletedAt: documentAuthorityEnabled() ? {} : null, act: { bookId, deletedAt: documentAuthorityEnabled() ? {} : null, book: { userId } } },
      include: { scenes: { select: { id: true } } }
    });
    if (!chapter) throw new NotFoundError('Chapter not found');
    if (documentAuthorityEnabled()) return documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'delete-chapter', chapterId }), async (tx) => {
      if (chapter.deletedAt) throw new NotFoundError('Chapter not found');
      const now = new Date();
      await tx.scene.updateMany({ where: { chapterId, deletedAt: null }, data: { deletedAt: now } });
      await tx.chapter.update({ where: { id: chapterId }, data: { deletedAt: now } });
      await orderChapters(tx, chapter.actId);
      return { result: { chapterId } };
    });
    await databaseService.client.$transaction(async (tx) => {
      if (chapter.scenes.length) {
        await tx.scene.deleteMany({ where: { chapterId } });
      }
      await tx.chapter.delete({ where: { id: chapterId } });
      const siblings = await tx.chapter.findMany({
        where: { actId: chapter.actId },
        orderBy: { chapterNumber: 'asc' }
      });
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].chapterNumber !== i + 1) {
          await tx.chapter.update({ where: { id: siblings[i].id }, data: { chapterNumber: i + 1 } });
        }
      }
    });
    await invalidateStructure(bookId);
    await invalidateExport(bookId);
    return undefined;
  }
}

export const chaptersService = new ChaptersService();
