import { describe, expect, it, vi } from 'vitest';
import {
  writeCampaignIntent,
  readCampaignIntent,
  deleteCampaignIntent,
  type CampaignIntent,
} from '@/lib/campaign-journal';
import { readPlotThreadIntent } from '@/lib/plot-thread-journal';
import { verifyCampaignAcknowledgement } from '@/lib/campaign-api';
import { getMobileRoute } from '@/lib/mobile-routing';
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
const intent = (userId = 'campaign-author', bookId = crypto.randomUUID()): CampaignIntent => {
  const operationId = crypto.randomUUID();
  return {
    userId,
    bookId,
    operationId,
    path: `/api/books/${bookId}/revision-campaigns`,
    method: 'POST',
    body: { operationId, expectedVersion: 0, goal: 'Strengthen the antagonist' },
    recoveryPath: `/api/books/${bookId}/revision-campaigns/operations/${operationId}`,
    kind: 'campaign',
  };
};
describe('campaign recovery and routing', () => {
  it('retains exact intents in separate account, book and workflow namespaces', async () => {
    const original = intent();
    await writeCampaignIntent(original);
    expect(await readCampaignIntent(original.userId, original.bookId)).toMatchObject(original);
    expect(await readCampaignIntent('another-author', original.bookId)).toBeUndefined();
    expect(await readCampaignIntent(original.userId, 'another-book')).toBeUndefined();
    expect(await readPlotThreadIntent(original.userId, original.bookId)).toBeUndefined();
    await deleteCampaignIntent(original.userId, original.bookId, original.operationId);
  });
  it('another tab cannot overwrite a pending operation or delete it with another UUID', async () => {
    const original = intent();
    await writeCampaignIntent(original);
    await expect(
      writeCampaignIntent({ ...original, operationId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await deleteCampaignIntent(original.userId, original.bookId, crypto.randomUUID());
    expect(await readCampaignIntent(original.userId, original.bookId)).toMatchObject(original);
    await deleteCampaignIntent(original.userId, original.bookId, original.operationId);
  });
  it('rejects acknowledgments for other operations and checks original application receipts', () => {
    const original = intent();
    expect(() =>
      verifyCampaignAcknowledgement(original, { operationId: crypto.randomUUID() }),
    ).toThrow();
    expect(() =>
      verifyCampaignAcknowledgement(original, { operationId: original.operationId }),
    ).not.toThrow();
    expect(() =>
      verifyCampaignAcknowledgement(
        { ...original, kind: 'apply' },
        { application: { operationId: original.operationId } },
        true,
      ),
    ).not.toThrow();
  });
  it('routes campaigns explicitly into the mobile editorial shell', () => {
    expect(getMobileRoute('/editorial/campaigns')).toBe('/m/editorial/campaigns');
    expect(getMobileRoute('/m/editorial/campaigns')).toBe('/m/editorial/campaigns');
  });
});
