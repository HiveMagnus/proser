import { z } from 'zod';
import { documentMutationPreconditionsSchema } from './documents';

export const creativeImageSchema = z.object({
  bookId: z.number().int().positive(),
  source: z.enum(['proser_maps', 'pixelfactory', 'nova']),
  sourceId: z.string().min(1).max(160),
  sourceRevision: z.string().min(1).max(160),
  artifactKey: z.string().min(1).max(160),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytesBase64: z.string().min(1).max(8 * 1024 * 1024),
  visibility: z.enum(['player', 'gm', 'private']),
  license: z.string().min(1).max(2000),
  provenance: z.record(z.string(), z.unknown()),
  caption: z.string().max(2000).default(''),
  setCover: z.boolean().default(false),
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  expectedPreviousDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

