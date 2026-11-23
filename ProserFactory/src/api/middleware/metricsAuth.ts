import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import redis from '@/lib/redis';
import {
  METRICS_AUTH_FAILURE_LIMIT,
  METRICS_AUTH_FAILURE_WINDOW_SEC,
} from '../contracts/routeLimits';
import { ErrorCodes, respondError } from '../utils/response';

export {
  METRICS_AUTH_FAILURE_LIMIT,
  METRICS_AUTH_FAILURE_WINDOW_SEC,
} from '../contracts/routeLimits';

const localFailures = new Map<string, { count: number; expiresAt: number }>();

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function metricsTokenMatches(supplied: string, expected: string): boolean {
  return timingSafeEqual(digest(supplied), digest(expected));
}

function clientKey(req: Request): string {
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  return digest(address).toString('hex').slice(0, 24);
}

async function recordFailure(key: string): Promise<number> {
  const redisKey = `rl:metrics-auth-failure:${key}`;
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, METRICS_AUTH_FAILURE_WINDOW_SEC);
    return count;
  } catch {
    const now = Date.now();
    const current = localFailures.get(key);
    const next = !current || current.expiresAt <= now
      ? { count: 1, expiresAt: now + METRICS_AUTH_FAILURE_WINDOW_SEC * 1000 }
      : { ...current, count: current.count + 1 };
    localFailures.set(key, next);
    return next.count;
  }
}

async function clearFailures(key: string): Promise<void> {
  localFailures.delete(key);
  try {
    await redis.del(`rl:metrics-auth-failure:${key}`);
  } catch {
    // Authentication remains available when the optional shared limiter is down.
  }
}

export function resetMetricsAuthFailuresForTests(): void {
  localFailures.clear();
}

export async function requireMetricsToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const expected = process.env.METRICS_TOKEN?.trim();
  const suppliedHeader = req.headers['x-metrics-token'];
  const supplied = typeof suppliedHeader === 'string' ? suppliedHeader : '';

  // Only an explicit development or test process may scrape without a token.
  if (!expected && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) {
    next();
    return;
  }

  if (expected && metricsTokenMatches(supplied, expected)) {
    await clearFailures(clientKey(req));
    next();
    return;
  }

  const failures = await recordFailure(clientKey(req));
  if (failures > METRICS_AUTH_FAILURE_LIMIT) {
    res.setHeader('Retry-After', String(METRICS_AUTH_FAILURE_WINDOW_SEC));
    respondError(res, ErrorCodes.RATE_LIMITED, 'Metrics authentication rate limit exceeded', 429);
    return;
  }
  respondError(res, ErrorCodes.UNAUTHORIZED, 'Invalid metrics token', 401);
}
