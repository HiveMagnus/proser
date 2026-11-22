import type { DocumentMutationPreconditions } from './scope-model';
import { DocumentError } from './errors';
import type { CatalogPreconditions, CatalogReceipt } from './service';
/** Only the trusted command supplies the receipt payload; callers supply the
 * immutable revision preconditions, never the request hash or actor. */
export function catalogCommand(expected: DocumentMutationPreconditions | undefined, payload: unknown): CatalogPreconditions {
  if (!expected?.operationId || !expected.expectedRevisionId || !expected.expectedScopes) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Operation ID and expected book/scope revisions are required.', 428);
  return { operationId: expected.operationId, expectedRevisionId: expected.expectedRevisionId, expectedScopes: expected.expectedScopes, payload };
}
export function catalogResult<T>(receipt: CatalogReceipt<T>) {
  return { ...receipt.result, documentRevision: { operationId: receipt.operationId, bookRevisionId: receipt.revisionId, contentHash: receipt.contentHash, scopes: receipt.manifest.scopes } };
}
