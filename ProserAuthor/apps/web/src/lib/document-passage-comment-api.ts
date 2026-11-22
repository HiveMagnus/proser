import type {
  PassageCommentCommit,
  PassageCommentAcknowledgement,
  PassageCommentPageRequest,
  PassageCommentPage,
  DocumentPassageReceipt,
} from '@cheftaco/proser-contracts';
import { requestDocumentResource } from './document-api';
const comments = (bookId: string, sceneId: string) =>
  `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}/document-passages/comments`;
export const commitPassageComment = (
  bookId: string,
  sceneId: string,
  input: PassageCommentCommit,
) =>
  requestDocumentResource<DocumentPassageReceipt<PassageCommentAcknowledgement>>(
    comments(bookId, sceneId),
    { method: 'POST', body: JSON.stringify(input) },
  );
export const getPassageComment = (
  bookId: string,
  sceneId: string,
  commentId: string,
  input: PassageCommentPageRequest,
) => {
  const query = new URLSearchParams({
    bookRevisionId: input.bookRevisionId,
    expectedSceneRevisionId: input.expectedSceneRevisionId,
    recordHash: input.recordHash,
  });
  if (input.offset !== undefined) query.set('offset', String(input.offset));
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  return requestDocumentResource<PassageCommentPage>(
    comments(bookId, sceneId) + '/' + encodeURIComponent(commentId) + '?' + query.toString(),
  );
};
