import { DocumentError } from './errors';
import type { documentService } from './service';
type Source = Awaited<ReturnType<typeof documentService.read>>;
export function workflowCheckpointSource(source: Source | undefined) {
  return source ? { schemaVersion: 1, projection: 'final', sceneId: source.sceneId, bookRevisionId: source.bookRevisionId, sceneRevisionId: source.revisionId, contentHash: source.contentHash } : undefined;
}
/** Approval does not allow a saved quotation to be relocated or rebased over
 * changed layout, formatting, objects, review or codex context. */
export function assertWorkflowCheckpointSource(proposal: unknown, source: Source | undefined) {
  if (!source) return;
  const saved = (proposal as { sourceProof?: ReturnType<typeof workflowCheckpointSource> } | null)?.sourceProof;
  const current = workflowCheckpointSource(source)!;
  if (!saved || saved.schemaVersion !== 1 || saved.projection !== 'final' || saved.sceneId !== current.sceneId || saved.bookRevisionId !== current.bookRevisionId || saved.sceneRevisionId !== current.sceneRevisionId || saved.contentHash !== current.contentHash) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Approved workflow proposal belongs to an earlier complete source. Reconcile and obtain a new approval.', 412, { source: saved, current });
}
