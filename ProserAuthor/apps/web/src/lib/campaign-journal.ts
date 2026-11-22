import { documentDraftStore } from './document-drafts';
export interface CampaignIntent {
  userId: string;
  bookId: string;
  operationId: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: Record<string, unknown>;
  recoveryPath: string;
  kind: 'mutation' | 'campaign' | 'review' | 'discussion' | 'proposal' | 'apply';
}
type Row = CampaignIntent & { key: string };
const key = (userId: string, bookId: string) =>
  JSON.stringify(['revision-campaign-v1', userId, bookId]);
export async function writeCampaignIntent(intent: CampaignIntent) {
  if (
    !intent.userId ||
    !intent.bookId ||
    intent.body.operationId !== intent.operationId ||
    JSON.stringify(intent).length > 256000
  )
    throw new Error('Invalid campaign recovery request.');
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(intent.userId, intent.bookId));
    request.onsuccess = () => {
      const previous = request.result as Row | undefined;
      if (
        previous &&
        JSON.stringify(previous) !==
          JSON.stringify({ ...intent, key: key(intent.userId, intent.bookId) })
      ) {
        table.transaction.abort();
        return;
      }
      table.put({ ...intent, key: key(intent.userId, intent.bookId) });
    };
    return request;
  });
}
export async function readCampaignIntent(userId: string, bookId: string) {
  const row = await documentDraftStore<Row | undefined>('readonly', (table) =>
    table.get(key(userId, bookId)),
  );
  return row?.userId === userId && row?.bookId === bookId ? row : undefined;
}
export async function deleteCampaignIntent(userId: string, bookId: string, operationId: string) {
  await documentDraftStore<Row | undefined>('readwrite', (table) => {
    const request = table.get(key(userId, bookId));
    request.onsuccess = () => {
      if ((request.result as Row | undefined)?.operationId === operationId)
        table.delete(key(userId, bookId));
    };
    return request;
  });
}
