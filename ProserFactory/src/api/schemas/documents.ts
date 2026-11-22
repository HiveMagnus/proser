import { z } from 'zod';
import { documentSchema } from '@/documents/validation';
import { DocumentError } from '@/documents/errors';
import { bookLayoutSchema } from '@/documents/scopeValidation';
export const documentMutationPreconditionsSchema = z.object({
  operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(),
  expectedScopes: z.object({ structure: z.string().uuid().optional(), canon: z.string().uuid().optional(), layout: z.string().uuid().optional() }).strict(),
  expectedSceneRevisionId: z.string().uuid().optional(),
}).strict();
export function parseDocumentMutationPreconditions(value: unknown) {
  return value === undefined ? undefined : documentMutationPreconditionsSchema.parse(value);
}
export function requireDocumentPreconditions(body: unknown, scoped: boolean) {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (!input.expectedRevisionId || !input.operationId || (scoped && Array.isArray(input.scenes) && input.scenes.some((scene: unknown) => !scene || typeof scene !== 'object' || !('expectedRevisionId' in scene) || !scene.expectedRevisionId))) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Book/scoped revisions and an operation ID are required.', 428);
  if (Buffer.byteLength(JSON.stringify(body) ?? '') > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_COMMIT_TOO_LARGE', 'Document request exceeds 8 MiB.', 413);
}
export const documentBookParams = z.object({ bookId: z.coerce.number().int().positive().max(2147483647) });
const lineagePoint = z.object({ sceneId: z.number().int().positive(), blockId: z.string().min(1).max(128), runId: z.string().min(1).max(128), from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict();
export const documentCommitSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(),
  scenes: z.array(z.object({ sceneId: z.number().int().positive().max(2147483647), expectedRevisionId: z.string().uuid(), restoreFromRevisionId: z.string().uuid().optional(), document: documentSchema }).strict()).min(1).max(100),
  anchorLineage: z.array(z.object({ kind: z.enum(['split','join','move','restore','format']), source: lineagePoint, target: lineagePoint }).strict()).max(10000).optional(),
}).strict();
export const documentLayoutCommitSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(),
  restoreFromRevisionId: z.string().uuid().optional(),
  expectedScopes: z.object({ layout: z.string().uuid() }).strict(), layout: bookLayoutSchema,
}).strict();
export const documentQuickDraftSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(),
  expectedScopes: z.object({ structure: z.string().uuid() }).strict(),
  summary: z.string().max(1000), outline: z.string().max(20000),
}).strict();
