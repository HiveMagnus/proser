import type {
  ProserDocument,
  DocumentSpan,
  DocumentAnchorLineage,
  DocumentManifestResponse,
} from '@cheftaco/proser-editor';
import type {
  VerifiedDocumentAnchorLineage,
  DocumentCapabilities,
  DocumentDiscussionInput,
  DocumentDiscussionRecord,
  DocumentProposalRequest,
  DocumentProposalRecord,
  DocumentProposalValidationRecord,
  DocumentProposalApply,
  BookScopeContents,
  DocumentLayoutCommitInput,
  DocumentLayoutCommitReceipt,
  DocumentScopeKind,
  DocumentQuickDraftInput,
  DocumentQuickDraftReceipt,
  DocumentCreatedBookReceipt,
  DocumentTraceReview,
  DocumentCompareRequest,
  DocumentCompareValidationRecord,
} from '@cheftaco/proser-contracts';
export class DocumentRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}
export interface SavedSceneDocument {
  sceneId: number;
  revisionId: string;
  bookRevisionId: string;
  contentHash: string;
  document: ProserDocument;
  projection: { text: string; wordCount: number; spans: DocumentSpan[] };
}
export interface SaveDocumentRequest {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  scenes: Array<{
    sceneId: number;
    expectedRevisionId: string;
    document: ProserDocument;
    restoreFromRevisionId?: string;
  }>;
  anchorLineage?: DocumentAnchorLineage[];
}
export interface SaveDocumentReceipt {
  kind: 'commit';
  operationId: string;
  revisionId: string;
  status: 'completed';
  anchorLineage?: VerifiedDocumentAnchorLineage[];
  scenes: Array<{
    sceneId: number;
    revisionId: string;
    contentHash: string;
    text: string;
    wordCount: number;
    document: ProserDocument;
    restoredFromRevisionId?: string;
  }>;
}
async function boundedRequest<T>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    cache: 'no-store',
  });
  if (Number(response.headers.get('content-length') ?? 0) > 8 * 1024 * 1024) {
    await response.body?.cancel();
    throw new DocumentRequestError('Document response exceeds the supported limit.', 502);
  }
  const reader = response.body?.getReader();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new DocumentRequestError('Document response exceeds the supported limit.', 502);
      }
      text += decoder.decode(value, { stream: true });
    }
  text += decoder.decode();
  let body: { success: boolean; data?: T; error?: { message?: string; code?: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new DocumentRequestError(
      'Factory returned an invalid document response.',
      response.status,
    );
  }
  if (!response.ok || !body.success || body.data === undefined)
    throw new DocumentRequestError(
      body.error?.message ?? 'Unable to access this document.',
      response.status,
      body.error?.code,
    );
  return body.data;
}
async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await boundedRequest<T>(path, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    });
  } catch (error) {
    if (timedOut)
      throw new DocumentRequestError(
        'Document request timed out. Recover the save receipt before retrying.',
        408,
        'DOCUMENT_TIMEOUT',
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const base = (bookId: string) => `/api/books/${encodeURIComponent(bookId)}`;
export type NegotiatedDocumentCapabilities = Omit<DocumentCapabilities, 'schemaVersion'> & {
  schemaVersion: number;
};
export const getAuthoringDocumentCapabilities = (signal?: AbortSignal) =>
  request<NegotiatedDocumentCapabilities>('/api/books/document-capabilities', {
    signal,
  });
export const recoverDocumentBookCreation = (operationId: string, expectedUserId?: string) =>
  request<DocumentCreatedBookReceipt>(
    `/api/books/document-creation-operations/${encodeURIComponent(operationId)}`,
    expectedUserId
      ? { headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) } }
      : {},
  );
export const createDocumentQuickDraft = (bookId: string, body: DocumentQuickDraftInput) =>
  request<DocumentQuickDraftReceipt>(`${base(bookId)}/document-quick-drafts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const recoverDocumentQuickDraft = (bookId: string, operationId: string) =>
  request<DocumentQuickDraftReceipt>(
    `${base(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
  );
export const getDocumentCapabilities = (bookId: string, signal?: AbortSignal) =>
  request<NegotiatedDocumentCapabilities>(`${base(bookId)}/document-capabilities`, {
    signal,
  });
export const getDocumentManifest = (bookId: string, signal?: AbortSignal) =>
  request<DocumentManifestResponse>(`${base(bookId)}/document-manifest`, { signal });
export const getDocumentScope = <K extends DocumentScopeKind>(
  bookId: string,
  kind: K,
  signal?: AbortSignal,
) =>
  request<{
    revisionId: string;
    contentHash: string;
    bookRevisionId: string;
    content: BookScopeContents[K];
  }>(`${base(bookId)}/document-scopes/${kind}`, { signal });
export type BookCatalogScope = Awaited<ReturnType<typeof getDocumentScope<'structure'>>>;
export interface BookCatalogReceipt {
  kind: 'catalog';
  status: 'completed';
  operationId: string;
  revisionId: string;
  contentHash: string;
  result: { id?: number; bookId?: number; [key: string]: unknown };
}
export const getDocumentBookCatalogScope = (bookId: string, expectedUserId: string) =>
  request<BookCatalogScope>(`${base(bookId)}/document-scopes/structure`, {
    headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) },
  });
export const recoverDocumentBookCatalog = (
  bookId: string,
  operationId: string,
  expectedUserId: string,
) =>
  request<BookCatalogReceipt>(
    `${base(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
    { headers: { 'X-Proser-Expected-User': encodeURIComponent(expectedUserId) } },
  );
export type SaveLayoutRequest = DocumentLayoutCommitInput;
export type SaveLayoutReceipt = DocumentLayoutCommitReceipt;
export const saveDocumentLayout = (bookId: string, body: SaveLayoutRequest) =>
  request<SaveLayoutReceipt>(`${base(bookId)}/document-layout-commits`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const recoverDocumentLayout = (bookId: string, operationId: string) =>
  request<SaveLayoutReceipt>(
    `${base(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
  );
export const initializeDocuments = (bookId: string) =>
  request<{ revisionId: string }>(`${base(bookId)}/document-initialize`, {
    method: 'POST',
    body: '{}',
  });
export const getSceneDocument = (bookId: string, sceneId: string, signal?: AbortSignal) =>
  request<SavedSceneDocument>(`${base(bookId)}/scenes/${encodeURIComponent(sceneId)}/document`, {
    signal,
  });
export const saveSceneDocument = (
  bookId: string,
  body: SaveDocumentRequest,
  signal?: AbortSignal,
) =>
  request<SaveDocumentReceipt>(`${base(bookId)}/document-commits`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
export const recoverDocumentSave = (bookId: string, operationId: string) =>
  request<SaveDocumentReceipt>(
    `${base(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
  );
export const prepareDocumentDiscussion = (bookId: string, body: DocumentDiscussionInput) =>
  request<DocumentDiscussionRecord>(`${base(bookId)}/document-discussions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const listDocumentDiscussions = (bookId: string, sceneId: string) =>
  request<DocumentDiscussionRecord[]>(
    `${base(bookId)}/document-discussions?sceneId=${encodeURIComponent(sceneId)}`,
  );
export const listDocumentProposals = (bookId: string, discussionId: string) =>
  request<Array<{ id: string; status: DocumentProposalRecord['status']; createdAt: string }>>(
    `${base(bookId)}/document-discussions/${encodeURIComponent(discussionId)}/proposals`,
  );
export const getDocumentDiscussion = (bookId: string, discussionId: string) =>
  request<DocumentDiscussionRecord>(
    `${base(bookId)}/document-discussions/${encodeURIComponent(discussionId)}`,
  );
export const requestDocumentProposal = (
  bookId: string,
  discussionId: string,
  body: DocumentProposalRequest,
  signal?: AbortSignal,
) =>
  request<DocumentProposalRecord>(
    `${base(bookId)}/document-discussions/${encodeURIComponent(discussionId)}/proposals`,
    { method: 'POST', body: JSON.stringify(body), signal },
    150_000,
  );
export const getDocumentProposal = (bookId: string, proposalId: string) =>
  request<DocumentProposalRecord>(
    `${base(bookId)}/document-proposals/${encodeURIComponent(proposalId)}`,
  );
export const cancelDocumentProposal = (bookId: string, proposalId: string) =>
  request<{ id: string; status: string }>(
    `${base(bookId)}/document-proposals/${encodeURIComponent(proposalId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
export const getDocumentTraceReview = (bookId: string, sceneId: string, signal?: AbortSignal) =>
  request<DocumentTraceReview | null>(
    `${base(bookId)}/document-traces?sceneId=${encodeURIComponent(sceneId)}`,
    { signal },
  );
export const revalidateDocumentCompare = (
  bookId: string,
  traceId: string,
  cardId: number,
  body: { operationId: string; expectedRevisionId: string; expectedSceneRevisionId: string },
) =>
  request<DocumentCompareValidationRecord>(
    `${base(bookId)}/document-traces/${encodeURIComponent(traceId)}/compare-cards/${cardId}/revalidate`,
    { method: 'POST', body: JSON.stringify(body) },
  );
export const recordDocumentCompare = (
  bookId: string,
  sceneId: string,
  body: DocumentCompareRequest,
) =>
  request<{ documentReceipt: import('@cheftaco/proser-contracts').DocumentCompareReceipt }>(
    `${base(bookId)}/scenes/${encodeURIComponent(sceneId)}/prose/preferences`,
    { method: 'POST', body: JSON.stringify(body) },
  );
export const recoverDocumentCompare = (bookId: string, operationId: string) =>
  request<import('@cheftaco/proser-contracts').DocumentCompareReceipt>(
    `${base(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
  );
export const cancelDocumentAnalysis = (bookId: string, operationId: string) =>
  request<{ id: string; status: string }>(
    `${base(bookId)}/document-analysis-operations/${encodeURIComponent(operationId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
export const revalidateDocumentProposal = (
  bookId: string,
  proposalId: string,
  body: { operationId: string; expectedRevisionId: string; expectedSceneRevisionId: string },
) =>
  request<DocumentProposalValidationRecord>(
    `${base(bookId)}/document-proposals/${encodeURIComponent(proposalId)}/revalidate`,
    { method: 'POST', body: JSON.stringify(body) },
  );
export const applyDocumentProposal = (
  bookId: string,
  proposalId: string,
  body: DocumentProposalApply,
) =>
  request<import('@cheftaco/proser-contracts').DocumentProposalApplicationReceipt>(
    `${base(bookId)}/document-proposals/${encodeURIComponent(proposalId)}/apply`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );

const commentBase = (bookId: string, scope: { kind: 'scene' | 'layout-story'; id: string }) =>
  `${base(bookId)}/${scope.kind === 'scene' ? 'scenes' : 'layout-stories'}/${encodeURIComponent(scope.id)}/document-comments`;
export const getDocumentComments = (
  bookId: string,
  scope: { kind: 'scene' | 'layout-story'; id: string },
  signal?: AbortSignal,
) =>
  request<
    | import('@cheftaco/proser-contracts').SceneCommentsResponse
    | import('@cheftaco/proser-contracts').LayoutStoryCommentsResponse
  >(commentBase(bookId, scope), { signal });
export const revalidateDocumentComment = (
  bookId: string,
  scope: { kind: 'scene' | 'layout-story'; id: string },
  commentId: string,
  body:
    | import('@cheftaco/proser-contracts').SceneCommentRevalidationRequest
    | import('@cheftaco/proser-contracts').LayoutStoryCommentRevalidationRequest,
) =>
  request<
    | import('@cheftaco/proser-contracts').SceneCommentRevalidationResponse
    | import('@cheftaco/proser-contracts').LayoutStoryCommentRevalidationResponse
  >(`${commentBase(bookId, scope)}/${encodeURIComponent(commentId)}/revalidate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const resolveDocumentComment = (
  bookId: string,
  scope: { kind: 'scene' | 'layout-story'; id: string },
  commentId: string,
  body:
    | import('@cheftaco/proser-contracts').SceneCommentResolutionRequest
    | import('@cheftaco/proser-contracts').LayoutStoryCommentResolutionRequest,
) =>
  request<import('@cheftaco/proser-contracts').DocumentCommentReviewReceipt>(
    `${commentBase(bookId, scope)}/${encodeURIComponent(commentId)}/resolve`,
    { method: 'POST', body: JSON.stringify(body) },
  );
export const recoverDocumentComment = (bookId: string, operationId: string) =>
  request<import('@cheftaco/proser-contracts').DocumentCommentReviewReceipt>(
    `${base(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
  );
export const getDocumentLayoutRevision = (bookId: string, revisionId: string) =>
  request<import('@cheftaco/proser-contracts').DocumentLayoutRevisionResponse>(
    `${base(bookId)}/document-layout-revisions/${encodeURIComponent(revisionId)}`,
  );
export const searchDocumentBook = (
  bookId: string,
  input: import('@cheftaco/proser-contracts').DocumentSearchRequest,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({
    q: input.q,
    limit: String(input.limit ?? 20),
    caseSensitive: input.caseSensitive ? '1' : '0',
  });
  if (input.cursor) query.set('cursor', input.cursor);
  return request<import('@cheftaco/proser-contracts').DocumentSearchResponse>(
    `${base(bookId)}/document-search?${query.toString()}`,
    { signal },
  );
};
export const recoverDocumentSearchIndex = (
  bookId: string,
  input: import('@cheftaco/proser-contracts').DocumentSearchIndexRecoveryRequest,
  signal?: AbortSignal,
) =>
  request<import('@cheftaco/proser-contracts').DocumentSearchIndexRecoveryResponse>(
    `${base(bookId)}/document-search-index/recover`,
    { method: 'POST', body: JSON.stringify(input), signal },
  );

/** Reuse the authenticated, bounded Factory envelope reader for document subresources. */
export const requestDocumentResource = request;
