import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import {
  EXPENSIVE_ROUTE_LIMITS,
  type ExpensiveRouteLimitName,
} from '@/api/contracts/routeLimits';
import { ErrorCodes, respondError } from '@/api/utils/response';
import logger from '@/lib/logger';
import redis from '@/lib/redis';

export const ACQUIRE_CAPACITY_LEASE_SCRIPT = `
local daily_user = tonumber(redis.call('GET', KEYS[1]) or '0')
local daily_book = tonumber(redis.call('GET', KEYS[2]) or '0')
local now = tonumber(ARGV[7])
local lease_expires = tonumber(ARGV[8])
for index = 3, 4 do
  local key_type = redis.call('TYPE', KEYS[index]).ok
  if key_type ~= 'none' and key_type ~= 'zset' then redis.call('DEL', KEYS[index]) end
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local active_user = redis.call('ZCARD', KEYS[3])
local active_book = redis.call('ZCARD', KEYS[4])
if tonumber(ARGV[1]) > 0 and daily_user >= tonumber(ARGV[1]) then return -1 end
if tonumber(ARGV[2]) > 0 and daily_book >= tonumber(ARGV[2]) then return -2 end
if tonumber(ARGV[3]) > 0 and active_user >= tonumber(ARGV[3]) then return -3 end
if tonumber(ARGV[4]) > 0 and active_book >= tonumber(ARGV[4]) then return -4 end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[5])
if tonumber(ARGV[2]) > 0 then redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], ARGV[5]) end
redis.call('ZADD', KEYS[3], lease_expires, ARGV[9]); redis.call('EXPIRE', KEYS[3], ARGV[6])
if tonumber(ARGV[4]) > 0 then redis.call('ZADD', KEYS[4], lease_expires, ARGV[9]); redis.call('EXPIRE', KEYS[4], ARGV[6]) end
return 1
`;

export const RELEASE_CAPACITY_LEASE_SCRIPT = `
for index = 1, #KEYS do
  redis.call('ZREM', KEYS[index], ARGV[1])
end
return 1
`;

export const RENEW_CAPACITY_LEASE_SCRIPT = `
local now = tonumber(ARGV[2])
for index = 1, #KEYS do
  local score = redis.call('ZSCORE', KEYS[index], ARGV[1])
  if not score or tonumber(score) <= now then
    for stale_index = 1, #KEYS do
      redis.call('ZREM', KEYS[stale_index], ARGV[1])
    end
    return 0
  end
end
for index = 1, #KEYS do
  redis.call('ZADD', KEYS[index], 'XX', ARGV[3], ARGV[1])
  redis.call('EXPIRE', KEYS[index], ARGV[4])
end
return 1
`;

export const ACTIVE_LEASE_MS = 30_000;
export const CAPACITY_CANCELLATION_GRACE_MS = 1_000;

export function requestPayloadBytes(req: Request): number {
  if (req.body === undefined || req.body === null) return 0;
  return Buffer.byteLength(JSON.stringify(req.body));
}

const payloadRoutes = Object.values(EXPENSIVE_ROUTE_LIMITS).map((contract) => ({
  ...contract,
  pattern: new RegExp(`^${contract.path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]+\\\}/g, '[^/]+')}$`),
}));

export function expensivePayloadGuard(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  const contract = payloadRoutes.find((candidate) =>
    candidate.method === req.method && candidate.pattern.test(path));
  if (!contract) {
    next();
    return;
  }
  const advertised = Number(req.header('content-length') ?? 0);
  if (Number.isFinite(advertised) && advertised > contract.maxPayloadBytes) {
    respondError(res, ErrorCodes.VALIDATION_FAILED, 'Request payload exceeds route limit', 413);
    return;
  }
  next();
}

export function expensiveRouteLimit(name: ExpensiveRouteLimitName) {
  const contract = EXPENSIVE_ROUTE_LIMITS[name];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const payloadBytes = requestPayloadBytes(req);
    if (payloadBytes > contract.maxPayloadBytes) {
      respondError(res, ErrorCodes.VALIDATION_FAILED, 'Request payload exceeds route limit', 413);
      return;
    }
    const userId = req.user?.id;
    if (!userId) {
      respondError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }
    if (
      process.env.NODE_ENV === 'test'
      && process.env.TEST_SHARED_CAPACITY_LIMITS !== '1'
    ) {
      next();
      return;
    }
    const bookId = req.authorizedBookId ? String(req.authorizedBookId) : undefined;
    const day = new Date().toISOString().slice(0, 10);
    const suffix = randomUUID();
    const leaseId = randomUUID();
    req.operationLeaseId = leaseId;
    const dailyUserKey = `budget:${contract.key}:daily:user:${userId}:${day}`;
    const dailyBookKey = bookId
      ? `budget:${contract.key}:daily:book:${bookId}:${day}`
      : `budget:${contract.key}:daily:book:none:${suffix}`;
    const activeUserKey = `budget:${contract.key}:active:user:${userId}`;
    const activeBookKey = bookId
      ? `budget:${contract.key}:active:book:${bookId}`
      : `budget:${contract.key}:active:book:none:${suffix}`;
    const dailyTtlSeconds = 172_800;
    const activeTtlSeconds = Math.ceil(ACTIVE_LEASE_MS / 1000) + 60;
    const now = Date.now();
    let acquired: number;
    try {
      acquired = Number(await redis.eval(
        ACQUIRE_CAPACITY_LEASE_SCRIPT,
        4,
        dailyUserKey,
        dailyBookKey,
        activeUserKey,
        activeBookKey,
        contract.dailyPerUser,
        bookId ? contract.dailyPerBook : 0,
        contract.userConcurrency,
        bookId ? contract.bookConcurrency : 0,
        dailyTtlSeconds,
        activeTtlSeconds,
        now,
        now + ACTIVE_LEASE_MS,
        leaseId,
      ));
    } catch (error) {
      logger.error({ error: (error as Error).message, routeLimit: name }, 'Capacity budget unavailable');
      respondError(res, ErrorCodes.CAPACITY_UNAVAILABLE, 'Capacity controls unavailable', 503);
      return;
    }
    if (acquired !== 1) {
      const dailyExceeded = acquired === -1 || acquired === -2;
      respondError(
        res,
        ErrorCodes.RATE_LIMITED,
        dailyExceeded ? 'Daily operation budget exceeded' : 'Operation concurrency limit reached',
        429,
      );
      return;
    }

    const abortController = new AbortController();
    req.operationSignal = abortController.signal;
    let released = false;
    let leaseRenewable = true;
    let cancellationGrace: NodeJS.Timeout | undefined;
    const activeKeys = bookId ? [activeUserKey, activeBookKey] : [activeUserKey];
    const release = async () => {
      if (released) return;
      released = true;
      await redis.eval(RELEASE_CAPACITY_LEASE_SCRIPT, activeKeys.length, ...activeKeys, leaseId).catch((error: Error) => {
        logger.error({ error: error.message, routeLimit: name }, 'Failed to release capacity budget');
      });
    };
    const renew = setInterval(() => {
      if (!leaseRenewable) return;
      const renewalNow = Date.now();
      const expiresAt = renewalNow + ACTIVE_LEASE_MS;
      void redis.eval(
        RENEW_CAPACITY_LEASE_SCRIPT,
        activeKeys.length,
        ...activeKeys,
        leaseId,
        renewalNow,
        expiresAt,
        activeTtlSeconds,
      ).then((renewed) => {
        if (leaseRenewable && Number(renewed) !== 1) {
          leaseRenewable = false;
          clearInterval(renew);
          abortController.abort(new Error('Operation capacity lease was lost'));
          void release();
          if (!res.headersSent) {
            respondError(res, ErrorCodes.CAPACITY_UNAVAILABLE, 'Operation capacity lease was lost', 503);
          }
        }
      }).catch((error: Error) => {
        if (!leaseRenewable) return;
        leaseRenewable = false;
        clearInterval(renew);
        logger.error({ error: error.message, routeLimit: name }, 'Failed to renew capacity lease');
        abortController.abort(new Error('Operation capacity lease renewal failed'));
        void release();
        if (!res.headersSent) {
          respondError(res, ErrorCodes.CAPACITY_UNAVAILABLE, 'Capacity controls unavailable', 503);
        }
      });
    }, Math.floor(ACTIVE_LEASE_MS / 3));
    renew.unref();
    const timer = setTimeout(() => {
      leaseRenewable = false;
      clearInterval(renew);
      const timeoutKind = contract.lifecycle === 'acceptance' ? 'acceptance-time' : 'execution-time';
      abortController.abort(new Error(`Operation ${timeoutKind} limit exceeded`));
      void release();
      if (!res.headersSent) {
        respondError(res, ErrorCodes.OPERATION_TIMEOUT, `Operation ${timeoutKind} limit exceeded`, 504);
      } else if (!res.writableEnded) {
        cancellationGrace = setTimeout(() => {
          if (!res.writableEnded) res.destroy(new Error(`Operation ${timeoutKind} cancellation grace exceeded`));
        }, CAPACITY_CANCELLATION_GRACE_MS);
        cancellationGrace.unref();
      }
    }, contract.timeoutMs);
    timer.unref();
    res.once('finish', () => {
      clearTimeout(timer);
      clearInterval(renew);
      if (cancellationGrace) clearTimeout(cancellationGrace);
      void release();
    });
    res.once('close', () => {
      clearTimeout(timer);
      clearInterval(renew);
      if (cancellationGrace) clearTimeout(cancellationGrace);
      void release();
    });
    next();
  };
}
