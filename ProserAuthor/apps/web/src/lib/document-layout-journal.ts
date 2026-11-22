import type { BookLayoutSnapshot, DocumentStoryDraftCommit } from '@cheftaco/proser-contracts';
import type { SaveLayoutRequest } from './document-api';
import type { LayoutHistory } from './document-layout-history';
import { documentDraftStore } from './document-drafts';
export interface LayoutDraft {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  updatedAt: number;
  journalRevision: string;
  baseRevisionId: string;
  baseLayoutRevisionId: string;
  layout: BookLayoutSnapshot;
  baseLayout: BookLayoutSnapshot;
  pending?: SaveLayoutRequest;
  pendingStory?: { storyId: string; request: DocumentStoryDraftCommit };
  history?: LayoutHistory;
  restoreFromRevisionId?: string;
}
const key = (userId: string, bookId: string) => JSON.stringify(['layout-v1', userId, bookId]);
const retention = 30 * 24 * 60 * 60 * 1000;
type Row = LayoutDraft & { key: string };
export const layoutDraftOperationId = (row: LayoutDraft) =>
  row.pending?.operationId ?? row.pendingStory?.request.operationId;
export async function readLayoutDraft(
  userId: string,
  bookId: string,
): Promise<LayoutDraft | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId, bookId)),
  );
  if (
    !row ||
    row.key !== key(userId, bookId) ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.schemaVersion !== 1
  )
    return;
  if (!Number.isFinite(row.updatedAt) || row.updatedAt < Date.now() - retention) {
    await deleteLayoutDraft(userId, bookId, layoutDraftOperationId(row), row.journalRevision);
    return;
  }
  if (
    !row.baseRevisionId ||
    !row.journalRevision ||
    !row.baseLayoutRevisionId ||
    !row.layout ||
    !row.baseLayout ||
    JSON.stringify(row).length > 8 * 1024 * 1024
  )
    throw new Error(
      'Retained layout draft is invalid. Recover its exact operation before discarding.',
    );
  return row;
}
export async function writeLayoutDraft(
  draft: LayoutDraft,
  expectedJournalRevision?: string,
): Promise<void> {
  // Full undo frames use a separate bounded journal; do not multiply them into each draft.
  const stored = { ...draft };
  delete stored.history;
  if (
    Boolean(draft.pending && draft.pendingStory) ||
    !draft.userId ||
    !draft.bookId ||
    !draft.journalRevision ||
    draft.schemaVersion !== 1 ||
    JSON.stringify(stored).length > 8 * 1024 * 1024
  )
    throw new Error('Invalid layout recovery record.');
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(draft.userId, draft.bookId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (previous?.journalRevision !== expectedJournalRevision) {
        table.transaction.abort();
        return;
      }
      if (
        previous &&
        layoutDraftOperationId(previous) &&
        (layoutDraftOperationId(previous) !== layoutDraftOperationId(draft) ||
          JSON.stringify([previous.pending, previous.pendingStory]) !==
            JSON.stringify([draft.pending, draft.pendingStory]))
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...stored, key: key(draft.userId, draft.bookId) } satisfies Row);
    };
    return request;
  });
}
export async function deleteLayoutDraft(
  userId: string,
  bookId: string,
  operationId?: string,
  journalRevision?: string,
): Promise<void> {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId));
    request.onsuccess = () => {
      const row = request.result as Row | undefined;
      if (
        row?.userId === userId &&
        row.bookId === bookId &&
        layoutDraftOperationId(row) === operationId &&
        (!journalRevision || row.journalRevision === journalRevision)
      )
        table.delete(key(userId, bookId));
    };
    return request;
  });
}
