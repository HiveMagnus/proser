import { QueueOptions, WorkerOptions, QueueEventsOptions } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import { CONFIG } from '../core/config';
import logger from '../lib/logger';

export type BullConnections = {
  client: IORedis;
  subscriber: IORedis;
};

let cached: BullConnections | null = null;

function buildRedisOptions(forWorker = false): RedisOptions {
  return {
    host: CONFIG.REDIS_HOST || process.env.REDIS_HOST || 'localhost',
    port: parseInt(CONFIG.REDIS_PORT || process.env.REDIS_PORT || '6379'),
    // BullMQ workers use blocking commands (BRPOPLPUSH) that require
    // maxRetriesPerRequest: null. Queues can use a finite retry count.
    maxRetriesPerRequest: forWorker ? null : 1,
    lazyConnect: false,
    showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
    connectTimeout: 5000,
    enableReadyCheck: false,
  };
}

export function getBullConnections(): BullConnections {
  if (cached) return cached;
  try {
    const opts = buildRedisOptions();
    const client = CONFIG.REDIS_URL ? new IORedis(CONFIG.REDIS_URL) : new IORedis(opts);
    const subscriber = CONFIG.REDIS_URL ? new IORedis(CONFIG.REDIS_URL) : new IORedis(opts);
    client.on('error', (err) => logger.error({ err: err.message }, 'BullMQ Redis client error'));
    subscriber.on('error', (err) => logger.error({ err: err.message }, 'BullMQ Redis subscriber error'));
    cached = { client, subscriber };
    return cached;
  } catch (err) {
    logger.error({ err }, 'Failed to create BullMQ connections');
    throw err;
  }
}

export function buildQueueBaseOptions(): Pick<QueueOptions, 'connection' | 'prefix'> {
  const { client } = getBullConnections();
  return { connection: client, prefix: CONFIG.BULLMQ_PREFIX || 'proser' };
}

export function buildQueueEventsOptions(): QueueEventsOptions { const { client } = getBullConnections(); return { connection: client, prefix: CONFIG.BULLMQ_PREFIX || 'proser' }; }
export function buildQueueSchedulerOptions(): QueueEventsOptions { const { client } = getBullConnections(); return { connection: client, prefix: CONFIG.BULLMQ_PREFIX || 'proser' }; }

export function buildWorkerOptions(concurrencyOverride?: number): WorkerOptions {
  // Workers MUST have their own connection with maxRetriesPerRequest: null
  // for BullMQ blocking operations. Do NOT share with the queue client.
  const workerOpts = buildRedisOptions(true);
  const workerConnection = CONFIG.REDIS_URL
    ? new IORedis(CONFIG.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : new IORedis(workerOpts);
  workerConnection.on('error', (err) => logger.error({ err: err.message }, 'BullMQ Worker Redis error'));
  const conc = concurrencyOverride ?? parseInt(CONFIG.WIZARD_QUEUE_CONCURRENCY || process.env.WIZARD_QUEUE_CONCURRENCY || '1');
  return {
    connection: workerConnection,
    prefix: CONFIG.BULLMQ_PREFIX || 'proser',
    autorun: true,
    useWorkerThreads: false,
    concurrency: Math.max(1, conc),
    // Deploys and host restarts can orphan an active long-running inference job.
    // Give BullMQ enough bounded stall recoveries for the durable workflow layer
    // to reconcile it instead of permanently failing an otherwise healthy run.
    maxStalledCount: 10,
    stalledInterval: 15_000,
  };
}

/** Cleanly close BullMQ Redis connections (client and subscriber). */
export async function shutdownBullConnections(): Promise<void> {
  if (!cached) return;
  const { client, subscriber } = cached;
  try { if (subscriber) { try { await subscriber.quit(); } catch { subscriber.disconnect(); } } } catch {}
  try { if (client) { try { await client.quit(); } catch { client.disconnect(); } } } catch {}
  cached = null;
}
