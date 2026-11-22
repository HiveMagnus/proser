import express from 'express';
import request from 'supertest';

import { EXPENSIVE_ROUTE_LIMITS } from '@/api/contracts/routeLimits';
import {
  ACTIVE_LEASE_MS,
  CAPACITY_CANCELLATION_GRACE_MS,
  expensivePayloadGuard,
  expensiveRouteLimit,
} from '@/api/middleware/expensiveRouteLimit';
import { ownedBookBudget } from '@/api/middleware/ownedBookBudget';
import { databaseService } from '@/lib/database';
import redis from '@/lib/redis';

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { eval: jest.fn() },
}));
jest.mock('@/lib/database', () => ({
  databaseService: {
    client: { book: { findFirst: jest.fn() } },
  },
}));

const redisEval = redis.eval as jest.MockedFunction<typeof redis.eval>;
const findBook = databaseService.client.book.findFirst as jest.Mock;

function app(options: { authorize?: boolean; handler?: express.RequestHandler } = {}) {
  const instance = express();
  instance.use(expensivePayloadGuard);
  instance.use(express.json({ limit: '1mb' }));
  instance.use((req, _res, next) => {
    req.user = { id: 7, githubId: '7', username: 'test' };
    if (!options.authorize) req.authorizedBookId = 12;
    next();
  });
  instance.post(
    '/books/:bookId/reset',
    ...(options.authorize ? [ownedBookBudget({ source: 'params', required: true })] : []),
    expensiveRouteLimit('bookReset'),
    options.handler ?? ((_req, res) => res.json({ success: true })),
  );
  return instance;
}

describe('expensive route capacity budgets', () => {
  beforeAll(() => {
    process.env.TEST_SHARED_CAPACITY_LIMITS = '1';
  });
  afterAll(() => {
    delete process.env.TEST_SHARED_CAPACITY_LIMITS;
  });
  beforeEach(() => {
    redisEval.mockReset();
    findBook.mockReset();
  });

  it('publishes user, book, daily, payload, and execution ceilings', () => {
    for (const contract of Object.values(EXPENSIVE_ROUTE_LIMITS)) {
      expect(contract.userConcurrency).toBeGreaterThan(0);
      expect(contract.dailyPerUser).toBeGreaterThan(0);
      expect(contract.maxPayloadBytes).toBeGreaterThanOrEqual(0);
      expect(contract.timeoutMs).toBeGreaterThan(0);
      expect(['synchronous', 'acceptance']).toContain(contract.lifecycle);
      if (contract.path.includes('{bookId}')) {
        expect(contract.bookConcurrency).toBeGreaterThan(0);
        expect(contract.dailyPerBook).toBeGreaterThan(0);
      }
    }
  });

  it('rejects an oversized route payload before allocating capacity', async () => {
    const response = await request(app())
      .post('/books/12/reset')
      .send({ padding: 'x'.repeat(2_000) });
    expect(response.status).toBe(413);
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('fails closed when the shared capacity budget is unavailable', async () => {
    redisEval.mockRejectedValueOnce(new Error('redis unavailable'));
    const response = await request(app()).post('/books/12/reset').send({});
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CAPACITY_UNAVAILABLE');
  });

  it('rejects exhausted daily and concurrency budgets', async () => {
    redisEval.mockResolvedValueOnce(-1);
    const daily = await request(app()).post('/books/12/reset').send({});
    expect(daily.status).toBe(429);
    expect(daily.body.error.message).toContain('Daily');

    redisEval.mockResolvedValueOnce(-4);
    const concurrent = await request(app()).post('/books/12/reset').send({});
    expect(concurrent.status).toBe(429);
    expect(concurrent.body.error.message).toContain('concurrency');
  });

  it('does not allocate any user or book budget for an unowned book', async () => {
    findBook.mockResolvedValueOnce(null);
    const response = await request(app({ authorize: true })).post('/books/91/reset').send({});
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Book not found');
    expect(findBook).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 91, userId: 7, deletedAt: null },
    }));
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('acquires and releases only an operation-owned sorted-set lease', async () => {
    redisEval.mockResolvedValue(1);
    const response = await request(app()).post('/books/12/reset').send({});
    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));

    const acquire = redisEval.mock.calls[0];
    const release = redisEval.mock.calls.at(-1)!;
    expect(acquire[0]).toContain('ZREMRANGEBYSCORE');
    expect(acquire[0]).toContain('ZADD');
    expect(acquire[0]).toContain("redis.call('TYPE'");
    expect(acquire[0]).not.toContain("redis.call('INCR', KEYS[3])");
    expect(Number(acquire[13]) - Number(acquire[12])).toBe(ACTIVE_LEASE_MS);
    const leaseId = acquire.at(-1);
    expect(leaseId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(release[0]).toContain('ZREM');
    expect(release[0]).not.toContain('DECR');
    expect(release.at(-1)).toBe(leaseId);
  });

  it('aborts a synchronous handler and returns 504 at its authoritative deadline', async () => {
    redisEval.mockResolvedValue(1);
    const contract = EXPENSIVE_ROUTE_LIMITS.bookReset as { timeoutMs: number };
    const originalTimeout = contract.timeoutMs;
    contract.timeoutMs = 20;
    let observedAbort = false;
    try {
      const response = await request(app({
        handler: (req) => {
          req.operationSignal?.addEventListener('abort', () => {
            observedAbort = true;
          });
        },
      })).post('/books/12/reset').send({});
      expect(response.status).toBe(504);
      expect(response.body.error.code).toBe('OPERATION_TIMEOUT');
      expect(observedAbort).toBe(true);
    } finally {
      contract.timeoutMs = originalTimeout;
    }
  });

  it('stops renewing and releases capacity at timeout even when headers were already sent', async () => {
    redisEval.mockResolvedValue(1);
    const contract = EXPENSIVE_ROUTE_LIMITS.bookReset as { timeoutMs: number };
    const originalTimeout = contract.timeoutMs;
    contract.timeoutMs = 20;
    try {
      const response = request(app({
        handler: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('started');
          req.operationSignal?.addEventListener('abort', () => {
            // Deliberately ignore cancellation to exercise grace cleanup.
          });
        },
      })).post('/books/12/reset').send({});
      await expect(response).rejects.toThrow();
      expect(redisEval.mock.calls.some((call) => String(call[0]).includes('ZREM'))).toBe(true);
      expect(CAPACITY_CANCELLATION_GRACE_MS).toBeLessThan(ACTIVE_LEASE_MS);
    } finally {
      contract.timeoutMs = originalTimeout;
    }
  });
});
