// Generated from Factory documents/proposal-model.ts; edit Factory and run npm run documents:sync.
import type {
  DocumentParagraph,
  ProserDocument,
  DocumentManifest,
  SceneDocumentReference,
} from './document-model.js';
import type { DocumentPassageOperation } from './document-passage-operations.js';
export interface DocumentTargetInput {
  blockId: string;
  from: number;
  to: number;
  sourceText: string;
}
export interface FrozenDocumentTarget extends DocumentTargetInput {
  targetId: string;
  paragraphText: string;
  formatHash: string;
  objectHash: string;
  runIds: string[];
  container: { tableId?: string; rowId?: string; cellId?: string };
  editable: boolean;
}
export interface DocumentDiscussionInput {
  schemaVersion: 1;
  operationId: string;
  sessionId: string;
  sceneId: number;
  expectedRevisionId: string;
  expectedSceneRevisionId: string;
  expectedContentHash: string;
  projection: 'final';
  targets: DocumentTargetInput[];
  localDocument?: ProserDocument;
  localOperations?: {
    operationId: string;
    operations: DocumentPassageOperation[];
  };
  parentDiscussionId?: string;
  transitionChapterId?: number;
  revisionCampaignPlanId?: string;
  revisionCampaignStepId?: string;
  plotThreadReviewId?: string;
  plotThreadEvidenceId?: string;
}
export interface DocumentDiscussionSnapshot {
  schemaVersion: 1;
  revisionCampaign?: import('./revision-campaigns.js').CampaignProposalContext;
  transition?: ChapterTransition;
  plotThread?: {
    reviewId: string;
    evidenceId: string;
    snapshot: import('./plot-threads.js').PlotThreadReviewSnapshot;
    critique: import('./plot-threads.js').PlotThreadCritique;
  };
  sceneId: number;
  sessionId: string;
  projection: 'final';
  sourceBookRevisionId: string;
  sourceSceneRevisionId: string;
  sourceContentHash: string;
  bookLayoutHash: string;
  localDraftDigest: string;
  unsaved: boolean;
  targets: FrozenDocumentTarget[];
  blocks: DocumentParagraph[];
  codex: Array<{ id: number; name: string; type: string; text: string }>;
  omitted: { blockIds: string[]; codexIds: number[] };
  maxPromptBytes: number;
  maxOutputTokens: number;
  templateVersion: '1.0.0';
  conversation: Array<{
    proposalId: string;
    instruction: string;
    reply: string;
    sourceSceneRevisionId: string;
  }>;
  omittedProposalIds: string[];
  omittedEarlierTurnCount: number;
  draftOperationId?: string;
}
export interface DocumentProposalOutput {
  reply: string;
  edits: Array<{ targetId: string; sourceText: string; replacement: string }>;
}
export interface DocumentProposalProviderResult {
  raw: string;
  provenance: {
    providerId: string;
    requestedModel?: string;
    configuredModel?: string;
    reportedModel?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    params: { [key: string]: string | number | boolean | undefined };
    recipe: string;
    recipeVersion: string;
  };
}
export interface DocumentProposalRequest {
  operationId: string;
  instruction: string;
  selectedModel?: string;
}
export interface DocumentProposalApply {
  operationId: string;
  expectedRevisionId: string;
  expectedSceneRevisionId: string;
  validationId: string;
  targetIds: string[];
}
export interface DocumentDiscussionRecord {
  id: string;
  bookId: number;
  sceneId: number;
  sessionId: string;
  snapshot: DocumentDiscussionSnapshot;
  createdAt: string;
}
export interface DocumentProposalRecord {
  id: string;
  discussionId: string;
  bookId: number;
  sceneId: number;
  status: 'pending' | 'running' | 'ready' | 'unknown' | 'failed' | 'cancelled' | 'applied';
  request: DocumentProposalRequest;
  result:
    | (Partial<DocumentProposalProviderResult> & {
        output?: DocumentProposalOutput;
        finishReason?: string;
        errorCode?: string;
      })
    | null;
  errorCode?: string | null;
  providerOutcome: 'completed' | 'pending' | 'unknown' | 'not-started';
  applicationOperationId?: string | null;
  application: DocumentProposalApplicationReceipt | null;
}
export interface DocumentProposalValidationRecord {
  id: string;
  proposalId: string;
  bookId: number;
  bookRevisionId: string;
  sceneRevisionId: string;
  contentHash: string;
  targets: FrozenDocumentTarget[];
}
export interface DocumentTraceSnapshot {
  schemaVersion: 1;
  projection: 'final';
  bookRevisionId: string;
  sceneRevisionId: string;
  generationOperationId: string;
  contentHash: string;
  bookLayoutHash: string;
  targets: FrozenDocumentTarget[];
  maxPromptBytes: number;
}
export interface DocumentFeedbackTarget {
  targetId: string;
  from: number;
  to: number;
  sourceText: string;
}
export interface DocumentFeedbackOutput {
  judgeSummary: {
    headline: string;
    summary: string;
    strengths: string[];
    cautions: string[];
  };
  findings: Array<{
    target?: DocumentFeedbackTarget;
    findingType: string;
    severity: 'critical' | 'warning' | 'suggestion';
    title: string;
    message: string;
    suggestion?: string;
    rationale?: string;
  }>;
  compareCards: Array<{
    target: DocumentFeedbackTarget;
    title: string;
    message: string;
    optionALabel: string;
    optionAText: string;
    optionBLabel: string;
    optionBText: string;
    recommendedOption?: 'a' | 'b';
    rationale?: string;
  }>;
}
export interface DocumentCompareRequest {
  operationId: string;
  expectedRevisionId: string;
  expectedSceneRevisionId: string;
  traceId: string;
  compareCardId: number;
  chosen: 'a' | 'b';
  applyChosen: boolean;
  validationId?: string;
  rationale?: string;
}
export interface DocumentCompareValidationRecord {
  id: string;
  targetId: string;
  bookId: number;
  bookRevisionId: string;
  sceneRevisionId: string;
  contentHash: string;
  target: FrozenDocumentTarget;
}
export type DocumentTraceDisplayTarget = Omit<FrozenDocumentTarget, 'paragraphText'>;
export interface DocumentTraceReview {
  traceId: string;
  sceneId: number;
  analysisId?: string;
  status: string;
  source?: {
    bookRevisionId: string;
    sceneRevisionId: string;
    contentHash: string;
  };
  currentSource?: {
    bookRevisionId: string;
    sceneRevisionId: string;
    contentHash: string;
    bookContentHash: string;
    layoutContentHash: string;
  };
  summary?: DocumentFeedbackOutput['judgeSummary'];
  findings: Array<{
    id: number;
    title: string | null;
    message: string;
    severity: string;
    suggestion: string | null;
    target?: DocumentTraceDisplayTarget;
    state: 'bound' | 'stale' | 'unbound' | 'review-blocked';
    reason?: string;
  }>;
  compareCards: Array<{
    id: number;
    title: string;
    message: string;
    optionALabel: string;
    optionAText: string;
    optionBLabel: string;
    optionBText: string;
    status: string;
    target?: DocumentTraceDisplayTarget;
    state: 'bound' | 'stale' | 'unbound' | 'review-blocked';
    reason?: string;
  }>;
}

/** Sparse saved compare-choice receipt; no complete scene is transported. */
export interface DocumentCompareReceipt {
  kind: 'catalog';
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: 'completed';
  manifest: DocumentManifest;
  sceneReferences?: SceneDocumentReference[];
  result: {
    traceId: string;
    compareCardId: number;
    actionId: number;
    applied: boolean;
    sourceBookRevisionId: string;
    sourceSceneRevisionId: string;
  };
}

/** Exact sparse proposal receipt, including the current source that was replaced. */
export interface DocumentProposalApplicationReceipt {
  kind: 'catalog';
  operationId: string;
  revisionId: string;
  contentHash: string;
  status: 'completed';
  manifest: DocumentManifest;
  sceneReferences: SceneDocumentReference[];
  result: {
    proposalId: string;
    targetIds: string[];
    sceneId: number;
    sourceBookRevisionId: string;
    sourceSceneRevisionId: string;
  };
}

/** Saved final-view chapter boundaries from one immutable manuscript revision. */
export interface ChapterTransitionEdge {
  chapterId: number;
  label: string;
  sceneId?: number;
  sceneRevisionId?: string;
  contentHash?: string;
  text: string;
  truncated: boolean;
  target?: DocumentTargetInput;
}
export interface ChapterTransition {
  bookRevisionId: string;
  ending: ChapterTransitionEdge;
  opening: ChapterTransitionEdge;
}
export interface ChapterTransitions {
  bookId: number;
  bookTitle: string;
  bookRevisionId: string;
  chapterCount: number;
  transitions: ChapterTransition[];
}
