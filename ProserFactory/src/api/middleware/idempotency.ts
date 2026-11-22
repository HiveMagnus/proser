/**
 * Idempotency middleware — prevents duplicate work on POST generation endpoints.
 *
 * Clients send an `Idempotency-Key` header. The middleware:
 *   1. Checks Redis for a cached response under that key.
 *   2. If found, replays the cached response immediately (no controller runs).
 *   3. If not found, sets a "processing" lock and lets the request through.
 *   4. After the response is sent, caches the response body + status for the TTL.
 *
 * Keys are scoped per user: `idem:{userId}:{key}` to prevent cross-user collisions.
 *
 * Design choices:
 *   - Redis-only (no Prisma migration needed, natural TTL expiry).
 *   - Racing requests for the same key get a 409 Conflict while processing is in progress.
 *   - TTL defaults to 1 hour — long enough for UI retries, short enough to not leak memory.
 */

import { Request, Response, NextFunction } from 'express';
import redis from '@/lib/redis';
import logger from '@/lib/logger';
import { respondError, ErrorCodes } from '@/api/utils/response';

export interface IdempotencyOptions {
  /** TTL in seconds for cached responses. Default: 3600 (1 hour). */
  ttlSec?: number;
  /** Header name. Default: 'idempotency-key'. */
  headerName?: string;
  /** If true, the header is required on the endpoint. Default: false (optional). */
  required?: boolean;
}

const DEFAULT_TTL = 3600;
const DEFAULT_HEADER = 'idempotency-key';
const LOCK_VALUE = '__processing__';
const LOCK_TTL = 120; // 2 min lock for in-flight requests

function redisKey(userId: number | string, key: string): string {
  return `idem:${userId}:${key}`;
}

interface CachedResponse {
  status: number;
  body: unknown;
}

/**
 * Express middleware factory for idempotency.
 *
 * Usage:
 *   router.post('/resource', idempotent({ required: false }), controller.create);
 */
export function idempotent(opts: IdempotencyOptions = {}) {
  const headerName = opts.headerName ?? DEFAULT_HEADER;
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL;
  const required = opts.required ?? false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers[headerName] as string | undefined;

    // No key → skip idempotency (unless required)
    if (!idempotencyKey) {
      if (required) {
        respondError(res, ErrorCodes.VALIDATION_FAILED, `Missing ${headerName} header`, 400);
        return;
      }
      next();
      return;
    }

    const userId = req.user?.id ?? 'anon';
    const rk = redisKey(userId, idempotencyKey);

    try {
      // Check for existing cached response or in-flight lock
      const existing = await redis.get(rk);

      if (existing) {
        if (existing === LOCK_VALUE) {
          // Another request with the same key is still processing
          respondError(res, ErrorCodes.CONFLICT, 'A request with this idempotency key is already being processed', 409);
          return;
        }

        // We have a cached response — replay it
        try {
          const cached: CachedResponse = JSON.parse(existing);
          logger.debug({ idempotencyKey, userId }, 'Idempotency: replaying cached response');
          res.status(cached.status).json(cached.body);
          return;
        } catch {
          // Corrupted cache entry — delete and proceed
          await redis.del(rk);
        }
      }

      // Set processing lock with short TTL (so it doesn't persist on crash)
      await redis.set(rk, LOCK_VALUE, 'EX', LOCK_TTL, 'NX');

      // Intercept the response to cache it
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown) {
        // Cache the response asynchronously (don't block the client)
        const toCache: CachedResponse = { status: res.statusCode, body };
        redis.set(rk, JSON.stringify(toCache), 'EX', ttlSec).catch((err) => {
          logger.warn({ err, idempotencyKey }, 'Idempotency: failed to cache response');
        });
        return originalJson(body);
      };

      next();
    } catch (err) {
      // Redis error — fail open (let the request through without idempotency)
      logger.warn({ err, idempotencyKey }, 'Idempotency: Redis error, failing open');
      next();
    }
  };
}
