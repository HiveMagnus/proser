import type { DocumentQuickDraftInput } from '@cheftaco/proser-contracts';
export interface QuickDraftRequest {
  /** A workspace creation action retains the exact navigation it displayed. */
  base?: { bookRevisionId: string; structureRevisionId: string };
  bookId?: string;
  bookTitle?: string | null;
  newBook?: { title: string; genre?: string; summary?: string };
  summary: string;
  outline: string;
}
export interface QuickDraftIntent {
  userId: string;
  request: QuickDraftRequest;
  creationId: string;
  bookId?: string;
  bookTitle?: string | null;
  creationSent: boolean;
  draft?: DocumentQuickDraftInput;
  draftSent: boolean;
  retryAllowed: boolean;
  rejected?: boolean;
}
interface Record {
  key: string;
  schemaVersion: 1;
  userId: string;
  updatedAt: number;
  intent: QuickDraftIntent;
}
const key = (userId: string) => JSON.stringify(['quick-draft-v1', userId]);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (table: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('proser-document-intents', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('intents', { keyPath: 'key' });
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Close another Proser tab to unlock operation recovery.'));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction('intents', mode);
      const request = operation(tx.objectStore('intents'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new DOMException('Operation journal transaction aborted', 'AbortError'));
    });
  } finally {
    database.close();
  }
}
export async function deleteQuickDraftIntent(userId: string, creationId: string): Promise<void> {
  await transaction<Record | undefined>('readwrite', (table) => {
    const request = table.get(key(userId));
    request.onsuccess = () => {
      const row = request.result as Record | undefined;
      if (row?.userId === userId && row.intent?.creationId === creationId)
        table.delete(key(userId));
    };
    return request;
  });
}
export async function readQuickDraftIntent(userId: string): Promise<QuickDraftIntent | undefined> {
  const row = await transaction<Record | undefined>('readonly', (table) => table.get(key(userId)));
  if (
    !row ||
    row.userId !== userId ||
    row.intent?.userId !== userId ||
    row.schemaVersion !== 1 ||
    row.key !== key(userId)
  )
    return undefined;
  if (!Number.isFinite(row.updatedAt) || row.updatedAt < Date.now() - RETENTION_MS) {
    await deleteQuickDraftIntent(userId, row.intent.creationId);
    return undefined;
  }
  if (
    JSON.stringify(row).length > 1024 * 1024 ||
    !row.intent.creationId ||
    typeof row.intent.request?.outline !== 'string' ||
    typeof row.intent.request.summary !== 'string'
  )
    throw new Error(
      'The retained quick draft is invalid. Recover its Factory operation before discarding it.',
    );
  return row.intent;
}
export async function writeQuickDraftIntent(intent: QuickDraftIntent): Promise<void> {
  try {
    await transaction<Record | undefined>('readwrite', (table) => {
      const request = table.get(key(intent.userId));
      request.onsuccess = () => {
        const previous = request.result as Record | undefined;
        if (
          previous &&
          previous.updatedAt >= Date.now() - RETENTION_MS &&
          previous.intent?.creationId !== intent.creationId
        ) {
          table.transaction.abort();
          return;
        }
        table.put({
          key: key(intent.userId),
          schemaVersion: 1,
          userId: intent.userId,
          updatedAt: Date.now(),
          intent,
        } satisfies Record);
      };
      return request;
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new Error(
        'Another quick draft is pending in this browser. Recover it before creating another.',
        { cause: error },
      );
    throw error;
  }
}
