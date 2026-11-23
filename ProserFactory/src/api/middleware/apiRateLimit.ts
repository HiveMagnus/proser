import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import redis from '@/lib/redis';
import logger from '@/lib/logger';
import { ErrorCodes, respondError } from '@/api/utils/response';

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

function claimedSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload || payload.length > 4096) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { githubId?: unknown; sub?: unknown };
    const subject = typeof claims.githubId === 'string' ? claims.githubId : typeof claims.sub === 'string' ? claims.sub : String(claims.sub ?? '');
    return SUBJECT.test(subject) ? subject : null;
  } catch {
    return null;
  }
}

/**
 * The caller a request counts against. Author signs a new token for every
 * request, so bearer tokens are grouped by the identity they claim. A forged
 * claim gains nothing: authentication still rejects the request, and the
 * signature check costs less than the work this limit protects.
 */
export function apiRateLimitKey(req: Request): string {
  const authorization = String(req.headers.authorization ?? '');
  if (authorization.startsWith('Bearer pnv_')) {
    return `principal:${createHash('sha256').update(authorization).digest('hex').slice(0, 32)}`;
  }
  if (authorization.startsWith('Bearer ')) {
    const subject = claimedSubject(authorization.slice('Bearer '.length));
    if (subject) return `subject:${subject}`;
  }
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
