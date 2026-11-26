import type {
  DocumentStoryDiscussionInput,
  DocumentStoryDiscussionRecord,
  DocumentStoryProposalRecord,
  DocumentStoryProposalRequest,
  DocumentStoryProposalValidationRecord,
  DocumentStoryProposalApply,
  DocumentStoryDraftCommit,
  DocumentStoryDraftReceipt,
  DocumentStorySourceRecord,
} from '@hivemagnus/proser-contracts';
import { requestDocumentResource } from './document-api';
const base = (bookId: string) => `/api/books/${encodeURIComponent(bookId)}`;
const discussion = (bookId: string, id?: string) =>
  base(bookId) + '/document-story-discussions' + (id ? '/' + encodeURIComponent(id) : '');
const proposal = (bookId: string, id: string) =>
  base(bookId) + '/document-story-proposals/' + encodeURIComponent(id);
export const getDocumentStory = (
  bookId: string,
  storyId: string,
  signal?: AbortSignal,
  pinnedBookRevision?: string,
) =>
  requestDocumentResource<DocumentStorySourceRecord>(
    base(bookId) +
      '/layout-stories/' +
      encodeURIComponent(storyId) +
      '/document' +
      (pinnedBookRevision ? '?bookRevisionId=' + encodeURIComponent(pinnedBookRevision) : ''),
    { signal },
  );
export const commitDocumentStoryDraft = (
  bookId: string,
  storyId: string,
  input: DocumentStoryDraftCommit,
) =>
  requestDocumentResource<DocumentStoryDraftReceipt>(
    base(bookId) + '/layout-stories/' + encodeURIComponent(storyId) + '/document-draft-commits',
    { method: 'POST', body: JSON.stringify(input) },
  );
export const prepareStoryDiscussion = (bookId: string, input: DocumentStoryDiscussionInput) =>
  requestDocumentResource<DocumentStoryDiscussionRecord>(discussion(bookId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const listStoryDiscussions = (bookId: string, storyId: string) =>
  requestDocumentResource<DocumentStoryDiscussionRecord[]>(
    discussion(bookId) + '?storyId=' + encodeURIComponent(storyId),
  );
export const getStoryDiscussion = (bookId: string, id: string) =>
  requestDocumentResource<DocumentStoryDiscussionRecord>(discussion(bookId, id));
export const listStoryProposals = (bookId: string, id: string) =>
  requestDocumentResource<
    Array<{ id: string; status: DocumentStoryProposalRecord['status']; createdAt: string }>
  >(discussion(bookId, id) + '/proposals');
export const requestStoryProposal = (
  bookId: string,
  id: string,
  input: DocumentStoryProposalRequest,
  signal?: AbortSignal,
) =>
  requestDocumentResource<DocumentStoryProposalRecord>(
    discussion(bookId, id) + '/proposals',
    { method: 'POST', body: JSON.stringify(input), signal },
    150000,
  );
export const getStoryProposal = (bookId: string, id: string) =>
  requestDocumentResource<DocumentStoryProposalRecord>(proposal(bookId, id));
export const cancelStoryProposal = (bookId: string, id: string) =>
  requestDocumentResource(proposal(bookId, id) + '/cancel', { method: 'POST', body: '{}' });
export const revalidateStoryProposal = (
  bookId: string,
  id: string,
  input: { operationId: string; expectedRevisionId: string; expectedLayoutRevisionId: string },
) =>
  requestDocumentResource<DocumentStoryProposalValidationRecord>(
    proposal(bookId, id) + '/revalidate',
    { method: 'POST', body: JSON.stringify(input) },
  );
export const applyStoryProposal = (bookId: string, id: string, input: DocumentStoryProposalApply) =>
  requestDocumentResource<{
    kind: 'catalog';
    operationId: string;
    revisionId: string;
    status: 'completed';
    manifest: DocumentStoryDraftReceipt['manifest'];
    result: { sourceKind: 'layout-story'; storyId: string; proposalId: string };
  }>(proposal(bookId, id) + '/apply', { method: 'POST', body: JSON.stringify(input) });
