import { Response } from 'express';

export interface StandardError {
  code: string;
  message: string;
  details?: unknown;
}

export function respondSuccess<T>(res: Response, data: T, status = 200) {
  if (res.headersSent) return res;
  return res.status(status).json({ success: true, data });
}

export function respondError(res: Response, code: string, message: string, status = 400, details?: unknown) {
  if (res.headersSent) return res;
  return res.status(status).json({ success: false, error: { code, message, details } });
}

export const ErrorCodes = {
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
  EDITORIAL_PASS_NOT_FOUND: 'EDITORIAL_PASS_NOT_FOUND',
  EDITORIAL_PROFILE_INVALID: 'EDITORIAL_PROFILE_INVALID',
  EDITORIAL_SCOPE_INVALID: 'EDITORIAL_SCOPE_INVALID',
  EDITORIAL_SOURCE_STALE: 'EDITORIAL_SOURCE_STALE',
  EDITORIAL_BUDGET_EXCEEDED: 'EDITORIAL_BUDGET_EXCEEDED',
  EDITORIAL_PROPOSAL_STALE: 'EDITORIAL_PROPOSAL_STALE',
  EDITORIAL_PROPOSAL_NOT_APPLICABLE: 'EDITORIAL_PROPOSAL_NOT_APPLICABLE',
  EDITORIAL_BENCHMARK_INVALID: 'EDITORIAL_BENCHMARK_INVALID',
} as const;

/** Compile-time safe union of all error codes */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
