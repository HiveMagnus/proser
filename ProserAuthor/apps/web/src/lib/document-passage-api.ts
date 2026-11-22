import type {
  DocumentPassage,
  DocumentPassageCommit,
  DocumentPassageReceipt,
  DocumentPassageRequest,
  DocumentPassageRestore,
  DocumentPassageRestoreResult,
  DocumentPassageOperationCommit,
} from '@cheftaco/proser-contracts';
import { DocumentRequestError, requestDocumentResource } from './document-api';
const scenePath = (bookId: string, sceneId: string) =>
  `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}/document-passages`;
export function getScenePassage(
  bookId: string,
  sceneId: string,
  input: DocumentPassageRequest = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (input.bookRevisionId) query.set('bookRevisionId', input.bookRevisionId);
  if (input.edge) query.set('edge', input.edge);
  if (input.anchorBlockId) query.set('anchorBlockId', input.anchorBlockId);
  if (input.anchorRunId) query.set('anchorRunId', input.anchorRunId);
  if (input.anchorOffset !== undefined) query.set('anchorOffset', String(input.anchorOffset));
  if (input.anchorSourceHash) query.set('anchorSourceHash', input.anchorSourceHash);
  if (input.cursor) {
    query.set('paragraph', String(input.cursor.paragraph));
    query.set('offset', String(input.cursor.offset));
    if (input.cursor.item !== undefined) query.set('item', String(input.cursor.item));
    if (input.cursor.run !== undefined) query.set('run', String(input.cursor.run));
  }
  if (input.maxCharacters !== undefined) query.set('maxCharacters', String(input.maxCharacters));
  if (input.maxParagraphs !== undefined) query.set('maxParagraphs', String(input.maxParagraphs));
  if (input.maxRuns !== undefined) query.set('maxRuns', String(input.maxRuns));
  if (input.projection) query.set('projection', input.projection);
  if (input.reviewOffset !== undefined) query.set('reviewOffset', String(input.reviewOffset));
  return requestDocumentResource<DocumentPassage>(
    scenePath(bookId, sceneId) + (query.size ? '?' + query.toString() : ''),
    { signal },
  );
}
export const saveScenePassage = (
  bookId: string,
  sceneId: string,
  request: DocumentPassageCommit,
  signal?: AbortSignal,
) =>
  requestDocumentResource<DocumentPassageReceipt>(scenePath(bookId, sceneId), {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
export const restoreScenePassage = (
  bookId: string,
  sceneId: string,
  request: DocumentPassageRestore,
  signal?: AbortSignal,
) =>
  requestDocumentResource<DocumentPassageReceipt<DocumentPassageRestoreResult>>(
    scenePath(bookId, sceneId) + '/restore',
    { method: 'POST', body: JSON.stringify(request), signal },
  );
export async function recoverScenePassage<T = DocumentPassage>(
  bookId: string,
  operationId: string,
): Promise<DocumentPassageReceipt<T> | undefined> {
  try {
    return await requestDocumentResource<DocumentPassageReceipt<T>>(
      `/api/books/${encodeURIComponent(bookId)}/document-operations/${encodeURIComponent(operationId)}`,
    );
  } catch (error) {
    if (error instanceof DocumentRequestError && error.status === 404) return;
    throw error;
  }
}
/** Check the exact sparse acknowledgement before any recovery record is removed. */
export function acknowledgedScenePassage(
  receipt: DocumentPassageReceipt | DocumentPassageReceipt<DocumentPassageRestoreResult>,
  bookId: string,
  sceneId: string,
  operationId: string,
  restoredFromRevisionId?: string,
  projection: DocumentPassage['projection'] = 'final',
): DocumentPassage {
  const result = receipt.result;
  const passage = 'passage' in result ? result.passage : result;
  const references = receipt.sceneReferences?.filter((scene) => scene.sceneId === Number(sceneId));
  const scene = references?.length === 1 ? references[0] : undefined;
  const membership = receipt.manifest.scenes.filter((scene) => scene.sceneId === Number(sceneId));
  if (
    receipt.kind !== 'catalog' ||
    receipt.status !== 'completed' ||
    receipt.operationId !== operationId ||
    !Number.isSafeInteger(Number(bookId)) ||
    Number(bookId) <= 0 ||
    passage.sceneId !== Number(sceneId) ||
    passage.bookRevisionId !== receipt.revisionId ||
    passage.sceneRevisionId !== scene?.revisionId ||
    passage.contentHash !== scene?.contentHash ||
    passage.projection !== projection ||
    membership.length !== 1 ||
    membership[0]?.revisionId !== passage.sceneRevisionId ||
    membership[0]?.contentHash !== passage.contentHash ||
    'scenes' in receipt ||
    (restoredFromRevisionId !== undefined &&
      (!('restoredFromRevisionId' in result) ||
        result.restoredFromRevisionId !== restoredFromRevisionId))
  )
    throw new Error(
      'Factory returned an incompatible passage acknowledgement. Recover the original operation.',
    );
  return passage;
}

export function commitScenePassageOperations(
  bookId: string,
  sceneId: string,
  request: DocumentPassageOperationCommit,
  signal?: AbortSignal,
) {
  return requestDocumentResource<import('./document-passage-typed-session').PassageTypedReceipt>(
    scenePath(bookId, sceneId) + '/operations',
    { method: 'POST', body: JSON.stringify(request), signal },
  );
}
