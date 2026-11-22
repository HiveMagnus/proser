import { randomUUID } from 'node:crypto';
import { documentService } from './service';
import { documentFromText } from './model';
import { DocumentError } from './errors';
import type { DocumentQuickDraftInput, DocumentQuickDraftReceipt } from './scope-model';

/** Create the missing drafting hierarchy and scene in one guarded transaction.
 * Never replace existing identities or rebase an intent onto a newer head. */
export async function createDocumentQuickDraft(userId: number, bookId: number, input: DocumentQuickDraftInput): Promise<DocumentQuickDraftReceipt> {
  if (!input.expectedScopes?.structure) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'The source structure revision is required.', 428);
  return documentService.mutateCatalog(userId, bookId, {
    operationId: input.operationId, expectedRevisionId: input.expectedRevisionId,
    expectedScopes: input.expectedScopes, payload: { command: 'quick-draft', schemaVersion: input.schemaVersion, summary: input.summary, outline: input.outline },
  }, async (tx) => {
    const acts = await tx.act.findMany({ where: { bookId, deletedAt: null }, orderBy: [{ actNumber: 'asc' }, { id: 'asc' }],
      include: { chapters: { where: { deletedAt: null }, orderBy: [{ chapterNumber: 'asc' }, { id: 'asc' }] } } });
    let actId: number | undefined;
    let chapterId: number | undefined;
    for (const act of acts) {
      const chapter = act.chapters.find((item) => item.title?.trim().toLowerCase() === 'mobile drafts');
      if (chapter) { actId = act.id; chapterId = chapter.id; break; }
    }
    if (!actId) {
      actId = acts[0]?.id;
      if (!actId) {
        const maximum = await tx.act.aggregate({ where: { bookId }, _max: { actNumber: true } });
        actId = (await tx.act.create({ data: { bookId, actNumber: Math.max(0, maximum._max.actNumber ?? 0) + 1, title: 'Act I', summary: 'Phone-first drafting workspace' } })).id;
      }
    }
    if (!chapterId) {
      const maximum = await tx.chapter.aggregate({ where: { actId }, _max: { chapterNumber: true } });
      chapterId = (await tx.chapter.create({ data: { actId, chapterNumber: Math.max(0, maximum._max.chapterNumber ?? 0) + 1, title: 'Mobile Drafts', summary: 'Scenes created quickly from the mobile authoring flow.' } })).id;
    }
    const maximum = await tx.scene.aggregate({ where: { chapterId }, _max: { sceneNumber: true } });
    const scene = await tx.scene.create({ data: { chapterId, sceneNumber: Math.max(0, maximum._max.sceneNumber ?? 0) + 1, summary: input.summary, outline: input.outline } });
    return { result: { command: 'quick-draft' as const, actId, chapterId, sceneId: scene.id }, newDocuments: [{ sceneId: scene.id, document: documentFromText('', randomUUID) }] };
  });
}
