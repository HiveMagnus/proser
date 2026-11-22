import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import redis from '../../lib/redis';
import logger from '../../lib/logger';
import { respondError, ErrorCodes } from '../utils/response';

interface Options { key: (req: Request) => string; limit: number; windowSec: number; }

export const CONSUME_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export interface RateLimitConsumption {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

function redisKey(keyBase: string, windowSec: number, now: number): string {
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec;
  return `rl:${keyBase}:${windowStart}`;
}

export async function consumeRedisRateLimit(
  keyBase: string,
  limit: number,
  windowSec: number,
  now = Date.now(),
): Promise<RateLimitConsumption> {
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec;
  const key = redisKey(keyBase, windowSec, now);
  const count = Number(await redis.eval(CONSUME_RATE_LIMIT_SCRIPT, 1, key, windowSec));
  const resetAt = windowStart + windowSec;
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfter: Math.max(1, resetAt - Math.floor(now / 1000)),
  };
}

export async function runRateLimitDiagnostic(): Promise<{
  limit: number;
  attempts: number;
  allowed: number;
  rejected: number;
  resetAt: number;
  ordinaryNamespaceUntouched: boolean;
}> {
  const probeId = randomUUID();
  const now = Date.now();
  const limit = 3;
  const attempts = limit + 1;
  const windowSec = 60;
  const diagnosticBase = `diagnostic:rate-limit:${probeId}`;
  const ordinaryCanaryBase = `gen:smoke-isolation-${probeId}:title`;
  const diagnosticKey = redisKey(diagnosticBase, windowSec, now);
  const ordinaryCanaryKey = redisKey(ordinaryCanaryBase, windowSec, now);
  const before = await redis.get(ordinaryCanaryKey);
  try {
    const results: RateLimitConsumption[] = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      results.push(await consumeRedisRateLimit(diagnosticBase, limit, windowSec, now));
    }
    const after = await redis.get(ordinaryCanaryKey);
    return {
      limit,
      attempts,
      allowed: results.filter((result) => result.allowed).length,
      rejected: results.filter((result) => !result.allowed).length,
      resetAt: results[0].resetAt,
      ordinaryNamespaceUntouched: before === after,
    };
  } finally {
    await redis.del(diagnosticKey);
  }
}

// Fixed-window counter. Key pattern: rl:{key}:{windowStart}
export function redisRateLimit(opts: Options) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const kBase = opts.key(req);
    const now = Date.now();
    try {
      const result = await consumeRedisRateLimit(kBase, opts.limit, opts.windowSec, now);
      if (!result.allowed) {
        res.setHeader('X-RateLimit-Limit', String(result.limit));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(result.resetAt));
        res.setHeader('Retry-After', String(result.retryAfter));
        respondError(res, ErrorCodes.RATE_LIMITED, 'Rate limit exceeded', 429);
        return;
      }
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(result.resetAt));
      next();
    } catch (e) {
      logger.warn({ err: (e as Error).message, keyBase: kBase }, 'Redis rate limit fallback (allowing request)');
      next(); // Fail-open
    }
  };
}
