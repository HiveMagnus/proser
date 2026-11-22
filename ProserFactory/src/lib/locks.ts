import { getBullConnections } from '../queues/connection';
import { CONFIG } from '../core/config';
import logger from './logger';

const PREFIX = () => `${CONFIG.BULLMQ_PREFIX || 'proser'}:locks`;

function keyForBook(bookId: number): string {
  return `${PREFIX()}:book:${bookId}`;
}

/**
 * Acquire a simple Redis lock for a given book. Returns true if acquired.
 * Uses SET NX PX ttlMs to avoid deadlocks. Caller should release when done.
 */
export async function acquireBookLock(bookId: number, ttlMs = 10 * 60 * 1000): Promise<boolean> {
  try {
    const { client } = getBullConnections();
    const res = await client.set(keyForBook(bookId), '1', 'PX', ttlMs, 'NX');
    return res === 'OK';
  } catch (err) {
    logger.warn({ err, bookId }, 'Failed to acquire book lock');
    return false;
  }
}

/**
 * Refresh the book lock TTL if currently held. Returns true if extended.
 */
export async function extendBookLock(bookId: number, ttlMs = 10 * 60 * 1000): Promise<boolean> {
  try {
    const { client } = getBullConnections();
    const k = keyForBook(bookId);
    const exists = await client.get(k);
    if (!exists) return false;
    await client.pexpire(k, ttlMs);
    return true;
  } catch (err) {
    logger.warn({ err, bookId }, 'Failed to extend book lock');
    return false;
  }
}

/**
 * Release a previously acquired book lock.
 */
export async function releaseBookLock(bookId: number): Promise<void> {
  try {
    const { client } = getBullConnections();
    await client.del(keyForBook(bookId));
  } catch (err) {
    logger.warn({ err, bookId }, 'Failed to release book lock');
  }
}
