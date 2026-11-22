import type { DocumentCompareRequest } from '@cheftaco/proser-contracts';

export interface DocumentCompareIntent {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  sceneId: string;
  request: DocumentCompareRequest;
  updatedAt: number;
}
const key = (userId: string, bookId: string, sceneId: string) =>
  JSON.stringify(['compare-v1', userId, bookId, sceneId]);
const retention = 30 * 24 * 60 * 60 * 1000;
type Record = DocumentCompareIntent & { key: string };
async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (table: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('proser-document-review-operations', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('operations', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Close another Proser tab to unlock review recovery.'));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction('operations', mode);
      const request = operation(tx.objectStore('operations'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(
          tx.error ??
            new Error('Another review operation remains unacknowledged. Recover it first.'),
        );
    });
  } finally {
    database.close();
  }
}
export async function writeDocumentCompareIntent(intent: DocumentCompareIntent): Promise<void> {
  if (
    intent.schemaVersion !== 1 ||
    !intent.userId ||
    !intent.bookId ||
    !intent.sceneId ||
    !intent.request.operationId ||
    !Number.isFinite(intent.updatedAt) ||
    JSON.stringify(intent).length > 65536
  )
    throw new Error('Invalid review operation journal record.');
  await transaction<Record | undefined>('readwrite', (table) => {
    const request = table.get(key(intent.userId, intent.bookId, intent.sceneId));
    request.onsuccess = () => {
      const previous = request.result as Record | undefined;
      if (
        previous &&
        previous.updatedAt >= Date.now() - retention &&
        (previous.request.operationId !== intent.request.operationId ||
          JSON.stringify(previous.request) !== JSON.stringify(intent.request))
      ) {
        table.transaction.abort();
        return;
      }
      table.put({
        ...intent,
        key: key(intent.userId, intent.bookId, intent.sceneId),
      } satisfies Record);
    };
    return request;
  });
}
export async function deleteDocumentCompareIntent(
  userId: string,
  bookId: string,
  sceneId: string,
  operationId: string,
): Promise<void> {
  await transaction<Record | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId, sceneId));
    request.onsuccess = () => {
      const row = request.result as Record | undefined;
      if (
        row?.userId === userId &&
        row.bookId === bookId &&
        row.sceneId === sceneId &&
        row.request.operationId === operationId
      )
        table.delete(key(userId, bookId, sceneId));
    };
    return request;
  });
}
export async function readDocumentCompareIntent(
  userId: string,
  bookId: string,
  sceneId: string,
): Promise<DocumentCompareIntent | undefined> {
  const row = await transaction<Record | undefined>('readonly', (table) =>
    table.get(key(userId, bookId, sceneId)),
  );
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.sceneId !== sceneId ||
    row.key !== key(userId, bookId, sceneId)
  )
    return undefined;
  if (!Number.isFinite(row.updatedAt) || row.updatedAt < Date.now() - retention) {
    await deleteDocumentCompareIntent(userId, bookId, sceneId, row.request.operationId);
    return undefined;
  }
  if (!row.request?.operationId || JSON.stringify(row).length > 65536)
    throw new Error(
      'The retained review operation is invalid. Recover its Factory receipt before discarding it.',
    );
  return row;
}
