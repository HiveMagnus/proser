import type {
  PlotThreadRecord,
  PlotThreadSummary,
  PlotThreadReviewRecord,
} from '@hivemagnus/proser-contracts';
import { requestFactory } from './api';
import type { PlotThreadIntent } from './plot-thread-journal';
export function verifyPlotThreadAcknowledgement(
  intent: PlotThreadIntent,
  value: unknown,
  recovery = false,
) {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid acknowledgment. Recover the original operation.');
  const row = value as {
    operationId?: string;
    id?: string;
    threadId?: number;
    version?: number;
    status?: string;
    application?: { operationId?: string };
  };
  const operationId =
    recovery && intent.kind === 'apply'
      ? row.application?.operationId
      : intent.kind === 'mutation' || intent.kind === 'apply'
        ? row.operationId
        : row.id;
  if (operationId !== intent.operationId)
    throw new Error('Acknowledgment belongs to another operation. Recover the original request.');
  if (intent.kind === 'mutation') {
    const match = intent.path.match(/\/plot-threads\/(\d+)/);
    if (
      !Number.isSafeInteger(row.threadId) ||
      (row.threadId ?? 0) <= 0 ||
      !Number.isSafeInteger(row.version) ||
      (row.version ?? -1) < Number(intent.body.expectedVersion) ||
      (row.version ?? -1) > Number(intent.body.expectedVersion) + 1 ||
      (match && row.threadId !== Number(match[1]))
    )
      throw new Error('Thread receipt belongs to another source. Recover the original operation.');
  }
  if (
    ['review', 'proposal'].includes(intent.kind) &&
    ![
      'pending',
      'running',
      'ready',
      'failed',
      'unknown',
      'cancelled',
      ...(intent.kind === 'proposal' ? ['applied'] : []),
    ].includes(row.status ?? '')
  )
    throw new Error('Invalid operation status. Recover the original request.');
}
export const plotThreadBase = (bookId: string) =>
  `/api/books/${encodeURIComponent(bookId)}/plot-threads`;
export const plotRequest = <T>(path: string, userId: string, method = 'GET', body?: unknown) =>
  requestFactory<T>(path, {
    method,
    headers: { 'X-Proser-Expected-User': encodeURIComponent(userId) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 150000,
  });
export const listThreads = (bookId: string, userId: string, archived = false, after?: number) =>
  plotRequest<{ threads: PlotThreadSummary[]; next: number | null }>(
    `${plotThreadBase(bookId)}?archived=${archived}${after ? `&after=${after}` : ''}`,
    userId,
  );
export const readThread = (bookId: string, userId: string, threadId: number) =>
  plotRequest<PlotThreadRecord>(`${plotThreadBase(bookId)}/${threadId}`, userId);
export const readThreadReview = (
  bookId: string,
  userId: string,
  threadId: number,
  reviewId: string,
) =>
  plotRequest<PlotThreadReviewRecord>(
    `${plotThreadBase(bookId)}/${threadId}/reviews/${reviewId}`,
    userId,
  );
