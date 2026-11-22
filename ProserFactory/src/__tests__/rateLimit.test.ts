/// <reference types="jest" />
import { randomUUID } from 'node:crypto';

import { redisRateLimit, runRateLimitDiagnostic } from '../api/middleware/redisRateLimit';
import express from 'express';
import request from 'supertest';

describe('Redis Rate Limiter', () => {
  const prefix = `jest-rate-limit-${randomUUID()}`;

  it('enforces limit and returns 429 after threshold', async () => {
    const app = express();
    app.get('/test', redisRateLimit({ key: () => `${prefix}:threshold`, limit: 3, windowSec: 1 }), (_req, res) => res.json({ success: true }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app).get('/test');
      statuses.push(r.status);
    }
    const over = statuses.filter(s => s === 429).length;
    expect(over).toBeGreaterThanOrEqual(1);
  });

  it('sets Retry-After and error envelope on 429', async () => {
    const app = express();
    app.get('/test2', redisRateLimit({ key: () => `${prefix}:headers`, limit: 1, windowSec: 2 }), (_req, res) => res.json({ success: true }));
    await request(app).get('/test2'); // 1st allowed
    const r2 = await request(app).get('/test2'); // should be 429
    expect(r2.status).toBe(429);
    expect(r2.headers['retry-after']).toBeDefined();
    expect(r2.headers['x-ratelimit-limit']).toBe('1');
    expect(r2.headers['x-ratelimit-remaining']).toBe('0');
    expect(r2.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
  });

  it('provides a deterministic isolated deployment diagnostic', async () => {
    const result = await runRateLimitDiagnostic();
    expect(result).toMatchObject({
      limit: 3,
      attempts: 4,
      allowed: 3,
      rejected: 1,
      ordinaryNamespaceUntouched: true,
    });
    expect(result.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(result.resetAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
  });
});
