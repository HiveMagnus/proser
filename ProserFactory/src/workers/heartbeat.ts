import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { CONFIG } from '@/core/config';
import redis from '@/lib/redis';
import logger from '@/lib/logger';

const ttlMs = 45_000;
const heartbeatKey = `${CONFIG.BULLMQ_PREFIX}:worker-heartbeats`;
export const requiredWorkerQueues = ['live-prose-judge', 'book-workflow-v1'] as const;
export interface WorkerHeartbeat { schemaVersion: 1; timestamp: number; queues: string[]; revision: string | null }
export function validWorkerHeartbeat(value: unknown, now: number, revision: string | null): value is WorkerHeartbeat {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WorkerHeartbeat>;
  return record.schemaVersion === 1 && typeof record.timestamp === 'number'
    && record.timestamp <= now + 5000 && record.timestamp > now - ttlMs
    && Array.isArray(record.queues) && record.queues.every((queue) => typeof queue === 'string')
    && (!revision || record.revision === revision);
}
export async function workersReady(now = Date.now()): Promise<boolean> {
  const instances = await redis.zrangebyscore(heartbeatKey, now, '+inf', 'LIMIT', 0, 32);
  if (!instances.length) return false;
  const values = await redis.mget(instances.map((id) => `${heartbeatKey}:${id}`));
  const queues = new Set<string>();
  for (const value of values) {
    try {
      const record: unknown = JSON.parse(value ?? 'null');
      if (validWorkerHeartbeat(record, now, CONFIG.GIT_COMMIT ?? CONFIG.COMMIT_SHA ?? null)) record.queues.forEach((queue) => queues.add(queue));
    } catch { /* A malformed receipt never establishes liveness. */ }
  }
  return requiredWorkerQueues.every((name) => queues.has(name));
}
/** Heartbeats only advertise initialized, connected, running consumers. Each
 * process owns its own expiring receipt; one replica cannot erase another. */
export async function startWorkerHeartbeat(workers: Worker[]): Promise<() => Promise<void>> {
  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  const instanceId = randomUUID(); let stopped = false; let inFlight: Promise<void> | undefined;
  const revision = CONFIG.GIT_COMMIT ?? CONFIG.COMMIT_SHA ?? null;
  const publish = async () => {
    try {
      const queues: string[] = [];
      for (const worker of workers) if (worker.isRunning() && !worker.isPaused() && (await worker.client).status === 'ready') queues.push(worker.name);
      const timestamp = Date.now();
      const receipt: WorkerHeartbeat = { schemaVersion: 1, timestamp, queues, revision };
      const results = await redis.multi()
        .set(`${heartbeatKey}:${instanceId}`, JSON.stringify(receipt), 'PX', ttlMs)
        .zadd(heartbeatKey, timestamp + ttlMs, instanceId)
        .zremrangebyscore(heartbeatKey, '-inf', timestamp)
        .pexpire(heartbeatKey, ttlMs * 2).exec();
      if (!results || results.some(([error]) => error)) throw new Error('Worker heartbeat write failed');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Worker heartbeat unavailable');
    }
  };
  const write = () => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    inFlight = publish().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  await write();
  const timer = setInterval(() => { void write(); }, 5000); timer.unref();
  return async () => {
    stopped = true; clearInterval(timer);
    await inFlight;
    await redis.multi().zrem(heartbeatKey, instanceId).del(`${heartbeatKey}:${instanceId}`).exec();
  };
}
