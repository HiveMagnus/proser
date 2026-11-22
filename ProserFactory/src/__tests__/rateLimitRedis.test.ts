import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

import { CONSUME_RATE_LIMIT_SCRIPT } from '@/api/middleware/redisRateLimit';

describe('atomic Redis rate-limit consumption', () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('Explicit isolated REDIS_URL required for Redis rate-limit fixtures.');
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 5_000,
  });
  const diagnosticKey = `rl:diagnostic:test:${randomUUID()}`;
  const ordinaryKey = `rl:gen:test:${randomUUID()}`;

  afterAll(async () => {
    try { await client.del(diagnosticKey, ordinaryKey); }
    finally { client.disconnect(); }
  });

  it('returns exact counts without touching an ordinary namespace', async () => {
    const counts: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      counts.push(Number(await client.eval(CONSUME_RATE_LIMIT_SCRIPT, 1, diagnosticKey, 60)));
    }
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(await client.ttl(diagnosticKey)).toBeGreaterThan(0);
    expect(await client.get(ordinaryKey)).toBeNull();
  });
});
