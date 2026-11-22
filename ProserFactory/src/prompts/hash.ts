/**
 * Utility to compute a deterministic hash of a prompt template for reproducibility.
 *
 * Use this when recording which exact prompt was used for a generation,
 * alongside the template version and model name.
 */
import { createHash } from 'node:crypto';
import type { PromptTemplate } from '@/types';

/** Returns a short SHA-256 hex digest (first 12 chars) of the template string. */
export function promptHash(template: string): string {
  return createHash('sha256').update(template).digest('hex').slice(0, 12);
}

/** Compact metadata object suitable for storing with generation records. */
export interface PromptMeta {
  key: string;
  version: string;
  hash: string;
}

/** Build a PromptMeta from a looked-up template. */
export function getPromptMeta(key: string, template: PromptTemplate): PromptMeta {
  return {
    key,
    version: template.version ?? '0.0.0',
    hash: promptHash(template.template),
  };
}
