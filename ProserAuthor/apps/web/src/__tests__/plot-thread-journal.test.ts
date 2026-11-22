import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readPlotThreadIntent,
  writePlotThreadIntent,
  deletePlotThreadIntent,
  type PlotThreadIntent,
} from '@/lib/plot-thread-journal';
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
    if (aborted) throw new Error('Competing journal request');
    stored.clear();
    for (const [key, value] of next) stored.set(key, value);
    return request.result;
  },
}));
const intent = (): PlotThreadIntent => ({
  userId: 'owner',
  bookId: '7',
  operationId: 'original',
  kind: 'review',
  method: 'POST',
  path: '/api/books/7/plot-threads/4/reviews',
  recoveryPath: '/api/books/7/plot-threads/4/reviews/original',
  body: { operationId: 'original', expectedVersion: 3, expectedRevisionId: 'saved-source' },
});
beforeEach(() => stored.clear());
describe('Plot Threads durable recovery', () => {
  it('retains an exact unknown request across reopening without revealing another account or book', async () => {
    const original = intent();
    await writePlotThreadIntent(original);
    expect(await readPlotThreadIntent('owner', '7')).toMatchObject(original);
    expect(await readPlotThreadIntent('other', '7')).toBeUndefined();
    expect(await readPlotThreadIntent('owner', '8')).toBeUndefined();
  });
  it('rejects competing operations and changed original bodies before dispatch', async () => {
    const original = intent();
    await writePlotThreadIntent(original);
    await writePlotThreadIntent(original);
    await expect(
      writePlotThreadIntent({
        ...original,
        operationId: 'other',
        body: { ...original.body, operationId: 'other' },
      }),
    ).rejects.toThrow('Competing');
    await expect(
      writePlotThreadIntent({ ...original, body: { ...original.body, expectedVersion: 99 } }),
    ).rejects.toThrow('Competing');
    expect(await readPlotThreadIntent('owner', '7')).toMatchObject(original);
  });
  it('ignores a stale deletion and releases only the acknowledged operation', async () => {
    await writePlotThreadIntent(intent());
    await deletePlotThreadIntent('owner', '7', 'other');
    expect(await readPlotThreadIntent('owner', '7')).toBeDefined();
    await deletePlotThreadIntent('owner', '7', 'original');
    expect(await readPlotThreadIntent('owner', '7')).toBeUndefined();
  });
});
