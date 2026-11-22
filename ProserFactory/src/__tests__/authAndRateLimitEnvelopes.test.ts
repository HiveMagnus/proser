/// <reference types="jest" />
import express from 'express';
import request from 'supertest';
import app from '../index';
import { requireAdmin } from '../api/middleware/auth';
import { respondError, ErrorCodes } from '../api/utils/response';

describe('Standardized error envelopes for auth and rate limiting', () => {
  it('401: unauthenticated access returns { success:false, error:{ code:"UNAUTHORIZED", message } }', async () => {
    const res = await request(app).get('/api/books'); // requires auth
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('403: forbidden access returns { success:false, error:{ code:"FORBIDDEN", message } }', async () => {
    const local = express();
    // inject a user but do not grant admin rights; requireAdmin currently checks a false flag
    local.get('/admin', (req, _res, next) => { (req as any).user = { id: 1, githubId: 'jest-gh' }; next(); }, requireAdmin, (_req, res) => res.json({ success: true }));
    const res = await request(local).get('/admin');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('429: rate limited access returns { success:false, error:{ code:"RATE_LIMITED", message } }', async () => {
    const local = express();
    // Directly produce a 429 to verify envelope shape (rate limiter implementation tested elsewhere)
    local.get('/limited', (_req, res) => { respondError(res, ErrorCodes.RATE_LIMITED, 'Rate limit exceeded', 429); });
    const res = await request(local).get('/limited');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(typeof res.body.error.message).toBe('string');
  });
});
