import type { PassageCommentCommit } from '@cheftaco/proser-contracts';
import { documentDraftStore } from './document-drafts';
export interface PassageCommentIntent {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  sceneId: string;
  request: PassageCommentCommit;
  updatedAt: number;
}
type Row = PassageCommentIntent & { key: string };
const key = (userId: string, bookId: string, sceneId: string) =>
  JSON.stringify(['passage-comment-v1', userId, bookId, sceneId]);
const retention = 30 * 24 * 60 * 60 * 1000;
function valid(intent: PassageCommentIntent) {
  if (
    intent.schemaVersion !== 1 ||
    !intent.userId ||
    !intent.bookId ||
    !intent.sceneId ||
    !intent.request.operationId ||
    !Number.isFinite(intent.updatedAt) ||
    JSON.stringify(intent).length > 256 * 1024
  )
    throw new Error('Invalid bounded comment recovery record.');
}
export async function writePassageCommentIntent(intent: PassageCommentIntent) {
  valid(intent);
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(intent.userId, intent.bookId, intent.sceneId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        previous &&
        previous.updatedAt >= Date.now() - retention &&
        JSON.stringify(previous.request) !== JSON.stringify(intent.request)
      ) {
        table.transaction.abort();
        return;
      }
      table.put({
        ...intent,
        key: key(intent.userId, intent.bookId, intent.sceneId),
      } satisfies Row);
    };
    return request;
  });
}
export async function deletePassageCommentIntent(
  userId: string,
  bookId: string,
  sceneId: string,
  operationId: string,
) {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId, sceneId));
    request.onsuccess = () => {
      if ((request.result as Row | undefined)?.request.operationId === operationId)
        table.delete(key(userId, bookId, sceneId));
    };
    return request;
  });
}
export async function readPassageCommentIntent(
  userId: string,
  bookId: string,
  sceneId: string,
): Promise<PassageCommentIntent | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId, bookId, sceneId)),
  );
  if (
    !row ||
    row.key !== key(userId, bookId, sceneId) ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.sceneId !== sceneId
  )
    return;
  if (row.updatedAt < Date.now() - retention) {
    await deletePassageCommentIntent(userId, bookId, sceneId, row.request.operationId);
    return;
  }
  valid(row);
  return row;
}
