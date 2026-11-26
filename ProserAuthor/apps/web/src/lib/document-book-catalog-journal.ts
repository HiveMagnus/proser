import type {
  DocumentMutationPreconditions,
  StructureBookMetadata,
} from '@hivemagnus/proser-contracts';
import type { Book, updateBook } from './api';
import { documentDraftStore } from './document-drafts';

export type BookMetadataPatch = Parameters<typeof updateBook>[1];
export interface BookCatalogSnapshot {
  snapshotId: string;
  userId: string;
  bookId: string;
  book: Book;
  sourceBook: StructureBookMetadata;
  bookRevisionId: string;
  structureRevisionId: string;
}
export interface BookCatalogIntent {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  version: string;
  updatedAt: number;
  operationId: string;
  kind: 'update' | 'delete';
  status: 'prepared' | 'unknown' | 'not-found' | 'rejected';
  snapshot: BookCatalogSnapshot;
  patch?: BookMetadataPatch;
  preconditions: DocumentMutationPreconditions;
}
// One outstanding catalog operation per authenticated user. The immutable row
// also binds the book, allowing a lost delete ACK to recover after list removal.
const key = (userId: string) => JSON.stringify(['book-catalog-v1', userId]);
type Row = BookCatalogIntent & { key: string };
const immutable = (row: BookCatalogIntent) =>
  JSON.stringify([
    row.userId,
    row.bookId,
    row.operationId,
    row.kind,
    row.snapshot,
    row.patch,
    row.preconditions,
  ]);
export function validateBookCatalogIntent(row: BookCatalogIntent, userId = row.userId): void {
  if (
    row.schemaVersion !== 1 ||
    !userId ||
    row.userId !== userId ||
    !row.bookId ||
    !row.version ||
    !row.operationId ||
    !Number.isFinite(row.updatedAt) ||
    !['update', 'delete'].includes(row.kind) ||
    !['prepared', 'unknown', 'not-found', 'rejected'].includes(row.status) ||
    row.snapshot?.userId !== userId ||
    row.snapshot.bookId !== row.bookId ||
    row.snapshot.book?.id !== row.bookId ||
    !row.snapshot.sourceBook ||
    !row.snapshot.snapshotId ||
    row.preconditions?.operationId !== row.operationId ||
    row.preconditions.expectedRevisionId !== row.snapshot.bookRevisionId ||
    row.preconditions.expectedScopes?.structure !== row.snapshot.structureRevisionId ||
    !row.snapshot.bookRevisionId ||
    !row.snapshot.structureRevisionId ||
    (row.kind === 'delete' && row.patch !== undefined) ||
    (row.kind === 'update' && (!row.patch || typeof row.patch !== 'object')) ||
    JSON.stringify(row).length > 8 * 1024 * 1024
  )
    throw new Error('The retained book operation is invalid or belongs to another user.');
}
export async function readBookCatalogIntent(
  userId: string,
): Promise<BookCatalogIntent | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId)),
  );
  if (!row) return;
  if (row.key !== key(userId)) throw new Error('Book recovery identity is invalid.');
  validateBookCatalogIntent(row, userId);
  // Never expire an uncertain mutation automatically, including after 30 days.
  return row;
}
export async function writeBookCatalogIntent(
  row: BookCatalogIntent,
  expectedVersion?: string,
): Promise<void> {
  validateBookCatalogIntent(row);
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(row.userId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        previous?.version !== expectedVersion ||
        (previous && immutable(previous) !== immutable(row))
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...row, key: key(row.userId) });
    };
    return request;
  });
}
export async function deleteBookCatalogIntent(
  userId: string,
  version: string,
  operationId: string,
): Promise<void> {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId));
    request.onsuccess = () => {
      const row = request.result as Row | undefined;
      if (!row) return;
      if (row.userId !== userId || row.version !== version || row.operationId !== operationId) {
        table.transaction.abort();
        return;
      }
      table.delete(key(userId));
    };
    return request;
  });
}
