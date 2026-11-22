import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// In-memory fake Redis client supporting the minimal API we use
type Entry = { value: string; expiresAt?: number };
const store: Map<string, Entry> = new Map();

const client = {
  async set(key: string, value: string, mode?: string, px?: number, cond?: string): Promise<'OK' | null> {
    // Support: set(key, value, 'PX', ttlMs, 'NX')
    const now = Date.now();
    // Purge expired
    const current = store.get(key);
    if (current?.expiresAt && current.expiresAt <= now) store.delete(key);
    if (cond === 'NX') {
      if (store.has(key)) return null;
    }
    let expiresAt: number | undefined;
    if (mode === 'PX' && typeof px === 'number') {
      expiresAt = now + px;
    }
    store.set(key, { value, expiresAt });
    return 'OK';
  },
  async get(key: string): Promise<string | null> {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= now) { store.delete(key); return null; }
    return entry.value;
  },
  async pexpire(key: string, ttlMs: number): Promise<number> {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry) return 0;
    if (entry.expiresAt && entry.expiresAt <= now) { store.delete(key); return 0; }
    entry.expiresAt = now + ttlMs;
    store.set(key, entry);
    return 1;
  },
  async del(key: string): Promise<number> {
    return store.delete(key) ? 1 : 0;
  },
  on: () => {}
};

// Mock the BullMQ connection to return our in-memory client
jest.mock('../queues/connection', () => ({
  getBullConnections: () => ({ client, subscriber: client }),
  buildQueueBaseOptions: () => ({ connection: client, prefix: 'proser' })
}));

import { acquireBookLock, extendBookLock, releaseBookLock } from '../lib/locks';

describe('book lock helper', () => {
  beforeEach(() => { store.clear(); });

  it('acquires, extends, and releases a lock', async () => {
    const bookId = 42;
    const ok1 = await acquireBookLock(bookId, 100);
    expect(ok1).toBe(true);
    // second acquire should fail while held
    const ok2 = await acquireBookLock(bookId, 100);
    expect(ok2).toBe(false);
    // extend should succeed
    const ext = await extendBookLock(bookId, 200);
    expect(ext).toBe(true);
    // release
    await releaseBookLock(bookId);
    const ok3 = await acquireBookLock(bookId, 100);
    expect(ok3).toBe(true);
  });
});
