import { AsyncLocalStorage } from 'node:async_hooks';
export interface DocumentMutationContext {
  userId: number; actorGithubId?: string; sharedResourceOperationId?: string;
  signal: () => AbortSignal | undefined;
}
const contexts = new AsyncLocalStorage<DocumentMutationContext>();
/** Set only after Factory authentication; document JSON cannot supply this. */
export function withDocumentMutationContext<T>(context: DocumentMutationContext, action: () => T): T {
  return contexts.run(context, action);
}
export function currentDocumentMutationContext() { return contexts.getStore(); }
