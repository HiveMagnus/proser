import { createHash, timingSafeEqual } from 'node:crypto';

const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 60_000;
const MAX_SOURCES = 10_000;
const failures = new Map<string, { count: number; resetAt: number }>();

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
  const source = request.headers.get('x-proser-auth-source') || 'unresolved-socket-peer';
  return createHash('sha256').update(source).digest('hex').slice(0, 24);
}

export function localAuthAccount(username: string): string {
  return createHash('sha256').update(username).digest('hex').slice(0, 24);
}

function throttleAllowed(key: string, now: number): boolean {
  const state = failures.get(key);
  if (!state || state.resetAt <= now) {
    if (failures.size >= MAX_SOURCES) {
      const oldest = failures.keys().next().value;
      if (oldest) failures.delete(oldest);
    }
    failures.set(key, { count: 0, resetAt: now + FAILURE_WINDOW_MS });
    return true;
  }
  return state.count < FAILURE_LIMIT;
}

function recordFailure(key: string, now: number): void {
  const state = failures.get(key);
  if (!state || state.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    return;
  }
  state.count += 1;
}

export function localAuthFailureAllowed(
  source: string,
  account: string,
  now = Date.now(),
): boolean {
  return throttleAllowed(`source:${source}`, now) && throttleAllowed(`account:${account}`, now);
}

export function recordLocalAuthFailure(source: string, account: string, now = Date.now()): void {
  recordFailure(`source:${source}`, now);
  recordFailure(`account:${account}`, now);
}

export function clearLocalAuthFailures(source: string, account: string): void {
  failures.delete(`source:${source}`);
  failures.delete(`account:${account}`);
}

export function resetLocalAuthFailuresForTests(): void {
  failures.clear();
}
