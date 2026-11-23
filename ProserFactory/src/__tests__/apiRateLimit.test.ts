/// <reference types="jest" />
import { randomUUID } from 'node:crypto';
import express from 'express';
import Redis from 'ioredis';
import request from 'supertest';
import { apiRateLimitKey, apiRateLimitPerMinute, createApiRateLimit } from '../api/middleware/apiRateLimit';
import redis from '../lib/redis';

// Exercise the real Redis fixture rather than the suite-wide mock.
jest.unmock('../lib/redis');

const token = (claims: Record<string, unknown>) =>
  `Bearer ${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

function appWith(points: number, storeClient?: unknown) {
  const keyPrefix = `jest-api-limit-${randomUUID()}`;
  const app = express();
  app.use(createApiRateLimit({ points, keyPrefix, storeClient }));
  app.get('/probe', (req, res) => { res.json({ key: req.apiRateLimitKey }); });
  return { app, keyPrefix };
}

describe('global API rate limit', () => {
  const prefixes: string[] = [];
  afterAll(async () => {
    for (const prefix of prefixes) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
    }
    await redis.quit();
  });

  it('counts each caller separately and answers 429 with Retry-After past the limit', async () => {
    const { app, keyPrefix } = appWith(3);
    prefixes.push(keyPrefix);
    const alice = token({ sub: 'iam:alice', githubId: 'iam:alice' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await request(app).get('/probe').set('Authorization', alice)).status).toBe(200);
    }
    const limited = await request(app).get('/probe').set('Authorization', alice);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // A fresh token for the same identity, as Author signs per request, is the same caller.
    expect((await request(app).get('/probe').set('Authorization', token({ sub: 'iam:alice', githubId: 'iam:alice', iat: 1 }))).status).toBe(429);
    expect((await request(app).get('/probe').set('Authorization', token({ sub: 'iam:bob' }))).status).toBe(200);
    // The counters live in Redis, so every Factory process shares them.
    expect((await redis.keys(`${keyPrefix}*`)).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps limiting in process when Redis is unreachable', async () => {
    const unreachable = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    unreachable.on('error', () => undefined);
    try {
      const { app } = appWith(2, unreachable);
      const carol = token({ sub: 'iam:carol' });
      expect((await request(app).get('/probe').set('Authorization', carol)).status).toBe(200);
      expect((await request(app).get('/probe').set('Authorization', carol)).status).toBe(200);
      expect((await request(app).get('/probe').set('Authorization', carol)).status).toBe(429);
    } finally {
      unreachable.disconnect();
    }
  });

  it('is off in tests unless configured, so other suites are not throttled', async () => {
    const previous = process.env.API_RATE_LIMIT_PER_MINUTE;
    delete process.env.API_RATE_LIMIT_PER_MINUTE;
    const app = express();
    app.use(createApiRateLimit());
    app.get('/probe', (_req, res) => { res.sendStatus(204); });
    for (let attempt = 0; attempt < 15; attempt += 1) expect((await request(app).get('/probe')).status).toBe(204);
    if (previous !== undefined) process.env.API_RATE_LIMIT_PER_MINUTE = previous;
  });

  it('keys service principals by token, bearer tokens by claimed identity, and others by address', () => {
    const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {}, ip: '203.0.113.7', socket: {} }) as never;
    expect(apiRateLimitKey(req('Bearer pnv_secretvalue'))).toMatch(/^principal:[a-f0-9]{32}$/);
    expect(apiRateLimitKey(req('Bearer pnv_secretvalue'))).not.toContain('secretvalue');
    expect(apiRateLimitKey(req(token({ sub: 'service:hermes-agent:desade' })))).toBe('subject:service:hermes-agent:desade');
    expect(apiRateLimitKey(req(token({ sub: 42 })))).toBe('subject:42');
    expect(apiRateLimitKey(req(token({ sub: 'has spaces' })))).toBe('ip:203.0.113.7');
    expect(apiRateLimitKey(req('Bearer not-a-jwt'))).toBe('ip:203.0.113.7');
    expect(apiRateLimitKey(req())).toBe('ip:203.0.113.7');
  });

  it('uses a bounded default and ignores invalid overrides', () => {
    expect(apiRateLimitPerMinute({})).toBe(1200);
    expect(apiRateLimitPerMinute({ API_RATE_LIMIT_PER_MINUTE: '300' })).toBe(300);
    expect(apiRateLimitPerMinute({ API_RATE_LIMIT_PER_MINUTE: '5' })).toBe(1200);
    expect(apiRateLimitPerMinute({ API_RATE_LIMIT_PER_MINUTE: 'lots' })).toBe(1200);
  });
});
