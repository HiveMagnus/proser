import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../../lib/errors';
import logger from '../../lib/logger';

type ValidationLocation = 'body' | 'params' | 'query';

export function zodIssueLog(error: ZodError): Array<{ path: string; code: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : 'value',
    code: issue.code,
  }));
}

function schemaIdentifier(req: Request, location: ValidationLocation): string {
  const route = typeof req.route?.path === 'string' ? req.route.path : req.path;
  return `${req.method.toUpperCase()} ${route} ${location}`;
}

/**
 * Express middleware that validates req.body against a Zod schema.
 * On success, replaces req.body with the parsed (typed) result.
 * On failure, throws a ValidationError (caught by errorHandler).
 */
export function zBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = formatZodError(result.error);
      logger.warn({
        schema: schemaIdentifier(req, 'body'),
        issues: zodIssueLog(result.error),
      }, 'Request validation failed');
      throw new ValidationError(message);
    }
    req.body = result.data;
    next();
  };
}

/**
 * Express middleware that validates req.params against a Zod schema.
 * On success, replaces req.params with the parsed (typed) result.
 * On failure, throws a ValidationError.
 */
export function zParams<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const message = formatZodError(result.error);
      logger.warn({
        schema: schemaIdentifier(req, 'params'),
        issues: zodIssueLog(result.error),
      }, 'Request validation failed');
      throw new ValidationError(message);
    }
    // Express params are read-only, but we can still coerce values in-place
    Object.assign(req.params, result.data);
    next();
  };
}

/**
 * Express middleware that validates req.query against a Zod schema.
 * On success, replaces req.query with the parsed (typed) result.
 * On failure, throws a ValidationError.
 *
 * Note: In Express 5, req.query is a read-only getter, so we override
 * it with Object.defineProperty to avoid "Cannot set property" errors.
 */
export function zQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const message = formatZodError(result.error);
      logger.warn({
        schema: schemaIdentifier(req, 'query'),
        issues: zodIssueLog(result.error),
      }, 'Request validation failed');
      throw new ValidationError(message);
    }
    // Express 5 makes req.query a read-only getter — override with a value property
    Object.defineProperty(req, 'query', {
      value: result.data,
      writable: true,
      configurable: true,
    });
    next();
  };
}

/**
 * Flatten a ZodError into a human-readable semicolon-delimited string,
 * matching the previous validation middleware's output format.
 */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'value';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
