/**
 * Shared Zod primitives for route parameter and query validation.
 *
 * Route params arrive as strings from Express. These helpers coerce
 * string values to the appropriate types and apply range constraints.
 */
import { z } from 'zod';

/** Coerce a route param string to a positive integer (≥ 1). */
export const positiveIntParam = (name: string) =>
  z.coerce.number({ error: `${name} must be a valid integer` })
    .int(`${name} must be a valid integer`)
    .min(1, `${name} must be at least 1`);

/** Optional integer query param (coerced from string). */
export const optionalIntQuery = (name: string, min = 1, max = 10000) =>
  z.coerce.number({ error: `${name} must be a valid integer` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be at least ${min}`)
    .max(max, `${name} must not exceed ${max}`)
    .optional();

/** Optional string that allows empty / missing. */
export const optionalStr = (name: string, maxLen = Infinity) =>
  z.string({ error: `${name} must be a string` })
    .max(maxLen === Infinity ? 1_000_000 : maxLen, `${name} must not exceed ${maxLen} characters`)
    .optional()
    .or(z.literal('').transform(() => undefined));

/** Required non-empty string. */
export const requiredStr = (name: string, minLen = 1, maxLen = Infinity) =>
  z.string({ error: issue => issue.input === undefined ? `${name} is required` : `${name} must be a string` })
    .min(minLen, `${name} must be at least ${minLen} characters`)
    .max(maxLen === Infinity ? 1_000_000 : maxLen, `${name} must not exceed ${maxLen} characters`);

/** Optional integer body field (not coerced — expects a number in JSON). */
export const optionalInt = (name: string, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.number({ error: `${name} must be a valid integer` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be at least ${min}`)
    .max(max, `${name} must not exceed ${max}`)
    .optional();

/** Required integer body field. */
export const requiredInt = (name: string, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z.number({ error: issue => issue.input === undefined ? `${name} is required` : `${name} must be a valid integer` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be at least ${min}`)
    .max(max, `${name} must not exceed ${max}`);

/** Optional float body field. */
export const optionalFloat = (name: string, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.number({ error: `${name} must be a valid number` })
    .min(min, `${name} must be at least ${min}`)
    .max(max, `${name} must not exceed ${max}`)
    .optional();

/** Standard pagination query params. */
export const paginationQuery = z.object({
  page: optionalIntQuery('page', 1, 10000),
  pageSize: optionalIntQuery('pageSize', 1, 500),
}).passthrough();

/** bookId route param. */
export const bookIdParams = z.object({
  bookId: positiveIntParam('bookId'),
});

/** Generic :id route param. */
export const idParams = z.object({
  id: positiveIntParam('id'),
});
