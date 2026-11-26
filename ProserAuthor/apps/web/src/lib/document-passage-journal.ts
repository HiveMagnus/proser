import {
  canonicalDocument,
  type DocumentPassage,
  type DocumentPassageCommit,
  type DocumentPassageRestore,
  type DocumentPassageOperationCommit,
  type DocumentPassageOperation,
  type ProserDocument,
} from '@hivemagnus/proser-contracts';
import { documentDraftStore } from './document-drafts';
import type { PassageRunDraft } from './document-passage-editing';
export interface DocumentPassageDraft {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  sceneId: string;
  version: string;
  updatedAt: number;
  passage: DocumentPassage;
  drafts: PassageRunDraft[];
  /** Bounded render fragment only, never the complete scene. */
  document?: ProserDocument;
  localHistory?: { undo: ProserDocument[]; redo: ProserDocument[] };
  /** Frozen derivative identity persisted before Factory receives unsaved context. */
  prepared?: {
    operationId: string;
    sourceKey: string;
    documentKey: string;
    operations: DocumentPassageOperation[];
  };

  /** Exact request remains unchanged until Factory acknowledges this operation. */
  pending?:
    | { kind: 'commit'; request: DocumentPassageCommit; submittedDrafts?: PassageRunDraft[] }
    | { kind: 'restore'; request: DocumentPassageRestore }
    | {
        kind: 'operations';
        request: DocumentPassageOperationCommit;
        submittedDocument: ProserDocument;
      };
}
type Row = DocumentPassageDraft & { key: string };
const retention = 30 * 24 * 60 * 60 * 1000;
const key = (userId: string, bookId: string, sceneId: string) =>
  JSON.stringify(['passage-v1', userId, bookId, sceneId]);
export async function writeDocumentPassageDraft(
  draft: DocumentPassageDraft,
  expectedVersion?: string,
) {
  if (
    !draft.userId ||
    !draft.bookId ||
    !draft.sceneId ||
    !draft.version ||
    draft.schemaVersion !== 1 ||
    !Number.isFinite(draft.updatedAt) ||
    draft.passage.sceneId !== Number(draft.sceneId) ||
    !draft.passage.bookRevisionId ||
    !draft.passage.sceneRevisionId ||
    new TextEncoder().encode(canonicalDocument(draft)).byteLength > 2 * 1024 * 1024
  )
    throw new Error('Invalid bounded passage recovery record.');
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(draft.userId, draft.bookId, draft.sceneId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        previous &&
        previous.updatedAt >= Date.now() - retention &&
        (previous.version !== expectedVersion ||
          (previous.pending &&
            canonicalDocument(previous.pending) !== canonicalDocument(draft.pending)))
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...draft, key: key(draft.userId, draft.bookId, draft.sceneId) } satisfies Row);
    };
    return request;
  });
}
export async function deleteDocumentPassageDraft(
  userId: string,
  bookId: string,
  sceneId: string,
  expectedVersion: string,
) {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId, sceneId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        previous?.version === expectedVersion &&
        previous.userId === userId &&
        previous.bookId === bookId &&
        previous.sceneId === sceneId
      )
        table.delete(key(userId, bookId, sceneId));
      else if (previous) table.transaction.abort();
    };
    return request;
  });
}
export async function readDocumentPassageDraft(
  userId: string,
  bookId: string,
  sceneId: string,
): Promise<DocumentPassageDraft | undefined> {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId, bookId, sceneId)),
  );
  if (
    !row ||
    row.key !== key(userId, bookId, sceneId) ||
    row.userId !== userId ||
    row.bookId !== bookId ||
    row.sceneId !== sceneId
  )
    return;
  if (!Number.isFinite(row.updatedAt) || row.updatedAt < Date.now() - retention) {
    await deleteDocumentPassageDraft(userId, bookId, sceneId, row.version);
    return;
  }
  if (
    row.schemaVersion !== 1 ||
    !row.version ||
    row.passage?.sceneId !== Number(sceneId) ||
    !Array.isArray(row.drafts) ||
    new TextEncoder().encode(canonicalDocument(row)).byteLength > 2 * 1024 * 1024
  )
    throw new Error(
      'The retained passage is invalid. Recover its Factory operation before discarding it.',
    );
  return row;
}

/** Advance a journal only after the exact pending operation has been acknowledged. */
export async function acknowledgeDocumentPassageDraft(
  draft: DocumentPassageDraft,
  expectedVersion: string,
  acknowledgedOperationId: string,
) {
  if (
    !draft.userId ||
    !draft.bookId ||
    !draft.sceneId ||
    draft.pending ||
    !draft.version ||
    new TextEncoder().encode(canonicalDocument(draft)).byteLength > 2 * 1024 * 1024
  )
    throw new Error('Invalid acknowledged passage recovery record.');
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(draft.userId, draft.bookId, draft.sceneId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        !previous ||
        previous.version !== expectedVersion ||
        previous.pending?.request.operationId !== acknowledgedOperationId
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...draft, key: key(draft.userId, draft.bookId, draft.sceneId) } satisfies Row);
    };
    return request;
  });
}
