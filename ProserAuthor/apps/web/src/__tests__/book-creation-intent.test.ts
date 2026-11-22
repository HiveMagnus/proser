import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bookCreationIntentKey,
  readBookCreationIntent,
  writeBookCreationIntent,
  deleteBookCreationIntent,
  type BookCreationIntent,
} from '@/lib/book-creation-intent';
const memory = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock('@/lib/document-drafts', () => ({
  documentDraftStore: async (
    _mode: IDBTransactionMode,
    operation: (table: IDBObjectStore) => IDBRequest<unknown>,
  ) => {
    let aborted = false;
    let selected: { result: unknown; onsuccess?: () => void } | undefined;
    const changes: Array<() => void> = [];
    const table = {
      transaction: {
        abort: () => {
          aborted = true;
        },
      },
      get: (key: string) => {
        selected = {
          result: memory.rows.has(key) ? structuredClone(memory.rows.get(key)) : undefined,
        };
        return selected;
      },
      put: (row: { key: string }) => {
        changes.push(() => memory.rows.set(row.key, structuredClone(row)));
      },
      delete: (key: string) => {
        changes.push(() => memory.rows.delete(key));
      },
    };
    const request = operation(table as unknown as IDBObjectStore);
    await Promise.resolve();
    selected?.onsuccess?.();
    if (aborted) throw new DOMException('Journal CAS aborted', 'AbortError');
    for (const change of changes) change();
    return request.result;
  },
}));
const row = (patch: Partial<BookCreationIntent> = {}): BookCreationIntent => ({
  schemaVersion: 1,
  userId: 'first-author',
  operationId: 'original-operation',
  version: 'v1',
  updatedAt: Date.now(),
  request: { title: 'Exact 😀 title', summary: 'Original\n\n e\u0301' },
  state: 'prepared',
  ...patch,
});
beforeEach(() => memory.rows.clear());
describe('book creation journal ownership and CAS', () => {
  it('does not reveal another author’s request and keeps its independent key', async () => {
    const original = row();
    await writeBookCreationIntent(original);
    expect(await readBookCreationIntent('second-author')).toBeUndefined();
    expect(await readBookCreationIntent('first-author')).toEqual(original);
    expect(bookCreationIntentKey('first-author')).not.toContain('quick-draft');
  });
  it('rejects competing requests, changed original input and stale deletion without erasing the exact request', async () => {
    const original = row();
    await writeBookCreationIntent(original);
    await expect(writeBookCreationIntent(row({ operationId: 'other' }))).rejects.toThrow(
      'another tab',
    );
    await expect(
      writeBookCreationIntent(row({ version: 'v2', request: { title: 'modified' } }), 'v1'),
    ).rejects.toThrow('another tab');
    await writeBookCreationIntent(row({ version: 'v2', state: 'dispatched' }), 'v1');
    await expect(
      deleteBookCreationIntent('first-author', 'original-operation', 'v1'),
    ).rejects.toThrow('newer');
    expect((await readBookCreationIntent('first-author'))?.request).toEqual(original.request);
    await deleteBookCreationIntent('first-author', 'original-operation', 'v2');
    await expect(writeBookCreationIntent(row({ version: 'v3' }), 'v2')).rejects.toThrow(
      'another tab',
    );
    expect(await readBookCreationIntent('first-author')).toBeUndefined();
  });
  it('retains uncertain effects beyond thirty days and expires only definite undispatched/rejected drafts', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await writeBookCreationIntent(row({ updatedAt: old, state: 'dispatched' }));
    expect((await readBookCreationIntent('first-author'))?.operationId).toBe('original-operation');
    await deleteBookCreationIntent('first-author', 'original-operation', 'v1');
    await writeBookCreationIntent(row({ updatedAt: old, state: 'prepared' }));
    expect(await readBookCreationIntent('first-author')).toBeUndefined();
  });
  it('rejects invalid retained payloads visibly and prevents replacement by another request', async () => {
    memory.rows.set(bookCreationIntentKey('first-author'), {
      ...row(),
      key: bookCreationIntentKey('first-author'),
      request: { title: 42 },
    });
    await expect(readBookCreationIntent('first-author')).rejects.toThrow('invalid');
    await expect(writeBookCreationIntent(row())).rejects.toThrow('another tab');
  });
});
