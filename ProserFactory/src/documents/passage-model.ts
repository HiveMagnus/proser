/** Bounded scene passages. Offsets are UTF-16 in immutable canonical runs. */
import type {
  DocumentParagraph,
  DocumentChange,
  DocumentLayout,
  DocumentImage,
  DocumentBreak,
  DocumentManifest,
  SceneDocumentReference,
  DocumentView,
  DocumentAnchor,
  DocumentComment,
} from "./model";
import type { DocumentStyleDefinitions } from "./style-model";
import type { PassageObjectSource, PassageBodyPlacement, PassageChangeSummary } from "./passage-operations-model";
import type { ScopeReference } from "./scope-model";
/** Server-derived ownership/layout evidence; windowHash remains on the envelope
 * to avoid a circular digest. Cursors are only addresses in this pinned source. */
export interface DocumentPassageSourceFrame {
  bookId: number;
  actId: number;
  chapterId: number;
  sceneId: number;
  bookRevisionId: string;
  bookContentHash: string;
  sceneRevisionId: string;
  sceneContentHash: string;
  qualifiedMembershipHash: string;
  structureScope: ScopeReference;
  layoutScope: ScopeReference;
  effectiveStyleLayoutHash: string;
  projection: DocumentView;
}
export interface DocumentPassageCursor {
  paragraph: number;
  offset: number;
  /** Ordered leaf address; supports image/break-only scenes. */
  item?: number;
  /** Visible-run index for metadata-heavy/zero-length runs. */
  run?: number;
}
export interface DocumentPassageRequest {
  bookRevisionId?: string;
  cursor?: DocumentPassageCursor;
  maxCharacters?: number;
  maxParagraphs?: number;
  maxRuns?: number;
  projection?: DocumentView;
  reviewOffset?: number;
  edge?: "last";
  anchorBlockId?: string;
  anchorRunId?: string;
  anchorOffset?: number;
  anchorSourceHash?: string;
}
export interface DocumentPassageRunSource {
  runId: string;
  sourceHash: string;
  from: number;
  to: number;
  sourceLength: number;
  projectionStart?: number;
}
export interface DocumentPassageParagraph {
  paragraphHash?: string;
  containerHash?: string;
  boundaryAfterHash?: string;
  adjacentAfterId?: string;
  paragraph: DocumentParagraph;
  ordinal: number;
  offset: number;
  length: number;
  continuedBefore: boolean;
  continuedAfter: boolean;
  runs: DocumentPassageRunSource[];
  container?: {
    tableId: string;
    rowId: string;
    cellId: string;
    widths: number[];
    rowOrdinal?: number;
    columnIndex?: number;
    cellParagraphOrdinal?: number;
  };
}
export interface PassageItemPlacement {
  before: PassageBodyPlacement;
  after: PassageBodyPlacement;
}
export type DocumentPassageItem =
  | { type: "paragraph"; paragraphIndex: number; blockOrdinal: number; placement: PassageItemPlacement }
  | { type: "image"; image: DocumentImage; source: PassageObjectSource; blockOrdinal: number; placement: PassageItemPlacement }
  | { type: "pageBreak"; pageBreak: DocumentBreak; source: PassageObjectSource; blockOrdinal: number; placement: PassageItemPlacement }
  | { type: "tableSlice"; id: string; widths: number[]; source: PassageObjectSource; placement: PassageItemPlacement; blockOrdinal: number; rowCount: number; columnCount: number; columnHashes: string[]; continuedBefore: boolean; continuedAfter: boolean; rows: Array<{ id: string; ordinal: number; sourceHash: string; cells: Array<{ id: string; columnIndex: number; paragraphCount: number; continuedBefore: boolean; continuedAfter: boolean; paragraphIndexes: number[] }> }> };
export interface PassageCommentSummary {
  id: string; authorId: number; authorName: string; createdAt: string; resolved: boolean;
  recordHash: string; textPreview: string; anchorCount: number; resolutionCount: number;
  visibleRunIds: string[]; staleAnchorCount: number;
}
export interface DocumentPassage {
  sourceFrame?: DocumentPassageSourceFrame;
  styles?: DocumentStyleDefinitions;
  schemaVersion: 1;
  bookRevisionId: string;
  sceneId: number;
  sceneRevisionId: string;
  contentHash: string;
  projection: DocumentView;
  cursor: DocumentPassageCursor;
  next?: DocumentPassageCursor;
  paragraphs: DocumentPassageParagraph[];
  images: DocumentImage[];
  /** Canonical order; references paragraph slices without duplicating bodies. */
  items?: DocumentPassageItem[];
  /** Qualified insertion source for a genuinely empty canonical body. */
  emptyPlacement?: PassageBodyPlacement;
  changeSummaries?: PassageChangeSummary[];
  commentSummaries?: PassageCommentSummary[];
  reviewOffset?: number;
  nextReviewOffset?: number;
  changes: DocumentChange[];
  omitted: {
    paragraphs: number;
    comments: number;
    changes: number;
    objects: number;
  };
  layout: Omit<DocumentLayout, "header" | "footer">;
  windowHash: string;
}
export interface DocumentPassageTextEdit {
  blockId: string;
  runId: string;
  sourceHash: string;
  from: number;
  to: number;
  expectedText: string;
  replacement: string;
}
export interface DocumentPassageCommit {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  expectedSceneRevisionId: string;
  windowHash: string;
  cursor: DocumentPassageCursor;
  maxCharacters?: number;
  maxParagraphs?: number;
  maxRuns?: number;
  reviewOffset?: number;
  edits: DocumentPassageTextEdit[];
  tracking?: boolean;
}
/** Restore a complete immutable scene on Factory and return only its passage. */
export interface DocumentPassageRestore extends Omit<
  DocumentPassageCommit,
  "edits" | "tracking"
> {
  restoreFromRevisionId: string;
  restoreCursor?: DocumentPassageCursor;
}
export interface DocumentPassageRestoreResult {
  restoredFromRevisionId: string;
  passage: DocumentPassage;
}
/** Durable sparse receipt; complete scene documents are never transported. */
export interface DocumentPassageReceipt<T = DocumentPassage> {
  kind: "catalog";
  operationId: string;
  revisionId: string;
  contentHash: string;
  manifest: DocumentManifest;
  result: T;
  status: "completed";
  sceneReferences?: SceneDocumentReference[];
}

export type PassageCommentCommit = Omit<DocumentPassageRestore,"restoreFromRevisionId"|"restoreCursor"> & (
 | {action:"create";text:string;anchors:DocumentAnchor[]}
 | {action:"resolved"|"reopened";commentId:string;recordHash:string}
 | {action:"reanchored";commentId:string;recordHash:string;anchors:DocumentAnchor[]}
);
export interface PassageCommentAcknowledgement {commentId:string;action:PassageCommentCommit["action"];passage:DocumentPassage}
export interface PassageCommentPageRequest {bookRevisionId:string;expectedSceneRevisionId:string;recordHash:string;offset?:number;limit?:number}
export interface PassageCommentPage {id:string;authorId:number;authorName:string;createdAt:string;text:string;resolved:boolean;recordHash:string;offset:number;total:number;resolutionCount:number;anchors:DocumentAnchor[];anchorStates:NonNullable<DocumentComment["anchorStates"]>;nextOffset?:number;importedAuthor?:string}
