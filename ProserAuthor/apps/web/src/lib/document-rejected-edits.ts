import type { ProserDocument } from '@hivemagnus/proser-contracts';
import { documentDraftStore } from './document-drafts';
export interface RejectedDocumentEdit {
  schemaVersion: 1;
  id: string;
  userId: string;
  bookId: string;
  scope: { kind: 'scene' | 'layout-story'; id: string };
  updatedAt: number;
  baseRevisionId: string;
  baseContentHash: string;
  editorVersion: string;
  canonicalBase: ProserDocument;
  nativeValue: unknown;
  error: string;
}
type Row = RejectedDocumentEdit & { key: string };
const key = (userId: string, bookId: string, scope: RejectedDocumentEdit['scope']) =>
  JSON.stringify(['rejected-native-v1', userId, bookId, scope.kind, scope.id]);
export async function readRejectedDocumentEdit(
  userId: string,
  bookId: string,
  scope: RejectedDocumentEdit['scope'],
): Promise<RejectedDocumentEdit | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId, bookId, scope)),
  );
  if (
    !row ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.key !== key(userId, bookId, scope)
  )
    return;
  if (row.updatedAt < Date.now() - 30 * 24 * 60 * 60 * 1000) {
    await deleteRejectedDocumentEdit(userId, bookId, scope, row.id);
    return;
  }
  if (
    row.schemaVersion !== 1 ||
    !row.id ||
    !row.nativeValue ||
    !row.canonicalBase ||
    JSON.stringify(row).length > 8 * 1024 * 1024
  )
    throw new Error(
      'The retained unsupported draft is invalid. Keep its original record for review.',
    );
  return row;
}
export async function writeRejectedDocumentEdit(row: RejectedDocumentEdit) {
  if (
    !row.userId ||
    !row.bookId ||
    !row.scope.id ||
    !row.nativeValue ||
    !row.canonicalBase ||
    !Number.isFinite(row.updatedAt) ||
    JSON.stringify(row).length > 8 * 1024 * 1024
  )
    throw new Error('This unsupported edit could not be retained. Keep this page open.');
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(row.userId, row.bookId, row.scope));
    request.onsuccess = () => {
      const old = request.result as Row | undefined;
      if (old && old.id !== row.id) {
        table.transaction.abort();
        return;
      }
      table.put({ ...row, key: key(row.userId, row.bookId, row.scope) });
    };
    return request;
  });
}
export async function deleteRejectedDocumentEdit(
  userId: string,
  bookId: string,
  scope: RejectedDocumentEdit['scope'],
  id: string,
) {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId, scope));
    request.onsuccess = () => {
      if ((request.result as Row | undefined)?.id === id) table.delete(key(userId, bookId, scope));
    };
    return request;
  });
}
