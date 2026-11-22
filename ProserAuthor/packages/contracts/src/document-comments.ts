// Generated from Factory documents/comment-review-model.ts; edit Factory and run npm run documents:sync.
/** Factory-owned classic comment review contracts. Author receives generated
 * copies without importing Factory runtime services or schema implementations. */
import type {
  DocumentAnchor,
  DocumentComment,
  DocumentManifest,
  SceneDocumentReference,
  ProserDocument,
} from './document-model.js';
export type DocumentCommentResolutionAction = 'resolved' | 'reopened' | 'reanchored';
export interface SceneCommentReviewSource {
  expectedRevisionId: string;
  expectedSceneRevisionId: string;
}
export interface LayoutStoryCommentReviewSource {
  expectedRevisionId: string;
  expectedLayoutRevisionId: string;
}
export interface SceneCommentRevalidationRequest extends SceneCommentReviewSource {
  anchors?: DocumentAnchor[];
}
export interface LayoutStoryCommentRevalidationRequest extends LayoutStoryCommentReviewSource {
  anchors?: DocumentAnchor[];
}
export interface SceneCommentResolutionRequest extends SceneCommentRevalidationRequest {
  operationId: string;
  action: DocumentCommentResolutionAction;
}
export interface LayoutStoryCommentResolutionRequest extends LayoutStoryCommentRevalidationRequest {
  operationId: string;
  action: DocumentCommentResolutionAction;
}
export interface SceneCommentsResponse {
  schemaVersion: 1;
  sceneId: number;
  bookRevisionId: string;
  sceneRevisionId: string;
  contentHash: string;
  comments: DocumentComment[];
}
export interface LayoutStoryCommentsResponse {
  schemaVersion: 1;
  sourceKind: 'layout-story';
  storyId: string;
  bookRevisionId: string;
  layoutRevisionId: string;
  contentHash: string;
  comments: DocumentComment[];
}
export interface SceneCommentRevalidationResponse extends Omit<SceneCommentsResponse, 'comments'> {
  commentId: string;
  comment: DocumentComment;
  attachment: 'attached' | 'detached';
  proposedAnchors?: DocumentAnchor[];
}
export interface LayoutStoryCommentRevalidationResponse extends Omit<
  LayoutStoryCommentsResponse,
  'comments'
> {
  commentId: string;
  comment: DocumentComment;
  attachment: 'attached' | 'detached';
  proposedAnchors?: DocumentAnchor[];
}
export interface SceneCommentResolutionResult {
  sceneId: number;
  commentId: string;
  action: DocumentCommentResolutionAction;
}
export interface LayoutStoryCommentResolutionResult {
  storyId: string;
  commentId: string;
  action: DocumentCommentResolutionAction;
}
export interface DocumentCommentReviewReceipt<
  T extends SceneCommentResolutionResult | LayoutStoryCommentResolutionResult =
    SceneCommentResolutionResult | LayoutStoryCommentResolutionResult,
> {
  kind: 'catalog';
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: 'completed';
  manifest: DocumentManifest;
  result: T;
  scenes?: Array<
    SceneDocumentReference & {
      text: string;
      document: ProserDocument;
      restoredFromRevisionId?: string;
    }
  >;
}
