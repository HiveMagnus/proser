import type { NextFunction, Request, Response } from 'express';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import redis from '@/lib/redis';
import logger from '@/lib/logger';
import { ErrorCodes, respondError } from '@/api/utils/response';
import { verifiedBearerIdentity } from './auth';

const WINDOW_SECONDS = 60;
const DEFAULT_PER_MINUTE = 1200;
// Container health checks alone send about 12 requests a minute from loopback.
const MINIMUM_PER_MINUTE = 120;
const SUBJECT = /^[A-Za-z0-9:._@+-]{1,160}$/;

/** Requests per caller per minute across the whole API (default 1200, minimum 120). */
export function apiRateLimitPerMinute(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.API_RATE_LIMIT_PER_MINUTE);
  return Number.isInteger(configured) && configured >= MINIMUM_PER_MINUTE ? configured : DEFAULT_PER_MINUTE;
}

/**
 * The caller a request counts against. A bearer token whose signature and
 * claims verify counts against the identity it proves; Author signs a new
 * token for every request, so one writer's requests share a bucket. Anything
 * else (no token, a forged or expired token, or a service-principal token,
 * which is only checked later against the database) counts against the
 * client address, so a request claiming somebody else's identity cannot use
 * up that person's allowance.
 */
export function apiRateLimitKey(req: Request): string {
  const subject = verifiedBearerIdentity(req);
  if (subject && SUBJECT.test(subject)) return `subject:${subject}`;
  return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

/**
 * A backstop limit for every API route, in front of the tighter limits on
 * generation, imports and other expensive routes. Redis holds the counters so
 * the limit is shared by every Factory process; if Redis fails, an in-process
 * limiter takes over instead of letting requests through unlimited.
 */
export function createApiRateLimit(options: { points?: number; keyPrefix?: string; storeClient?: unknown } = {}) {
  const points = options.points ?? apiRateLimitPerMinute();
  const enabled = options.points !== undefined || process.env.NODE_ENV !== 'test' || Boolean(process.env.API_RATE_LIMIT_PER_MINUTE);
  const rateLimiter = new RateLimiterRedis({
    storeClient: options.storeClient ?? redis,
    keyPrefix: options.keyPrefix ?? 'proser-api-limit',
    points,
    duration: WINDOW_SECONDS,
    insuranceLimiter: new RateLimiterMemory({ points, duration: WINDOW_SECONDS }),
  });
  return async function apiRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!enabled) {
      next();
      return;
    }
    req.apiRateLimitKey = apiRateLimitKey(req);
    try {
      await rateLimiter.consume(req.apiRateLimitKey);
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))));
        respondError(res, ErrorCodes.RATE_LIMITED, 'Too many requests. Try again shortly.', 429);
        return;
      }
      // Both stores failed. Other route limits and authentication still apply.
      logger.warn({ err: (rejection as Error)?.message }, 'API rate limit unavailable; allowing request');
    }
    next();
  };
}
