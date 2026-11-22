import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

import {
  ACQUIRE_CAPACITY_LEASE_SCRIPT,
  RELEASE_CAPACITY_LEASE_SCRIPT,
  RENEW_CAPACITY_LEASE_SCRIPT,
} from '@/api/middleware/expensiveRouteLimit';

describe('operation-owned capacity leases in Redis', () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('Explicit isolated REDIS_URL required for Redis lease fixtures.');
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 5_000,
  });
  const prefix = `test:capacity-lease:${randomUUID()}`;
  const keys = {
    dailyUser: `${prefix}:daily:user`,
    dailyBook: `${prefix}:daily:book`,
    activeUser: `${prefix}:active:user`,
    activeBook: `${prefix}:active:book`,
  };

  afterAll(async () => {
    try { await client.del(...Object.values(keys)); }
    finally { client.disconnect(); }
  });

  const acquire = (leaseId: string, now: number) => client.eval(
    ACQUIRE_CAPACITY_LEASE_SCRIPT,
    4,
    keys.dailyUser,
    keys.dailyBook,
    keys.activeUser,
    keys.activeBook,
    10,
    10,
    1,
    1,
    60,
    90,
    now,
    now + 30_000,
    leaseId,
  );

  it('keeps a newer lease intact when an expired operation releases late', async () => {
    const firstLease = randomUUID();
    const secondLease = randomUUID();
    const now = Date.now();
    expect(Number(await acquire(firstLease, now))).toBe(1);

    // Simulate abandonment past the lease timestamp, then admit a successor.
    await Promise.all([
      client.zadd(keys.activeUser, now - 1, firstLease),
      client.zadd(keys.activeBook, now - 1, firstLease),
    ]);
    expect(Number(await acquire(secondLease, now))).toBe(1);

    await client.eval(
      RELEASE_CAPACITY_LEASE_SCRIPT,
      2,
      keys.activeUser,
      keys.activeBook,
      firstLease,
    );
    expect(await client.zscore(keys.activeUser, secondLease)).not.toBeNull();
    expect(await client.zscore(keys.activeBook, secondLease)).not.toBeNull();
    expect(await client.zcard(keys.activeUser)).toBe(1);

    expect(Number(await client.eval(
      RENEW_CAPACITY_LEASE_SCRIPT,
      2,
      keys.activeUser,
      keys.activeBook,
      firstLease,
      now,
      now + 60_000,
      90,
    ))).toBe(0);
    expect(Number(await client.eval(
      RENEW_CAPACITY_LEASE_SCRIPT,
      2,
      keys.activeUser,
      keys.activeBook,
      secondLease,
      now,
      now + 60_000,
      90,
    ))).toBe(1);
  });

  it('cannot renew itself after expiration without a competing admission', async () => {
    await client.del(...Object.values(keys));
    const leaseId = randomUUID();
    const admittedAt = Date.now();
    expect(Number(await acquire(leaseId, admittedAt))).toBe(1);

    const afterExpiration = admittedAt + 30_001;
    expect(Number(await client.eval(
      RENEW_CAPACITY_LEASE_SCRIPT,
      2,
      keys.activeUser,
      keys.activeBook,
      leaseId,
      afterExpiration,
      afterExpiration + 30_000,
      90,
    ))).toBe(0);
    expect(await client.zscore(keys.activeUser, leaseId)).toBeNull();
    expect(await client.zscore(keys.activeBook, leaseId)).toBeNull();
  });

  it('replaces restart-orphaned integer counters with lease sets', async () => {
    await client.del(...Object.values(keys));
    await client.mset(keys.activeUser, '1', keys.activeBook, '1');
    expect(Number(await acquire(randomUUID(), Date.now()))).toBe(1);
    expect(await client.type(keys.activeUser)).toBe('zset');
    expect(await client.type(keys.activeBook)).toBe('zset');
  });
});
