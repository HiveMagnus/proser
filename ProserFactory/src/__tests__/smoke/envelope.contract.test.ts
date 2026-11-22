/// <reference types="jest" />
/**
 * Smoke / contract tests for the response envelope utilities.
 * These run WITHOUT a database connection and validate the core API
 * contract shapes that the UI client depends on.
 *
 * @tags smoke, contract
 */
import express from 'express';
import request from 'supertest';
import { respondSuccess, respondError, ErrorCodes } from '@/api/utils/response';

function createTestApp() {
  const app = express();
  app.use(express.json());

  app.get('/success', (_req, res) => {
    respondSuccess(res, { id: 1, name: 'Test Book' });
  });

  app.get('/success-201', (_req, res) => {
    respondSuccess(res, { id: 2 }, 201);
  });

  app.get('/error-400', (_req, res) => {
    respondError(res, ErrorCodes.VALIDATION_FAILED, 'Invalid input', 400, { field: 'name' });
  });

  app.get('/error-401', (_req, res) => {
    respondError(res, ErrorCodes.UNAUTHORIZED, 'Not authenticated', 401);
  });

  app.get('/error-429', (_req, res) => {
    respondError(res, ErrorCodes.RATE_LIMITED, 'Rate limit exceeded', 429);
  });

  app.get('/error-500', (_req, res) => {
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Something broke', 500);
  });

  return app;
}

describe('Response envelope contract', () => {
  const app = createTestApp();

  describe('Success envelope', () => {
    it('returns { success: true, data: T } with status 200', async () => {
      const res = await request(app).get('/success');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { id: 1, name: 'Test Book' },
      });
    });

    it('supports custom status codes', async () => {
      const res = await request(app).get('/success-201');
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });
  });

  describe('Error envelope', () => {
    it('returns { success: false, error: { code, message } }', async () => {
      const res = await request(app).get('/error-401');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        },
      });
    });

    it('includes details when provided', async () => {
      const res = await request(app).get('/error-400');
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual({ field: 'name' });
    });

    it('429 returns RATE_LIMITED code', async () => {
      const res = await request(app).get('/error-429');
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('500 returns INTERNAL_ERROR code', async () => {
      const res = await request(app).get('/error-500');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('ErrorCodes enum completeness', () => {
    it('contains all expected codes', () => {
      expect(ErrorCodes).toEqual({
        NOT_FOUND: 'NOT_FOUND',
        UNAUTHORIZED: 'UNAUTHORIZED',
        FORBIDDEN: 'FORBIDDEN',
        VALIDATION_FAILED: 'VALIDATION_FAILED',
        RATE_LIMITED: 'RATE_LIMITED',
        CAPACITY_UNAVAILABLE: 'CAPACITY_UNAVAILABLE',
        OPERATION_TIMEOUT: 'OPERATION_TIMEOUT',
        CONFLICT: 'CONFLICT',
        INTERNAL_ERROR: 'INTERNAL_ERROR',
        DB_ERROR: 'DB_ERROR',
        AI_SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
        EDITORIAL_BENCHMARK_INVALID: 'EDITORIAL_BENCHMARK_INVALID',
        EDITORIAL_BUDGET_EXCEEDED: 'EDITORIAL_BUDGET_EXCEEDED',
        EDITORIAL_PASS_NOT_FOUND: 'EDITORIAL_PASS_NOT_FOUND',
        EDITORIAL_PROFILE_INVALID: 'EDITORIAL_PROFILE_INVALID',
        EDITORIAL_PROPOSAL_NOT_APPLICABLE: 'EDITORIAL_PROPOSAL_NOT_APPLICABLE',
        EDITORIAL_PROPOSAL_STALE: 'EDITORIAL_PROPOSAL_STALE',
        EDITORIAL_SCOPE_INVALID: 'EDITORIAL_SCOPE_INVALID',
        EDITORIAL_SOURCE_STALE: 'EDITORIAL_SOURCE_STALE',
      });
    });
  });
});
