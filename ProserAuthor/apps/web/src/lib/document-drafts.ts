import type { ProserDocument } from '@hivemagnus/proser-editor';
import type { SaveDocumentRequest } from './document-api';
import type { DocumentHistory } from './document-history';
export interface DocumentDraft {
  key: string;
  userId: string;
  bookId: string;
  sceneId: string;
  baseRevisionId: string;
  baseBookRevisionId: string;
  baseDocument?: ProserDocument;
  document: ProserDocument;
  updatedAt: number;
  pendingSave?: SaveDocumentRequest;
  history?: DocumentHistory;
}
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const documentDraftKey = (userId: string, bookId: string, sceneId: string) =>
  JSON.stringify(['v1', userId, bookId, sceneId]);
export async function documentDraftStore<T>(
  mode: IDBTransactionMode,
  operation: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('proser-document-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Close another Proser tab to unlock draft recovery.'));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('drafts', mode);
      const request = operation(transaction.objectStore('drafts'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
export async function readDocumentDraft(
  userId: string,
  bookId: string,
  sceneId: string,
): Promise<DocumentDraft | undefined> {
  const key = documentDraftKey(userId, bookId, sceneId);
  const draft = await documentDraftStore<DocumentDraft | undefined>('readonly', (table) =>
    table.get(key),
  );
  if (!draft || draft.userId !== userId || draft.bookId !== bookId || draft.sceneId !== sceneId)
    return undefined;
  if (draft.updatedAt < Date.now() - RETENTION_MS) {
    await deleteDocumentDraft(key);
    return undefined;
  }
  return draft;
}
export const writeDocumentDraft = (draft: DocumentDraft) =>
  documentDraftStore<IDBValidKey>('readwrite', (table) => table.put(draft));
export const deleteDocumentDraft = (key: string) =>
  documentDraftStore<undefined>('readwrite', (table) => table.delete(key));
