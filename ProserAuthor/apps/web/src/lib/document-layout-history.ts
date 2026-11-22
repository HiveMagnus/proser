import { canonicalDocument, type BookLayoutSnapshot } from '@cheftaco/proser-contracts';
import { documentDraftStore } from './document-drafts';
export interface LayoutHistoryFrame {
  layout: BookLayoutSnapshot;
  revisionId?: string;
  contentHash?: string;
  operationId?: string;
}
export interface LayoutHistory {
  schemaVersion: 1;
  userId: string;
  bookId: string;
  version: string;
  updatedAt: number;
  cursor: number;
  frames: LayoutHistoryFrame[];
}
const key = (userId: string, bookId: string) =>
  JSON.stringify(['layout-history-v1', userId, bookId]);
const maxBytes = 20 * 1024 * 1024;
export function appendLayoutHistory(
  history: LayoutHistory,
  layout: BookLayoutSnapshot,
  revisionId?: string,
  contentHash?: string,
): LayoutHistory {
  if (canonicalDocument(history.frames[history.cursor]?.layout) === canonicalDocument(layout))
    return {
      ...history,
      version: crypto.randomUUID(),
      updatedAt: Date.now(),
      frames: history.frames.map((frame, index) =>
        index === history.cursor && revisionId
          ? { ...frame, revisionId, ...(contentHash ? { contentHash } : {}) }
          : frame,
      ),
    };
  const frames = [
    ...history.frames.slice(0, history.cursor + 1),
    { layout, ...(revisionId ? { revisionId } : {}), ...(contentHash ? { contentHash } : {}) },
  ];
  while (frames.length > 1 && (frames.length > 100 || JSON.stringify(frames).length > maxBytes))
    frames.shift();
  return {
    ...history,
    cursor: frames.length - 1,
    frames,
    version: crypto.randomUUID(),
    updatedAt: Date.now(),
  };
}
export async function readLayoutHistory(
  userId: string,
  bookId: string,
): Promise<LayoutHistory | undefined> {
  const row = await documentDraftStore<(LayoutHistory & { key: string }) | undefined>(
    'readonly',
    (table) => table.get(key(userId, bookId)),
  );
  if (!row || row.userId !== userId || row.bookId !== bookId || row.key !== key(userId, bookId))
    return;
  if (row.updatedAt < Date.now() - 30 * 24 * 60 * 60 * 1000) {
    await documentDraftStore<unknown>('readwrite', (table) => {
      const request = table.get(key(userId, bookId));
      request.onsuccess = () => {
        if ((request.result as LayoutHistory | undefined)?.version === row.version)
          table.delete(key(userId, bookId));
      };
      return request;
    });
    return;
  }
  if (
    row.schemaVersion !== 1 ||
    !row.version ||
    !Number.isFinite(row.updatedAt) ||
    !Number.isInteger(row.cursor) ||
    row.cursor < 0 ||
    !Array.isArray(row.frames) ||
    row.cursor >= row.frames.length ||
    !row.frames.length ||
    row.frames.length > 100 ||
    row.frames.some((frame) => frame.layout?.schemaVersion !== 1) ||
    JSON.stringify(row.frames).length > maxBytes
  )
    throw new Error(
      'Retained layout history is invalid. Keep the saved layout and review its revisions.',
    );
  return row;
}
export async function writeLayoutHistory(history: LayoutHistory, expectedVersion?: string) {
  if (
    history.schemaVersion !== 1 ||
    !history.userId ||
    !history.bookId ||
    !history.version ||
    !Array.isArray(history.frames) ||
    !history.frames.length ||
    history.frames.length > 100 ||
    history.cursor < 0 ||
    history.cursor >= history.frames.length ||
    JSON.stringify(history.frames).length > maxBytes
  )
    throw new Error('Invalid layout operation history.');
  await documentDraftStore<(LayoutHistory & { key: string }) | undefined>('readwrite', (table) => {
    const request = table.get(key(history.userId, history.bookId));
    request.onsuccess = () => {
      const previous = request.result as LayoutHistory | undefined;
      if (previous?.version !== expectedVersion) {
        table.transaction.abort();
        return;
      }
      table.put({ ...history, key: key(history.userId, history.bookId) });
    };
    return request;
  });
}
