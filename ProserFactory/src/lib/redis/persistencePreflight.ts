import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import IORedis from 'ioredis';

export type RedisPersistenceClient = Pick<IORedis, 'set' | 'get' | 'del' | 'bgsave' | 'info'>;

export interface RedisPersistencePreflightOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

type PersistenceInfo = {
  bgsaveInProgress: boolean;
  lastBgsaveStatus: string;
  consecutiveFailures: number;
};

function parsePersistenceInfo(raw: string): PersistenceInfo {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return {
    bgsaveInProgress: values.get('rdb_bgsave_in_progress') === '1',
    lastBgsaveStatus: values.get('rdb_last_bgsave_status') ?? 'unknown',
    consecutiveFailures: Number(values.get('rdb_saves_consecutive_failures') ?? '0'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function assertRedisPersistence(
  client: RedisPersistenceClient,
  { timeoutMs = 60_000, pollIntervalMs = 100 }: RedisPersistencePreflightOptions = {},
): Promise<void> {
  const key = `proser:persistence-preflight:${randomBytes(12).toString('hex')}`;
  try {
    try {
      const stored = await client.set(key, 'before-snapshot', 'EX', 60);
      if (stored !== 'OK' || await client.get(key) !== 'before-snapshot') {
        throw new Error('write/read verification did not round-trip');
      }
    } catch (error) {
      throw new Error(`Redis writability probe failed: ${errorMessage(error)}`);
    }

    try {
      await client.bgsave();
    } catch (error) {
      if (!/background save already in progress/iu.test(errorMessage(error))) {
        throw new Error(`Redis snapshot trigger failed: ${errorMessage(error)}`);
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const persistence = parsePersistenceInfo(await client.info('persistence'));
      if (!persistence.bgsaveInProgress) {
        if (persistence.lastBgsaveStatus === 'ok' && persistence.consecutiveFailures === 0) break;
        if (persistence.lastBgsaveStatus === 'err' || persistence.consecutiveFailures > 0) {
          throw new Error('Redis snapshot failed; writes would eventually fail closed with MISCONF');
        }
      }
      if (Date.now() >= deadline) throw new Error('Redis snapshot verification timed out');
      await delay(pollIntervalMs);
    }

    try {
      const stored = await client.set(key, 'after-snapshot', 'EX', 60);
      if (stored !== 'OK' || await client.get(key) !== 'after-snapshot') {
        throw new Error('post-snapshot write/read verification did not round-trip');
      }
    } catch (error) {
      throw new Error(`Redis post-snapshot writability probe failed: ${errorMessage(error)}`);
    }
  } finally {
    try {
      await client.del(key);
    } catch {
      // The probe key expires after 60 seconds if a broken Redis refuses cleanup.
    }
  }
}

async function main(): Promise<void> {
  const client = process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    : new IORedis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || '6379'),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  client.on('error', () => undefined);
  try {
    await assertRedisPersistence(client);
    process.stdout.write('Redis write and snapshot persistence preflight passed.\n');
  } finally {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Redis persistence preflight failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
