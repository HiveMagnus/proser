import redis from './index';
import logger from '../logger';

const DEFAULT_TTL_SECONDS = 300;

export async function getJson<T>(key: string): Promise<T | null> {
  try { const raw = await redis.get(key); return raw ? JSON.parse(raw) as T : null; } catch (e) { logger.warn({ err: (e as Error).message, key }, 'Redis getJson failed'); return null; }
}

export async function setJson(key: string, value: unknown, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  try { await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds); } catch (e) { logger.warn({ err: (e as Error).message, key }, 'Redis setJson failed'); }
}

async function incrVersion(namespace: string, bookId: number): Promise<number> {
  const key = `${namespace}:book:${bookId}:version`; let v = 0;
  try { v = await redis.incr(key); await redis.expire(key, 86400); } catch { /* ignore */ }
  return v;
}

async function getVersion(namespace: string, bookId: number): Promise<number> {
  const key = `${namespace}:book:${bookId}:version`; try { const v = await redis.get(key); return v ? parseInt(v, 10) : 0; } catch { return 0; }
}

export async function getStructureCache(bookId: number) {
  const version = await getVersion('structure', bookId);
  const key = `structure:book:${bookId}:v${version}`;
  return { key, version, data: await getJson<unknown>(key) };
}

export async function cacheStructure(bookId: number, data: unknown) {
  const version = await getVersion('structure', bookId);
  const key = `structure:book:${bookId}:v${version}`;
  await setJson(key, data);
}

export async function invalidateStructure(bookId: number) { await incrVersion('structure', bookId); }

// Book exports are not cached; the counter remains for callers that mark a book's content as changed.
export async function invalidateExport(bookId: number) { await incrVersion('export', bookId); }

export async function invalidateBookContent(bookId: number) { await Promise.all([invalidateStructure(bookId), invalidateExport(bookId)]); }

// RAG: Codex retrieval cache versioning per book
export async function getRagCodexCacheKey(bookId: number, scope: 'scene' | 'chapter' | 'book', refId: number | undefined, hash: string) {
  const version = await getVersion('rag:codex', bookId);
  const key = `rag:codex:book:${bookId}:${scope}:${refId ?? 0}:v${version}:${hash}`;
  return { key, version };
}

export async function invalidateRagCodex(bookId: number) { await incrVersion('rag:codex', bookId); }
