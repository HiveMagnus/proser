import { DocumentError } from './errors';
import { readDocumentDiscussion, requestDocumentProposal } from './proposals';
import type { DocumentDiscussionSnapshot } from './proposal-model';

/** Legacy tool names use the same disclosed, identity-bound proposal service. */
export async function compatibilityRevisionProposal(userId: number, input: {
  bookId: number; sceneId?: number; originalText?: string; instruction: string;
  scope?: 'scene' | 'paragraph'; selectedModel?: string;
  documentPreview?: { discussionId: string; operationId: string };
}) {
  if (!input.documentPreview || !input.sceneId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Prepare and disclose a document discussion, then supply sceneId and documentPreview before requesting revision.', 428);
  const discussion = await readDocumentDiscussion(userId, input.bookId, input.documentPreview.discussionId);
  if (discussion.sceneId !== input.sceneId) throw new DocumentError('DOCUMENT_SOURCE_MISMATCH', 'The discussion belongs to a different scene.', 409);
  const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
  if (input.scope === 'paragraph' && snapshot.targets.length !== 1) throw new DocumentError('DOCUMENT_TARGET_INCOMPATIBLE', 'Paragraph commands require one disclosed paragraph target.', 409);
  if (input.originalText !== undefined && input.originalText !== snapshot.targets.map((target) => target.sourceText).join('\n\n')) throw new DocumentError('DOCUMENT_SOURCE_MISMATCH', 'Original text differs from the exact disclosed targets.', 409);
  const proposal = await requestDocumentProposal(userId, input.bookId, discussion.id, { operationId: input.documentPreview.operationId, instruction: input.instruction, selectedModel: input.selectedModel });
  return {
    schemaVersion: 1 as const, projection: 'final' as const, discussionId: discussion.id,
    proposalId: proposal.id, proposal, scope: input.scope,
    source: { bookRevisionId: snapshot.sourceBookRevisionId, sceneRevisionId: snapshot.sourceSceneRevisionId, contentHash: snapshot.sourceContentHash },
  };
}
