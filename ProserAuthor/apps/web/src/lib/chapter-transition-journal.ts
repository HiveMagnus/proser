import type { DocumentDiscussionInput, DocumentProposalRequest } from '@cheftaco/proser-contracts';
export interface TransitionIntent {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  chapterId: number;
  discussion: DocumentDiscussionInput;
  request: DocumentProposalRequest;
}
const key = (userId: string, bookId: string, chapterId: number) =>
  JSON.stringify(['chapter-transition-v1', userId, bookId, chapterId]);
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (table: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('proser-chapter-transition-reviews', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('requests', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Close another Proser tab to unlock transition recovery.'));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction('requests', mode),
        request = action(tx.objectStore('requests'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(
          tx.error ??
            new Error(
              'A transition request is already retained. Recover it before starting another.',
            ),
        );
    });
  } finally {
    database.close();
  }
}
export async function readTransitionIntent(
  userId: string,
  bookId: string,
  chapterId: number,
): Promise<TransitionIntent | undefined> {
  const value = await transaction<TransitionIntent | undefined>('readonly', (table) =>
    table.get(key(userId, bookId, chapterId)),
  );
  if (!value) return;
  if (
    value.schemaVersion !== 1 ||
    value.userId !== userId ||
    value.bookId !== bookId ||
    value.chapterId !== chapterId ||
    !value.discussion?.operationId ||
    !value.request?.operationId ||
    value.discussion.transitionChapterId !== chapterId
  )
    throw new Error(
      'Saved transition request is incompatible. Preserve its original recovery record.',
    );
  return value;
}
export async function writeTransitionIntent(value: TransitionIntent): Promise<void> {
  await transaction<TransitionIntent | undefined>('readwrite', (table) => {
    const request = table.get(key(value.userId, value.bookId, value.chapterId));
    request.onsuccess = () => {
      const previous = request.result as TransitionIntent | undefined;
      if (
        previous &&
        (previous.request.operationId !== value.request.operationId ||
          JSON.stringify(previous.discussion) !== JSON.stringify(value.discussion) ||
          JSON.stringify(previous.request) !== JSON.stringify(value.request))
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...value, key: key(value.userId, value.bookId, value.chapterId) });
    };
    return request;
  });
}
export async function clearTransitionIntent(value: TransitionIntent): Promise<void> {
  await transaction<TransitionIntent | undefined>('readwrite', (table) => {
    const request = table.get(key(value.userId, value.bookId, value.chapterId));
    request.onsuccess = () => {
      if (request.result?.request.operationId === value.request.operationId)
        table.delete(key(value.userId, value.bookId, value.chapterId));
    };
    return request;
  });
}
