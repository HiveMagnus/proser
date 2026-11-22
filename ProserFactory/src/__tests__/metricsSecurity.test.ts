import request from 'supertest';

import app from '@/index';
import { validateProductionMetricsConfig } from '@/server';
import {
  METRICS_AUTH_FAILURE_LIMIT,
  metricsTokenMatches,
  resetMetricsAuthFailuresForTests,
} from '@/api/middleware/metricsAuth';

describe('metrics production security', () => {
  const originalToken = process.env.METRICS_TOKEN;

  afterEach(() => {
    resetMetricsAuthFailuresForTests();
    if (originalToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = originalToken;
  });

  it('compares metrics credentials without length-dependent equality', () => {
    expect(metricsTokenMatches('same-secret', 'same-secret')).toBe(true);
    expect(metricsTokenMatches('short', 'a-much-longer-secret')).toBe(false);
    expect(metricsTokenMatches('same-secreu', 'same-secret')).toBe(false);
  });

  it('fails production startup without a metrics credential', () => {
    expect(() => validateProductionMetricsConfig({
      NODE_ENV: 'production',
      METRICS_TOKEN: '',
    })).toThrow('METRICS_TOKEN is required');
    expect(() => validateProductionMetricsConfig({
      NODE_ENV: 'production',
      METRICS_TOKEN: 'dedicated-metrics-secret',
    })).not.toThrow();
  });

  it('authenticates metrics and returns only incremental snapshots', async () => {
    process.env.METRICS_TOKEN = 'test-metrics-secret';
    expect((await request(app).get('/api/metrics')).status).toBe(401);
    const response = await request(app)
      .get('/api/metrics')
      .set('x-metrics-token', 'test-metrics-secret');
    expect(response.status).toBe(200);
    expect(response.body.data.editorial).toMatchObject({
      counters: expect.any(Object),
      durations: expect.any(Object),
    });
    expect(response.body.data.editorial).not.toHaveProperty('durable');
  });

  it('rate limits repeated failed metrics authentication without echoing credentials', async () => {
    process.env.METRICS_TOKEN = 'test-metrics-secret';
    const supplied = 'never-log-or-return-this-token';
    expect((await request(app)
      .get('/api/metrics')
      .set('x-metrics-token', 'test-metrics-secret')).status).toBe(200);
    for (let attempt = 0; attempt < METRICS_AUTH_FAILURE_LIMIT; attempt += 1) {
      const response = await request(app)
        .get('/api/metrics')
        .set('x-metrics-token', supplied);
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain(supplied);
    }
    const limited = await request(app)
      .get('/api/metrics')
      .set('x-metrics-token', supplied);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(JSON.stringify(limited.body)).not.toContain(supplied);
  });
});
