import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { databaseService } from '@/lib/database';
import { DocumentError } from '@/documents/errors';

/** A writer can switch AI off for one book. Factory then refuses every
 * model-provider request made on that book's behalf: inference, embeddings,
 * image generation and queued work, before the request leaves Factory.
 *
 * The books a request or job acts on are carried in async context, so the
 * provider gate (admitReleaseMutation's 'provider' kind and the embedding
 * client) can check them without every call site passing a book ID. */

export const BOOK_AI_DISABLED = 'BOOK_AI_DISABLED';

const scope = new AsyncLocalStorage<{ bookIds: readonly number[] }>();

const bookId = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** Run `action` with these books added to the current AI scope. */
export function runWithAiBookScope<T>(bookIds: Iterable<unknown>, action: () => T): T {
  const ids = new Set(scope.getStore()?.bookIds ?? []);
  for (const value of bookIds) { const id = bookId(value); if (id) ids.add(id); }
  return scope.run({ bookIds: [...ids] }, action);
}

export function currentAiBookIds(): readonly number[] {
  return scope.getStore()?.bookIds ?? [];
}

export function bookAiDisabledError(bookIds: readonly number[]) {
  return new DocumentError(BOOK_AI_DISABLED, 'AI is switched off for this book. Turn it back on in the book settings to use AI features.', 409, { bookIds });
}

export function isBookAiDisabledError(error: unknown): error is DocumentError {
  return error instanceof DocumentError && error.code === BOOK_AI_DISABLED;
}

/** The given books (and those in the current scope) that have AI switched
 * off, optionally only among one user's books. */
export async function aiDisabledBooks(extra: Iterable<unknown> = [], ownerId?: number): Promise<number[]> {
  const ids = new Set(currentAiBookIds());
  for (const value of extra) { const id = bookId(value); if (id) ids.add(id); }
  if (!ids.size) return [];
  const rows = await databaseService.client.bookAiPolicy.findMany({ where: { bookId: { in: [...ids] }, aiDisabled: true, ...(ownerId === undefined ? {} : { book: { userId: ownerId } }) }, select: { bookId: true } });
  return rows.map((row) => row.bookId).sort((a, b) => a - b);
}

/** Refuse a provider request when any book it acts for has AI switched off. */
export async function assertBookAiAllowed(extra: Iterable<unknown> = []): Promise<void> {
  const disabled = await aiDisabledBooks(extra);
  if (disabled.length) throw bookAiDisabledError(disabled);
}

/** Book IDs a request names: `/books/:id/...` paths, and top-level `bookId`
 * in the query or JSON body. Requests that reach a book only through another
 * resource (workflow runs, generation operations, provider effects) are
 * scoped where that work executes. */
export function requestBookIds(req: Pick<Request, 'path' | 'query' | 'body'>): number[] {
  const ids = new Set<number>();
  const path = /^\/books\/(\d{1,10})(?:\/|$)/.exec(req.path);
  if (path) ids.add(Number(path[1]));
  for (const source of [req.query as Record<string, unknown> | undefined, req.body as Record<string, unknown> | undefined]) {
    if (!source || typeof source !== 'object') continue;
    const values = Array.isArray(source.bookId) ? source.bookId : [source.bookId, source.book_id];
    for (const value of values) { const id = bookId(value); if (id) ids.add(id); }
  }
  return [...ids];
}

/** Requests that exist to call a model provider. They are refused up front,
 * before any operation, workflow or preview record is created; everything
 * else is still guarded at the provider boundary. Paths are relative to /api. */
const AI_REQUESTS: readonly RegExp[] = [
  /^\/generate\/(?!operations\/[^/]+\/cancel$)/,
  /^\/images?\/(?:generate(?:\/flux)?|suggest-prompt)$/,
  /^\/workflows\/(?:full-book|quality-review|improve-quality|guided-improve|editorial-optimize)$/,
  /^\/books\/\d+\/chapters\/\d+\/scenes\/generate$/,
  /^\/books\/\d+\/scenes\/\d+\/regenerate$/,
  /^\/books\/\d+\/document-(?:story-)?discussions\/[^/]+\/proposals$/,
  /^\/books\/\d+\/plot-threads\/\d+\/reviews$/,
  /^\/books\/\d+\/revision-campaigns\/[^/]+\/analyses$/,
];

export function isAiRequest(method: string, path: string): boolean {
  return method === 'POST' && AI_REQUESTS.some((pattern) => pattern.test(path));
}

/** API middleware: scope the rest of the request to the books it names. */
export function bookAiScopeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const ids = requestBookIds(req);
  if (!ids.length) { next(); return; }
  runWithAiBookScope(ids, next);
}

/** After authentication: refuse a known AI request that names one of the
 * caller's books with AI switched off, before any work is recorded. Other
 * users' books are not reported; their requests fail ownership checks. */
export async function refuseAiRequestForDisabledBook(method: string, originalUrl: string, userId: number): Promise<void> {
  const path = originalUrl.split('?')[0].replace(/^\/api(?=\/)/, '');
  if (!isAiRequest(method.toUpperCase(), path)) return;
  const disabled = await aiDisabledBooks([], userId);
  if (disabled.length) throw bookAiDisabledError(disabled);
}
