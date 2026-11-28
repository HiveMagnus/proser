import { createHash, timingSafeEqual } from 'node:crypto';

import { addressKey, createRateLimiter } from '@hivemagnus/hive-common/rate-limit';

const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 60_000;
const MAX_SOURCES = 10_000;

// Callers pass the time explicitly (tests); the limiter reads it through this clock.
let clock = Date.now();
/**
 * Failed sign-ins per hashed source and per hashed account: a token bucket of
 * FAILURE_LIMIT that refills over FAILURE_WINDOW_MS. Only failures spend from
 * it; a successful sign-in resets both keys. At most MAX_SOURCES keys are held,
 * and a key that keeps being refused is the last one dropped.
 */
const failures = createRateLimiter({
  limit: FAILURE_LIMIT,
  windowMs: FAILURE_WINDOW_MS,
  maxKeys: MAX_SOURCES,
  now: () => clock,
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function constantTimeLocalCredentialsMatch(
  suppliedUsername: string,
  expectedUsername: string,
  suppliedPassword: string,
  expectedPassword: string,
): boolean {
  const usernameMatches = timingSafeEqual(digest(suppliedUsername), digest(expectedUsername));
  const passwordMatches = timingSafeEqual(digest(suppliedPassword), digest(expectedPassword));
  return usernameMatches && passwordMatches;
}

export function localAuthSource(request: Request): string {
  // IPv6 sources are grouped by /64, so one host cannot rotate addresses within its prefix.
  const source = addressKey(
    request.headers.get('x-proser-auth-source') || 'unresolved-socket-peer',
  );
  return createHash('sha256').update(source).digest('hex').slice(0, 24);
}

export function localAuthAccount(username: string): string {
  return createHash('sha256').update(username).digest('hex').slice(0, 24);
}

export function localAuthFailureTableSizeForTests(): number {
  return failures.size;
}

export function localAuthFailureAllowed(
  source: string,
  account: string,
  now = Date.now(),
): boolean {
  clock = now;
  return (
    failures.peek(`source:${source}`).remaining >= 1 &&
    failures.peek(`account:${account}`).remaining >= 1
  );
}

export function recordLocalAuthFailure(source: string, account: string, now = Date.now()): void {
  clock = now;
  failures.consume(`source:${source}`);
  failures.consume(`account:${account}`);
}

export function clearLocalAuthFailures(source: string, account: string): void {
  failures.reset(`source:${source}`);
  failures.reset(`account:${account}`);
}

export function resetLocalAuthFailuresForTests(): void {
  failures.clear();
}
