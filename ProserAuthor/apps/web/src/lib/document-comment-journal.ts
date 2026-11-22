import type {
  SceneCommentResolutionRequest,
  LayoutStoryCommentResolutionRequest,
} from '@cheftaco/proser-contracts';
import { documentDraftStore } from './document-drafts';
export type CommentScope = { kind: 'scene'; id: string } | { kind: 'layout-story'; id: string };
export interface DocumentCommentIntent {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  scope: CommentScope;
  commentId: string;
  request: SceneCommentResolutionRequest | LayoutStoryCommentResolutionRequest;
  updatedAt: number;
}
type Row = DocumentCommentIntent & { key: string };
const key = (userId: string, bookId: string, scope: CommentScope) =>
  JSON.stringify(['comment-v1', userId, bookId, scope.kind, scope.id]);
const retention = 30 * 24 * 60 * 60 * 1000;
export async function writeDocumentCommentIntent(intent: DocumentCommentIntent) {
  if (
    !intent.userId ||
    !intent.bookId ||
    !intent.scope.id ||
    !intent.commentId ||
    !intent.request.operationId ||
    !Number.isFinite(intent.updatedAt) ||
    JSON.stringify(intent).length > 256 * 1024
  )
    throw new Error('Invalid comment recovery record.');
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(intent.userId, intent.bookId, intent.scope));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        previous &&
        previous.updatedAt >= Date.now() - retention &&
        (previous.request.operationId !== intent.request.operationId ||
          JSON.stringify(previous.request) !== JSON.stringify(intent.request) ||
          previous.commentId !== intent.commentId)
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...intent, key: key(intent.userId, intent.bookId, intent.scope) } satisfies Row);
    };
    return request;
  });
}
export async function deleteDocumentCommentIntent(
  userId: string,
  bookId: string,
  scope: CommentScope,
  operationId: string,
) {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId, scope));
    request.onsuccess = () => {
      if ((request.result as Row | undefined)?.request.operationId === operationId)
        table.delete(key(userId, bookId, scope));
    };
    return request;
  });
}
export async function readDocumentCommentIntent(
  userId: string,
  bookId: string,
  scope: CommentScope,
): Promise<DocumentCommentIntent | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId, bookId, scope)),
  );
  if (
    !row ||
    row.key !== key(userId, bookId, scope) ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.scope.kind !== scope.kind ||
    row.scope.id !== scope.id
  )
    return;
  if (row.updatedAt < Date.now() - retention) {
    await deleteDocumentCommentIntent(userId, bookId, scope, row.request.operationId);
    return;
  }
  if (
    row.schemaVersion !== 1 ||
    !row.commentId ||
    !row.request?.operationId ||
    !Number.isFinite(row.updatedAt) ||
    JSON.stringify(row).length > 256 * 1024
  )
    throw new Error('Retained comment operation is invalid. Recover its exact Factory receipt.');
  return row;
}
