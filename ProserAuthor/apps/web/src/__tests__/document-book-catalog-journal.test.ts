import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readBookCatalogIntent,
  writeBookCatalogIntent,
  deleteBookCatalogIntent,
  type BookCatalogIntent,
} from '@/lib/document-book-catalog-journal';
const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/document-drafts', () => ({
  documentDraftStore: async (
    _mode: IDBTransactionMode,
    operation: (table: IDBObjectStore) => IDBRequest<unknown>,
  ) => {
    let aborted = false;
    const next = new Map(stored);
    const table = {
      transaction: {
        abort: () => {
          aborted = true;
        },
      },
      get: (key: string) => ({ result: structuredClone(stored.get(key)), onsuccess: undefined }),
      put: (row: { key: string }) => next.set(row.key, structuredClone(row)),
      delete: (key: string) => next.delete(key),
    };
    const request = operation(table as unknown as IDBObjectStore);
    await Promise.resolve();
    request.onsuccess?.call(request, new Event('success'));
    if (aborted) throw new Error('Journal transaction aborted');
    stored.clear();
    for (const [key, value] of next) stored.set(key, value);
    return request.result;
  },
}));
const intent = (): BookCatalogIntent => ({
  schemaVersion: 1,
  userId: 'owner',
  bookId: '7',
  version: 'version-before',
  updatedAt: Date.now(),
  operationId: 'operation',
  kind: 'delete',
  status: 'unknown',
  snapshot: {
    snapshotId: 'source',
    userId: 'owner',
    bookId: '7',
    book: { id: '7', title: 'Owned book' },
    bookRevisionId: 'book-before',
    structureRevisionId: 'structure-before',
    sourceBook: {
      title: 'Owned book',
      summary: null,
      genre: null,
      targetAudience: null,
      draftStatus: 'draft',
      tagline: null,
      storyOutline: null,
      storyArchetypeKey: null,
      selectedImageId: 0,
    },
  },
  preconditions: {
    operationId: 'operation',
    expectedRevisionId: 'book-before',
    expectedScopes: { structure: 'structure-before' },
  },
});
beforeEach(() => stored.clear());
describe('book catalog journal CAS', () => {
  it('retains the exact owner and unknown request beyond thirty days without revealing it to another user', async () => {
    const row = { ...intent(), updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 };
    await writeBookCatalogIntent(row);
    expect(await readBookCatalogIntent('owner')).toMatchObject(row);
    expect(await readBookCatalogIntent('foreign')).toBeUndefined();
  });
  it('rejects a competing initial write and mutations to an existing exact operation', async () => {
    const row = intent();
    await writeBookCatalogIntent(row);
    await expect(
      writeBookCatalogIntent({
        ...row,
        operationId: 'other',
        preconditions: { ...row.preconditions, operationId: 'other' },
      }),
    ).rejects.toThrow('aborted');
    await expect(
      writeBookCatalogIntent(
        {
          ...row,
          snapshot: { ...row.snapshot, book: { ...row.snapshot.book, title: 'Replaced source' } },
        },
        row.version,
      ),
    ).rejects.toThrow('aborted');
    expect(await readBookCatalogIntent('owner')).toMatchObject(row);
  });
  it('permits status progress under exact CAS and rejects stale acknowledgement deletion', async () => {
    const row = intent();
    await writeBookCatalogIntent(row);
    const next = { ...row, version: 'new-version', status: 'not-found' as const };
    await writeBookCatalogIntent(next, row.version);
    await expect(deleteBookCatalogIntent('owner', row.version, row.operationId)).rejects.toThrow(
      'aborted',
    );
    expect(await readBookCatalogIntent('owner')).toMatchObject(next);
    await deleteBookCatalogIntent('owner', next.version, next.operationId);
    expect(await readBookCatalogIntent('owner')).toBeUndefined();
  });
  it('rejects foreign/mismatched source ownership and missing preconditions', async () => {
    const row = intent();
    await expect(
      writeBookCatalogIntent({ ...row, snapshot: { ...row.snapshot, userId: 'foreign' } }),
    ).rejects.toThrow('another user');
    await expect(
      writeBookCatalogIntent({
        ...row,
        preconditions: { ...row.preconditions, expectedRevisionId: 'guessed' },
      }),
    ).rejects.toThrow('invalid');
    expect(stored.size).toBe(0);
  });
});
