jest.mock('@/core/config', () => ({ CONFIG: { BULLMQ_PREFIX: 'fixture', GIT_COMMIT: 'current' } }));
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { zrangebyscore: jest.fn(), mget: jest.fn() } }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
import redis from '@/lib/redis';
import { validWorkerHeartbeat, workersReady, requiredWorkerQueues } from '@/workers/heartbeat';

const now = 100_000;
const receipt = (queues: string[]) => ({ schemaVersion: 1, timestamp: now, queues, revision: 'current' });
test('heartbeat freshness, schema and installed revision are required', () => {
  expect(validWorkerHeartbeat(receipt([...requiredWorkerQueues]), now, 'current')).toBe(true);
  expect(validWorkerHeartbeat({ ...receipt([]), timestamp: now - 45_000 }, now, 'current')).toBe(false);
  expect(validWorkerHeartbeat({ ...receipt([]), timestamp: now + 10_000 }, now, 'current')).toBe(false);
  expect(validWorkerHeartbeat(receipt([]), now, 'other')).toBe(false);
  expect(validWorkerHeartbeat({ ...receipt([]), schemaVersion: 2 }, now, null)).toBe(false);
});
test('all required queues need valid receipts; one consumer or malformed data cannot establish readiness', async () => {
  (redis.zrangebyscore as jest.Mock).mockResolvedValue(['first', 'second']);
  (redis.mget as jest.Mock).mockResolvedValue([JSON.stringify(receipt([requiredWorkerQueues[0]])), JSON.stringify(receipt([requiredWorkerQueues[1]]))]);
  expect(await workersReady(now)).toBe(true);
  (redis.mget as jest.Mock).mockResolvedValue([JSON.stringify(receipt([requiredWorkerQueues[0]])), '{malformed']);
  expect(await workersReady(now)).toBe(false);
  (redis.zrangebyscore as jest.Mock).mockResolvedValue([]);
  expect(await workersReady(now)).toBe(false);
});
