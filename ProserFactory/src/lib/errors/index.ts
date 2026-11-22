import VError from 'verror';
import { Request, Response, NextFunction } from 'express';
import logger from '../logger';
import { ErrorCodes } from '../../api/utils/response';
import { DocumentError } from '../../documents/errors';

export class DatabaseError extends VError {
  public name: string;
  
  constructor(cause: Error, message: string) {
    super({ cause }, message);
    this.name = 'DatabaseError';
  }
}

export class AIServiceError extends VError {
  public name: string;
  
  constructor(cause: Error, message: string) {
    super({ cause }, message);
    this.name = 'AIServiceError';
  }
}

export class ValidationError extends VError {
  public name: string;
  
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends VError {
  public name: string;
  
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends VError {
  public name: string;
  
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends VError {
  public name: string;

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends VError {
  public name: string;

  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// Global error handler middleware
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Include request context for better debugging
  const reqContext: Record<string, unknown> = {
    path: req.path,
    method: req.method,
    ip: req.ip,
  };
  // Safely extract user id if present (from authenticateRequest middleware)
  const user = req.user;
  if (user?.id) reqContext.userId = user.id;

  // Don't log expected domain errors (404, 401, 422) at error level
  const isExpected = err instanceof NotFoundError
    || err instanceof AuthenticationError
    || err instanceof AuthorizationError
    || err instanceof ValidationError
    || err instanceof RateLimitError;

  if (isExpected) {
    if (!(err instanceof ValidationError)) {
      logger.warn({ errorType: err.name, error: err.message, ...reqContext }, 'Request rejected');
    }
  } else {
    logger.error({ error: err.message, stack: err.stack, ...reqContext }, 'Request error');
  }

  // Prevent double-send if headers already flushed (e.g. SSE streams)
  if (res.headersSent) return;

  if (err instanceof DocumentError) {
    res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(422).json({ success: false, error: { code: ErrorCodes.VALIDATION_FAILED, message: err.message } });
    return;
  }

  if (err instanceof AuthenticationError) {
    res.status(401).json({ success: false, error: { code: ErrorCodes.UNAUTHORIZED, message: err.message } });
    return;
  }

  if (err instanceof AuthorizationError) {
    res.status(403).json({ success: false, error: { code: ErrorCodes.FORBIDDEN, message: err.message } });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: err.message } });
    return;
  }

  if (err instanceof RateLimitError) {
    res.status(429).json({ success: false, error: { code: ErrorCodes.RATE_LIMITED, message: err.message } });
    return;
  }

  if (err instanceof DatabaseError) {
    res.status(500).json({ success: false, error: { code: ErrorCodes.DB_ERROR, message: 'Database operation failed' } });
    return;
  }

  if (err instanceof AIServiceError) {
    res.status(503).json({ success: false, error: { code: ErrorCodes.AI_SERVICE_UNAVAILABLE, message: err.message || 'AI service unavailable' } });
    return;
  }

  if (err instanceof VError) {
    res.status(500).json({ success: false, error: { code: ErrorCodes.INTERNAL_ERROR, message: err.message, details: process.env.NODE_ENV === 'development' ? VError.fullStack(err) : undefined } });
    return;
  }

  // Generic error
  res.status(500).json({ success: false, error: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal server error', details: process.env.NODE_ENV === 'development' ? err.stack : undefined } });
};
