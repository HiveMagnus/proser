import type { createBook } from './api';
import { documentDraftStore } from './document-drafts';

export type BookCreationRequest = Omit<Parameters<typeof createBook>[0], 'operationId'>;
export interface BookCreationIntent {
  schemaVersion: 1;
  userId: string;
  operationId: string;
  version: string;
  updatedAt: number;
  request: BookCreationRequest;
  state: 'prepared' | 'dispatched' | 'retryable' | 'rejected';
}
type Row = BookCreationIntent & { key: string };
const retention = 30 * 24 * 60 * 60 * 1000;
export const bookCreationIntentKey = (userId: string) =>
  JSON.stringify(['book-creation-v1', userId]);
function valid(intent: BookCreationIntent) {
  return (
    intent.schemaVersion === 1 &&
    !!intent.userId &&
    !!intent.operationId &&
    !!intent.version &&
    Number.isFinite(intent.updatedAt) &&
    ['prepared', 'dispatched', 'retryable', 'rejected'].includes(intent.state) &&
    typeof intent.request?.title === 'string' &&
    !!intent.request.title.trim() &&
    Object.entries(intent.request).every(
      ([key, value]) =>
        ['title', 'genre', 'archetype', 'targetAudience', 'summary'].includes(key) &&
        (value === undefined || typeof value === 'string'),
    ) &&
    new TextEncoder().encode(JSON.stringify(intent)).byteLength <= 256 * 1024
  );
}
export async function writeBookCreationIntent(
  intent: BookCreationIntent,
  expectedVersion?: string,
): Promise<void> {
  if (!valid(intent)) throw new Error('Invalid book creation recovery request.');
  let conflict: Error | undefined;
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(bookCreationIntentKey(intent.userId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        (previous &&
          (!valid(previous) ||
            previous.userId !== intent.userId ||
            previous.version !== expectedVersion ||
            previous.operationId !== intent.operationId ||
            JSON.stringify(previous.request) !== JSON.stringify(intent.request))) ||
        (!previous && expectedVersion !== undefined)
      ) {
        conflict = new Error(
          'Book creation recovery changed in another tab. Recover its original operation before continuing.',
        );
        table.transaction.abort();
        return;
      }
      table.put({ ...intent, key: bookCreationIntentKey(intent.userId) } satisfies Row);
    };
    return request;
  }).catch((error: unknown) => {
    throw conflict ?? error ?? new Error('Book creation journal transaction aborted.');
  });
}
export async function deleteBookCreationIntent(
  userId: string,
  operationId: string,
  expectedVersion: string,
): Promise<void> {
  let conflict: Error | undefined;
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(bookCreationIntentKey(userId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (!previous) return;
      if (
        previous.userId !== userId ||
        previous.operationId !== operationId ||
        previous.version !== expectedVersion
      ) {
        conflict = new Error('A newer book creation recovery record must not be discarded.');
        table.transaction.abort();
        return;
      }
      table.delete(bookCreationIntentKey(userId));
    };
    return request;
  }).catch((error: unknown) => {
    throw conflict ?? error ?? new Error('Book creation journal transaction aborted.');
  });
}
export async function readBookCreationIntent(
  userId: string,
): Promise<BookCreationIntent | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(bookCreationIntentKey(userId)),
  );
  if (!row || row.key !== bookCreationIntentKey(userId) || row.userId !== userId) return undefined;
  if (!valid(row))
    throw new Error(
      'The retained book creation request is invalid. Recover its original Factory operation before replacing it.',
    );
  // Thirty days is the minimum recovery window. An uncertain dispatched effect
  // must retain its exact operation/request until explicit receipt recovery.
  if (row.updatedAt < Date.now() - retention && ['prepared', 'rejected'].includes(row.state)) {
    await deleteBookCreationIntent(userId, row.operationId, row.version);
    return undefined;
  }
  const { key: _key, ...intent } = row;
  return intent;
}
