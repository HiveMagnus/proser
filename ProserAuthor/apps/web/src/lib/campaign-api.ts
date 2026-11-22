import { requestFactory } from './api';
import type { CampaignIntent } from './campaign-journal';
export function verifyCampaignAcknowledgement(
  intent: CampaignIntent,
  value: unknown,
  recovery = false,
) {
  const row = value as {
    operationId?: string;
    id?: string;
    status?: string;
    application?: { operationId?: string };
  } | null;
  const operationId =
    recovery && intent.kind === 'apply'
      ? row?.application?.operationId
      : ['campaign', 'mutation', 'apply'].includes(intent.kind)
        ? row?.operationId
        : row?.id;
  if (!row || operationId !== intent.operationId)
    throw new Error('Acknowledgment belongs to another operation. Recover the original request.');
}
export const campaignRequest = <T>(path: string, userId: string, method = 'GET', body?: unknown) =>
  requestFactory<T>(path, {
    method,
    headers: { 'X-Proser-Expected-User': encodeURIComponent(userId) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 150000,
  });
