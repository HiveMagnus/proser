import {
  canonicalDocument,
  type ProserDocument,
  type DocumentAnchorLineage,
} from '@cheftaco/proser-editor';
import { documentDraftStore } from './document-drafts';
export interface WindowDocuments {
  [sceneId: string]: ProserDocument;
}
export interface DocumentWindowHistory {
  entries: Array<{
    id: string;
    createdAt: number;
    documents: WindowDocuments;
    sceneRevisionIds?: Record<string, string>;
    anchorLineage?: DocumentAnchorLineage[];
  }>;
  cursor: number;
}
export interface WindowHistoryRecord {
  key: string;
  userId: string;
  bookId: string;
  sceneIds: string[];
  updatedAt: number;
  history: DocumentWindowHistory;
}
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const entrySizes = new WeakMap<WindowDocuments, number>();
function entryBytes(entry: DocumentWindowHistory['entries'][number]) {
  let bytes = entrySizes.get(entry.documents);
  if (bytes === undefined) {
    bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    entrySizes.set(entry.documents, bytes);
  }
  return bytes;
}
export const windowHistoryKey = (userId: string, bookId: string, sceneIds: string[]) =>
  JSON.stringify(['window-history-v1', userId, bookId, sceneIds]);
export const sameWindowDocuments = (left: WindowDocuments, right: WindowDocuments) =>
  JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort()) &&
  Object.keys(left).every((id) => canonicalDocument(left[id]) === canonicalDocument(right[id]));
export const initialWindowHistory = (
  documents: WindowDocuments,
  sceneRevisionIds?: Record<string, string>,
): DocumentWindowHistory => ({
  entries: [
    {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      documents: structuredClone(documents),
      ...(sceneRevisionIds ? { sceneRevisionIds: { ...sceneRevisionIds } } : {}),
    },
  ],
  cursor: 0,
});
export function appendWindowHistory(
  history: DocumentWindowHistory | undefined,
  before: WindowDocuments,
  after: WindowDocuments,
  anchorLineage?: DocumentAnchorLineage[],
): DocumentWindowHistory {
  const previous =
    history && sameWindowDocuments(history.entries[history.cursor]!.documents, before)
      ? history
      : initialWindowHistory(before);
  if (sameWindowDocuments(before, after)) return previous;
  const entries = previous.entries.slice(0, previous.cursor + 1);
  entries.push({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...(anchorLineage?.length ? { anchorLineage: structuredClone(anchorLineage) } : {}),
    sceneRevisionIds: Object.fromEntries(
      Object.entries(previous.entries[previous.cursor]!.sceneRevisionIds ?? {}).filter(
        ([id]) => before[id] === after[id],
      ),
    ),
    documents: Object.fromEntries(
      Object.keys(after).map((id) => [
        id,
        before[id] === after[id]
          ? previous.entries[previous.cursor]!.documents[id]!
          : structuredClone(after[id]!),
      ]),
    ),
  });
  let bytes = entries.reduce((total, entry) => total + entryBytes(entry), 0);
  while (entries.length > 1 && (entries.length > 100 || bytes > MAX_BYTES)) {
    const first = entries.shift()!;
    bytes -= entryBytes(first);
  }
  return { entries, cursor: entries.length - 1 };
}
export async function readWindowHistory(
  userId: string,
  bookId: string,
  sceneIds: string[],
): Promise<DocumentWindowHistory | undefined> {
  const key = windowHistoryKey(userId, bookId, sceneIds);
  const record = await documentDraftStore<WindowHistoryRecord | undefined>('readonly', (store) =>
    store.get(key),
  );
  if (
    !record ||
    record.userId !== userId ||
    record.bookId !== bookId ||
    JSON.stringify(record.sceneIds) !== JSON.stringify(sceneIds)
  )
    return undefined;
  if (record.updatedAt < Date.now() - RETENTION_MS) {
    await documentDraftStore('readwrite', (store) => store.delete(key));
    return undefined;
  }
  if (
    !Array.isArray(record.history?.entries) ||
    record.history.entries.some(
      (entry) =>
        !entry ||
        typeof entry.id !== 'string' ||
        !Number.isFinite(entry.createdAt) ||
        !entry.documents ||
        JSON.stringify(Object.keys(entry.documents).sort()) !==
          JSON.stringify([...sceneIds].sort()) ||
        Object.values(entry.documents).some((document) => document?.schemaVersion !== 1),
    ) ||
    record.history.entries.length > 100 ||
    !Number.isInteger(record.history.cursor) ||
    record.history.cursor < 0 ||
    record.history.cursor >= record.history.entries.length ||
    new TextEncoder().encode(JSON.stringify(record.history)).byteLength > MAX_BYTES + 1024 * 1024
  )
    return undefined;
  return record.history;
}
export const writeWindowHistory = (record: WindowHistoryRecord) =>
  documentDraftStore('readwrite', (store) => store.put(record));
