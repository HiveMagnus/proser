import { z } from 'zod';
import { DocumentError } from './errors';
export const publicationOptionsSchema = z
  .object({
    format: z.enum(['docx', 'epub', 'pdf', 'html', 'markdown', 'text', 'json']),
    mode: z.enum(['retain-review', 'final', 'original']).default('final'),
    preset: z.enum(['saved', 'submission-manuscript', 'print-book']).default('saved'),
  })
  .strict();
export const publicationJobSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    options: publicationOptionsSchema,
  })
  .strict();
export function requirePublicationPreconditions(raw: unknown) {
  const value = raw as Record<string, unknown> | undefined;
  if (!value?.operationId || !value.expectedRevisionId)
    throw new DocumentError(
      'DOCUMENT_PRECONDITION_REQUIRED',
      'Operation ID and expected book revision are required.',
      428,
    );
}
