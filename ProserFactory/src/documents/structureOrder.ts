import type { Prisma } from '@prisma/client';
import { DocumentError } from './errors';
function validateOrder(activeIds: number[], orderedIds: number[]) {
  if (new Set(orderedIds).size !== orderedIds.length || activeIds.length !== orderedIds.length || orderedIds.some((id) => !activeIds.includes(id))) throw new DocumentError('DOCUMENT_ORDER_INVALID', 'Reorder must identify every active owned child exactly once.', 409);
}
export async function orderActs(tx: Prisma.TransactionClient, bookId: number, requested?: number[]) {
  const all = await tx.act.findMany({ where: { bookId }, orderBy: { actNumber: 'asc' }, select: { id: true, deletedAt: true } });
  const active = all.filter((row) => !row.deletedAt).map((row) => row.id); const ordered = requested ?? active;
  validateOrder(active, ordered);
  for (const row of all) await tx.act.update({ where: { id: row.id }, data: { actNumber: -row.id } });
  for (const [index, id] of ordered.entries()) await tx.act.update({ where: { id }, data: { actNumber: index + 1 } });
}
export async function orderChapters(tx: Prisma.TransactionClient, actId: number, requested?: number[]) {
  const all = await tx.chapter.findMany({ where: { actId }, orderBy: { chapterNumber: 'asc' }, select: { id: true, deletedAt: true } });
  const active = all.filter((row) => !row.deletedAt).map((row) => row.id); const ordered = requested ?? active;
  validateOrder(active, ordered);
  for (const row of all) await tx.chapter.update({ where: { id: row.id }, data: { chapterNumber: -row.id } });
  for (const [index, id] of ordered.entries()) await tx.chapter.update({ where: { id }, data: { chapterNumber: index + 1 } });
}
