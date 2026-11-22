// In-memory Redis mock — avoids needing a real Redis server for tests.
const _store = new Map<string, string>();
const _ttls = new Map<string, NodeJS.Timeout>();
const redisMock: Record<string, any> = {
  eval: jest.fn(async (script: string, _numKeys: number, key: string) => {
    if (!script.includes("redis.call('INCR'")) return 1;
    const value = parseInt(_store.get(key) || '0', 10) + 1;
    _store.set(key, String(value));
    return value;
  }),
  incr: jest.fn(async (key: string) => {
    const v = parseInt(_store.get(key) || '0', 10) + 1;
    _store.set(key, String(v));
    return v;
  }),
  expire: jest.fn(async (_key: string, _sec: number) => 1),
  get: jest.fn(async (key: string) => _store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, ..._args: any[]) => {
    _store.set(key, value);
    return 'OK';
  }),
  del: jest.fn(async (...keys: string[]) => {
    let count = 0;
    for (const k of keys) { if (_store.delete(k)) count++; }
    return count;
  }),
  ping: jest.fn(async () => 'PONG'),
  info: jest.fn(async () => 'rdb_last_bgsave_status:ok\r\naof_last_write_status:ok\r\n'),
  config: jest.fn(async () => ['save', '900 1', 'appendonly', 'no']),
  publish: jest.fn(async () => 0),
  flushdb: jest.fn(async () => { _store.clear(); return 'OK'; }),
  connect: jest.fn(async () => {}),
  disconnect: jest.fn(async () => {}),
  quit: jest.fn(async () => 'OK'),
  on: jest.fn(() => redisMock) as any,
  status: 'ready',
};
jest.mock('../lib/redis', () => ({ __esModule: true, default: redisMock }));
jest.mock('../queues/featureFlag', () => ({ __esModule: true, isBullmqEnabled: () => false }));

import { databaseService } from '../lib/database';
import { shutdownBullConnections } from '../queues/connection';
import { shutdownWorkflowQueue } from '../queues/workflowQueue';

// Tests share a PostgreSQL database and must clean up fixtures they create.

beforeAll(async () => {
  // Mock global fetch to avoid real network calls (prevents hanging open sockets during tests)
  if (!(global as any).__ORIGINAL_FETCH__) {
    (global as any).__ORIGINAL_FETCH__ = global.fetch;
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ response: 'mock-response', done: true })
    })) as any);
  }
  try { await databaseService.connect(); } catch {}
  _store.clear();
});

afterAll(async () => {
  // Keep dev DB lean across repeated local runs: remove test fixtures.
  try {
    if (databaseService.isReady) {
      await databaseService.client.user.deleteMany({
        where: { githubId: { startsWith: 'jest-' } },
      });
    }
  } catch {}
  try { await databaseService.disconnect(); } catch {}
  _store.clear();
  try { await shutdownWorkflowQueue(); } catch {}
  try { await shutdownBullConnections(); } catch {}
  // Restore original fetch (cleanup)
  if ((global as any).__ORIGINAL_FETCH__) {
    global.fetch = (global as any).__ORIGINAL_FETCH__;
    delete (global as any).__ORIGINAL_FETCH__;
  }
});
