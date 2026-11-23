import path from 'node:path';
import { ValidationError } from '@/lib/errors';

/**
 * Resolve `segments` under `root` and refuse a result outside it. Callers
 * already validate the identifiers they pass; this keeps a future caller that
 * does not from reaching another directory.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...segments);
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw new ValidationError('Storage path escapes its directory');
  }
  return candidate;
}
