import { projectDocument, type ProserDocument } from '@hivemagnus/proser-contracts';
import { documentDraftStore } from './document-drafts';

/**
 * Browser databases that hold manuscript text, comments or operations not yet
 * confirmed by Factory. Signing out leaves them in place unless the writer
 * removes them, so a shared device can keep another writer's text.
 */
export const LOCAL_WRITING_DATABASES = [
  'proser-document-drafts',
  'proser-document-intents',
  'proser-document-review-operations',
  'proser-chapter-transition-reviews',
] as const;

export interface LocalDraft {
  key: string;
  kind: 'scene' | 'passage';
  bookId: string;
  sceneId: string;
  updatedAt: number;
  /** A save was prepared or sent but Factory has not confirmed it. */
  unsent: boolean;
  text: string;
}

type Row = Record<string, unknown> & { key?: unknown };

function parsedKey(key: unknown): unknown[] | null {
  if (typeof key !== 'string') return null;
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function documentText(document: unknown): string {
  try {
    return projectDocument(document as ProserDocument).text;
  } catch {
    return '';
  }
}

/** Scene and passage drafts that belong to this writer, newest first. */
export function localDraftsFromRows(rows: readonly unknown[], userId: string): LocalDraft[] {
  const drafts: LocalDraft[] = [];
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Row;
    const key = parsedKey(row.key);
    if (!key || key[1] !== userId || row.userId !== userId) continue;
    const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0;
    if (key[0] === 'v1' && row.document) {
      drafts.push({
        key: row.key as string,
        kind: 'scene',
        bookId: String(row.bookId ?? ''),
        sceneId: String(row.sceneId ?? ''),
        updatedAt,
        unsent: Boolean(row.pendingSave),
        text: documentText(row.document),
      });
    } else if (key[0] === 'passage-v1' && Array.isArray(row.drafts)) {
      const runs = row.drafts as Array<{ text?: unknown }>;
      drafts.push({
        key: row.key as string,
        kind: 'passage',
        bookId: String(row.bookId ?? ''),
        sceneId: String(row.sceneId ?? ''),
        updatedAt,
        unsent: Boolean(row.pending || row.prepared),
        text: row.document
          ? documentText(row.document)
          : runs.map((run) => (typeof run.text === 'string' ? run.text : '')).join('\n\n'),
      });
    }
  }
  return drafts.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function listLocalDrafts(userId: string): Promise<LocalDraft[]> {
  const rows = await documentDraftStore<unknown[]>('readonly', (table) => table.getAll());
  return localDraftsFromRows(rows, userId);
}

/** A plain-text file with every listed draft, for keeping before they are removed. */
export function localDraftsExport(drafts: readonly LocalDraft[], exportedAt = new Date()): string {
  const sections = drafts.map((draft) =>
    [
      `## Book ${draft.bookId}, scene ${draft.sceneId}`,
      `Kept in this browser ${new Date(draft.updatedAt).toISOString()}${
        draft.unsent ? ' (save not confirmed by Proser)' : ''
      }`,
      '',
      draft.text,
    ].join('\n'),
  );
  return [
    `# Proser drafts kept in this browser`,
    `Exported ${exportedAt.toISOString()}`,
    '',
    ...sections,
    '',
  ].join('\n\n');
}

export function downloadLocalDrafts(drafts: readonly LocalDraft[]): void {
  const url = URL.createObjectURL(
    new Blob([localDraftsExport(drafts)], { type: 'text/plain;charset=utf-8' }),
  );
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `proser-local-drafts-${new Date().toISOString().slice(0, 10)}.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not remove ${name}`));
    request.onblocked = () =>
      reject(new Error('Close other Proser tabs, then remove the local drafts again.'));
  });
}

/** Remove every Proser draft, recovery journal and session receipt from this browser. */
export async function clearLocalWritingData(): Promise<void> {
  await Promise.all(LOCAL_WRITING_DATABASES.map(deleteDatabase));
  try {
    window.sessionStorage.clear();
  } catch {
    /* Session storage may be unavailable; it ends with the tab anyway. */
  }
}
