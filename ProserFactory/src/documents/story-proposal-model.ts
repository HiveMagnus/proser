import type {
  DocumentTargetInput,
  FrozenDocumentTarget,
  DocumentDiscussionSnapshot,
  DocumentProposalRecord,
  DocumentProposalRequest,
  DocumentProposalApply,
} from "./proposal-model";
import type { DocumentPassageOperation } from "./passage-operations-model";
import type { ProserDocument, DocumentManifest } from "./model";
import type { DocumentStyleDefinitions } from "./style-model";
export interface DocumentStoryDiscussionInput {
  schemaVersion: 1;
  operationId: string;
  sessionId: string;
  storyId: string;
  expectedRevisionId: string;
  expectedLayoutRevisionId: string;
  expectedContentHash: string;
  projection: "final";
  targets: DocumentTargetInput[];
  localOperations?: {
    operationId: string;
    operations: DocumentPassageOperation[];
  };
  parentDiscussionId?: string;
}
export interface DocumentStoryDiscussionSnapshot extends Omit<
  DocumentDiscussionSnapshot,
  "sceneId" | "sourceSceneRevisionId" | "bookLayoutHash" | "conversation"
> {
  sourceKind: "layout-story";
  storyId: string;
  sourceLayoutRevisionId: string;
  sourceLayoutContentHash: string;
  sourceBookContentHash: string;
  ownerContextHash: string;
  conversation: Array<{
    proposalId: string;
    instruction: string;
    reply: string;
    sourceLayoutRevisionId: string;
  }>;
}
export interface DocumentStoryDiscussionRecord {
  draftOperations?: {
    operationId: string;
    operations: DocumentPassageOperation[];
  };
  id: string;
  bookId: number;
  storyId: string;
  sessionId: string;
  snapshot: DocumentStoryDiscussionSnapshot;
  createdAt: string;
}
export interface DocumentStoryProposalRecord extends Omit<
  DocumentProposalRecord,
  "sceneId" | "application"
> {
  storyId: string;
  application: DocumentStoryApplicationReceipt | null;
}
export interface DocumentStoryApplicationReceipt {
  kind: "catalog";
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: "completed";
  manifest: DocumentManifest;
  result: {
    sourceKind: "layout-story";
    storyId: string;
    proposalId: string;
    targetIds: string[];
  };
}
export interface DocumentStoryProposalValidationRecord {
  id: string;
  proposalId: string;
  bookId: number;
  bookRevisionId: string;
  layoutRevisionId: string;
  storyId: string;
  contentHash: string;
  targets: FrozenDocumentTarget[];
}
export interface DocumentStoryProposalApply extends Omit<
  DocumentProposalApply,
  "expectedSceneRevisionId"
> {
  expectedLayoutRevisionId: string;
}
export interface DocumentStoryDraftCommit {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  expectedLayoutRevisionId: string;
  expectedContentHash: string;
  operations: DocumentPassageOperation[];
}
export interface DocumentStorySourceRecord {
  sourceKind: "layout-story";
  bookId: number;
  storyId: string;
  bookRevisionId: string;
  layoutRevisionId: string;
  layoutContentHash: string;
  contentHash: string;
  ownerContextHash: string;
  document: ProserDocument;
  styles: DocumentStyleDefinitions;
}
export interface DocumentStoryDraftResult {
  sourceKind: "layout-story";
  storyId: string;
  bookRevisionId: string;
  layoutRevisionId: string;
  contentHash: string;
}
export type DocumentStoryProposalRequest = DocumentProposalRequest;

export interface DocumentStoryDraftReceipt {
  kind: "catalog";
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: "completed";
  manifest: DocumentManifest;
  result: DocumentStoryDraftResult;
}
