import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { documentService, type CatalogReceipt } from './service';
import { catalogCommand } from './catalogCommands';
import { assertOperatorApplication } from './operatorEffects';
import type { DocumentMutationPreconditions } from './scope-model';

const scene = z.object({ outline: z.string().max(20000).optional(), summary: z.string().max(20000).optional() }).strict();
const chapter = z.object({ title: z.string().max(500).optional(), summary: z.string().max(20000).optional(), scenes: z.array(scene).max(100) }).strict();
export const outlineTreeSchema = z.object({ acts: z.array(z.object({ title: z.string().max(500).optional(), summary: z.string().max(20000).optional(), chapters: z.array(chapter).max(100) }).strict()).min(1).max(20) }).strict();
export type OutlineTree = z.infer<typeof outlineTreeSchema>;
export interface CreatedHierarchy { acts: Array<{ id: number; chapters: Array<{ id: number; sceneIds: number[] }> }> }

/** Create only new identities. Existing acts, chapters, scenes and their
 * documents survive, including when a generated outline is appended. */
export async function appendHierarchy(tx: Prisma.TransactionClient, bookId: number, tree: OutlineTree): Promise<CreatedHierarchy> {
  const last = await tx.act.aggregate({ where: { bookId }, _max: { actNumber: true } });
  const result: CreatedHierarchy = { acts: [] };
  for (const [index, act] of tree.acts.entries()) {
    const createdAct = await tx.act.create({ data: { bookId, actNumber: Math.max(0, last._max.actNumber ?? 0) + index + 1, title: act.title, summary: act.summary } });
    const created: CreatedHierarchy['acts'][number] = { id: createdAct.id, chapters: [] }; result.acts.push(created);
    for (const [chapterIndex, item] of act.chapters.entries()) {
      const row = await tx.chapter.create({ data: { actId: createdAct.id, chapterNumber: chapterIndex + 1, title: item.title, summary: item.summary } });
      const child = { id: row.id, sceneIds: [] as number[] }; created.chapters.push(child);
      for (const [sceneIndex, entry] of item.scenes.entries()) {
        const body = await tx.scene.create({ data: { chapterId: row.id, sceneNumber: sceneIndex + 1, outline: entry.outline, summary: entry.summary } });
        child.sceneIds.push(body.id);
      }
    }
  }
  return result;
}
export async function commitOutline(userId: number, bookId: number, raw: unknown, expected?: DocumentMutationPreconditions, operatorResult?: unknown): Promise<CatalogReceipt<CreatedHierarchy>> {
  const tree = outlineTreeSchema.parse(raw);
  return documentService.mutateCatalog(userId, bookId, catalogCommand(expected, { command: 'append-outline', tree }), async (tx) => { if (operatorResult !== undefined) await assertOperatorApplication(tx, userId, bookId, expected!.operationId, expected!.expectedRevisionId, operatorResult); return { result: await appendHierarchy(tx, bookId, tree) }; }, operatorResult !== undefined ? 'ai' : 'manual');
}
