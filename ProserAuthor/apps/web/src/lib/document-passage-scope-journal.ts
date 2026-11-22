import {
  canonicalDocument,
  type PassageScopeTransfer,
  type PassageScopeRestore,
  type DocumentPassageBookCommit,
} from '@cheftaco/proser-contracts';
import { documentDraftStore } from './document-drafts';
export interface PassageScopeJournal {
  key: string;
  userId: string;
  bookId: string;
  sceneIds: number[];
  version: string;
  updatedAt: number;
  history: Array<{
    beforeBookRevisionId: string;
    afterBookRevisionId: string;
    sceneIds: number[];
    sceneRevisions?: Record<string, string>;
  }>;
  redo: Array<{
    beforeBookRevisionId: string;
    afterBookRevisionId: string;
    sceneIds: number[];
    sceneRevisions?: Record<string, string>;
  }>;
  pending?:
    | { kind: 'transfer'; request: PassageScopeTransfer }
    | { kind: 'edit'; request: DocumentPassageBookCommit }
    | { kind: 'restore'; request: PassageScopeRestore; direction: 'undo' | 'redo' };
}
export const passageScopeJournalKey = (userId: string, bookId: string, sceneIds: number[]) =>
  JSON.stringify(['passage-scope-v1', userId, bookId, [...sceneIds].sort((a, b) => a - b)]);
const retention = 30 * 24 * 60 * 60 * 1000;
function validate(row: PassageScopeJournal) {
  if (
    !row.userId ||
    !row.bookId ||
    !row.version ||
    row.sceneIds.length < 1 ||
    row.sceneIds.length > 3 ||
    row.sceneIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    row.key !== passageScopeJournalKey(row.userId, row.bookId, row.sceneIds) ||
    new TextEncoder().encode(canonicalDocument(row)).byteLength > 512 * 1024
  )
    throw new Error('Invalid bounded scope operation journal.');
}
export async function readPassageScopeJournal(userId: string, bookId: string, sceneIds: number[]) {
  const key = passageScopeJournalKey(userId, bookId, sceneIds);
  const row = await documentDraftStore<PassageScopeJournal | undefined>('readonly', (table) =>
    table.get(key),
  );
  if (
    !row ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.key !== key ||
    row.updatedAt < Date.now() - retention
  )
    return;
  validate(row);
  return row;
}
export async function writePassageScopeJournal(
  row: PassageScopeJournal,
  expectedVersion?: string,
  acknowledgedOperationId?: string,
) {
  validate(row);
  await documentDraftStore<PassageScopeJournal | undefined>('readwrite', (table) => {
    const request = table.get(row.key);
    request.onsuccess = () => {
      const old = request.result as PassageScopeJournal | undefined;
      if (
        old &&
        old.updatedAt >= Date.now() - retention &&
        (old.version !== expectedVersion ||
          (old.pending &&
            canonicalDocument(old.pending) !== canonicalDocument(row.pending) &&
            old.pending.request.operationId !== acknowledgedOperationId))
      ) {
        table.transaction.abort();
        return;
      }
      table.put(row);
    };
    return request;
  });
}
