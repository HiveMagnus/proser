import { z } from 'zod';
import { DocumentError } from './errors';
export const importPreviewSchema = z.object({ operationId: z.string().uuid(), originalId: z.string().uuid(), expectedRevisionId: z.string().uuid() }).strict();
export const importCommitSchema = z.object({ operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(), expectedScopes: z.object({ structure: z.string().uuid(), canon: z.string().uuid() }).strict(), consentReportHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function requireImportCommitPreconditions(raw: unknown) {
  const fields = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const scopes = fields.expectedScopes && typeof fields.expectedScopes === 'object' ? fields.expectedScopes as Record<string, unknown> : {};
  if (!fields.operationId || !fields.expectedRevisionId || !scopes.structure || !scopes.canon) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Book and structure/canon revisions and operation ID are required.', 428);
  if (!fields.consentReportHash) throw new DocumentError('DOCUMENT_IMPORT_CONSENT_REQUIRED', 'Explicit consent to the retained conversion report is required.', 409);
}

export const docxImportCommitSchema = importCommitSchema.extend({expectedScopes:z.object({structure:z.string().uuid(),canon:z.string().uuid(),layout:z.string().uuid()}).strict()});
export function requireDocxImportCommitPreconditions(raw:unknown){requireImportCommitPreconditions(raw);if(!(raw as {expectedScopes?:{layout?:string}}).expectedScopes?.layout)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Source layout revision is required for DOCX import.',428);}
