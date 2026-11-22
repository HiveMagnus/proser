import type { DocumentPassageDraft } from './document-passage-journal';
export interface PassageOperationDependencies<
  T extends { operationId: string; status: 'completed' },
> {
  isCurrent(): boolean;
  persist(intent: DocumentPassageDraft): Promise<void>;
  recover(operationId: string): Promise<T | undefined>;
  dispatch(intent: NonNullable<DocumentPassageDraft['pending']>): Promise<T>;
  acknowledge(receipt: T, intent: DocumentPassageDraft): Promise<void>;
}
/** A lost response never creates a new operation or triggers an automatic retry. */
export async function executePassageOperation<
  T extends { operationId: string; status: 'completed' },
>(
  intent: DocumentPassageDraft,
  dependencies: PassageOperationDependencies<T>,
  options: { recoverFirst?: boolean; retryAbsent?: boolean } = {},
): Promise<
  { state: 'acknowledged'; receipt: T } | { state: 'inactive' | 'recoverable'; error?: unknown }
> {
  const pending = intent.pending;
  if (!pending) throw new Error('A passage operation requires an exact retained request.');
  if (!dependencies.isCurrent()) return { state: 'inactive' };
  await dependencies.persist(intent);
  if (!dependencies.isCurrent()) return { state: 'inactive' };
  let receipt: T | undefined;
  try {
    if (options.recoverFirst) {
      receipt = await dependencies.recover(pending.request.operationId);
      if (!dependencies.isCurrent()) return { state: 'inactive' };
      if (!receipt && !options.retryAbsent) return { state: 'recoverable' };
    }
    receipt ??= await dependencies.dispatch(structuredClone(pending));
    if (!dependencies.isCurrent()) return { state: 'inactive' };
    if (receipt.operationId !== pending.request.operationId || receipt.status !== 'completed')
      throw new Error('Factory returned a different passage operation receipt.');
    await dependencies.acknowledge(receipt, intent);
    if (!dependencies.isCurrent()) return { state: 'inactive' };
    return { state: 'acknowledged', receipt };
  } catch (error) {
    return { state: dependencies.isCurrent() ? 'recoverable' : 'inactive', error };
  }
}
