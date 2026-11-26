import { canonicalDocument, type ProserDocument } from '@hivemagnus/proser-editor';
export interface DocumentHistoryEntry {
  id: string;
  createdAt: number;
  document: ProserDocument;
  revisionId?: string;
}
export interface DocumentHistory {
  entries: DocumentHistoryEntry[];
  cursor: number;
}
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 100;
export function initialDocumentHistory(
  document: ProserDocument,
  revisionId?: string,
): DocumentHistory {
  return {
    entries: [
      {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        document: structuredClone(document),
        ...(revisionId ? { revisionId } : {}),
      },
    ],
    cursor: 0,
  };
}
export function appendDocumentHistory(
  history: DocumentHistory | undefined,
  before: ProserDocument,
  after: ProserDocument,
): DocumentHistory {
  if (canonicalDocument(before) === canonicalDocument(after))
    return history ?? initialDocumentHistory(before);
  const source = history ?? initialDocumentHistory(before);
  const entries = source.entries.slice(0, source.cursor + 1);
  entries.push({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    document: structuredClone(after),
  });
  let bytes = entries.reduce(
    (total, entry) =>
      total + new TextEncoder().encode(canonicalDocument(entry.document)).byteLength,
    0,
  );
  while (entries.length > 1 && (entries.length > MAX_ENTRIES || bytes > MAX_HISTORY_BYTES))
    bytes -= new TextEncoder().encode(canonicalDocument(entries.shift()!.document)).byteLength;
  return { entries, cursor: entries.length - 1 };
}
/** Recovered journal must end at its actual draft; mismatched or oversized
 * records cannot become an alternate document authority. */
export function recoverDocumentHistory(
  history: DocumentHistory | undefined,
  document: ProserDocument,
): DocumentHistory {
  if (
    !history ||
    !Array.isArray(history.entries) ||
    history.entries.some(
      (entry) =>
        !entry ||
        typeof entry.id !== 'string' ||
        !Number.isFinite(entry.createdAt) ||
        entry.document?.schemaVersion !== 1,
    ) ||
    !Number.isInteger(history.cursor) ||
    history.cursor < 0 ||
    history.cursor >= history.entries.length ||
    history.entries.length > MAX_ENTRIES ||
    canonicalDocument(history.entries[history.cursor]?.document) !== canonicalDocument(document) ||
    new TextEncoder().encode(JSON.stringify(history)).byteLength > MAX_HISTORY_BYTES + 1024 * 1024
  )
    return initialDocumentHistory(document);
  return structuredClone(history);
}
