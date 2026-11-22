import type { NextFunction, Request, Response } from 'express';

import { ErrorCodes, respondError } from '@/api/utils/response';
import { databaseService } from '@/lib/database';

interface OwnedBookBudgetOptions {
  source: 'body' | 'params';
  required?: boolean;
  includeDeleted?: boolean;
}

function requestedBookId(req: Request, source: OwnedBookBudgetOptions['source']): number | null {
  const value = source === 'params' ? req.params.bookId : req.body?.bookId;
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : Number.NaN;
}

/**
 * Resolve book ownership before a request can acquire book-scoped capacity.
 * The limiter consumes only authorizedBookId and never caller-controlled input.
 */
export function ownedBookBudget(options: OwnedBookBudgetOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      respondError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const bookId = requestedBookId(req, options.source);
    if (bookId === null && !options.required) {
      next();
      return;
    }
    if (bookId === null || !Number.isFinite(bookId)) {
      respondError(res, ErrorCodes.VALIDATION_FAILED, 'A valid bookId is required', 400);
      return;
    }

    const owned = await databaseService.client.book.findFirst({
      where: { id: bookId, userId, deletedAt: options.includeDeleted ? {} : null },
      select: { id: true },
    });
    if (!owned) {
      // Deliberately indistinguishable from a missing book.
      respondError(res, ErrorCodes.NOT_FOUND, 'Book not found', 404);
      return;
    }

    req.authorizedBookId = owned.id;
    next();
  };
}
