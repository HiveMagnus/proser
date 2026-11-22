import type { FrozenDocumentTarget, DocumentTargetInput, DocumentProposalProviderResult } from './proposal-model';
import type { DocumentPassageSourceFrame } from './passage-model';
import type { DocumentAnchor } from './model';
export type PlotThreadStage = 'setup' | 'escalation' | 'payoff';
export type PlotThreadStatus = 'open' | 'escalated' | 'resolved' | 'abandoned';
export type PlotThreadAssessment = 'earned' | 'weak' | 'insufficient-evidence';
export interface PlotThreadSource {
  frame: DocumentPassageSourceFrame;
  label: string;
  targets: Omit<FrozenDocumentTarget, 'paragraphText'>[];
  anchors: DocumentAnchor[];
  text: string;
  position: number[];
}
export interface PlotThreadEvidenceRecord {
  id: string; stage: PlotThreadStage; source: PlotThreadSource;
  removedAt: string | null; createdAt: string; stale: boolean;
}
export interface PlotThreadReviewSnapshot {
  schemaVersion: 1; bookRevisionId: string; threadId: number; threadVersion: number;
  question: string; description: string | null; notes: string | null;
  evidence: PlotThreadEvidenceRecord[]; checks: string[];
}
export interface PlotThreadCritique {
  assessment: PlotThreadAssessment; summary: string;
  findings: Array<{ aspect: 'promise' | 'escalation' | 'causality' | 'payoff'; explanation: string;
    citations: Array<{ evidenceId: string; quote: string }>; suggestion: string }>;
}
export interface PlotThreadReviewRecord {
  id: string; status: 'pending' | 'running' | 'ready' | 'failed' | 'unknown' | 'cancelled';
  snapshot: PlotThreadReviewSnapshot; result: (Partial<DocumentProposalProviderResult> & { output?: PlotThreadCritique }) | null;
  errorCode: string | null; assessment: PlotThreadAssessment | null; notes: string | null;
  createdAt: string; stale: boolean;
}
export interface PlotThreadRecord {
  id: number; bookId: number; threadKey: string; question: string | null; description: string | null;
  notes: string | null; status: PlotThreadStatus; version: number; authorManaged: boolean;
  archivedAt: string | null; evidence: PlotThreadEvidenceRecord[]; checks: string[];
  reviews: PlotThreadReviewRecord[];
}
export interface PlotThreadMutationInput {
  operationId: string; expectedVersion: number;
  question?: string; description?: string; notes?: string; status?: PlotThreadStatus; archived?: boolean;
}
export interface PlotThreadEvidenceInput {
  operationId: string; expectedVersion: number; stage: PlotThreadStage; sceneId: number;
  expectedRevisionId: string; expectedSceneRevisionId: string; expectedContentHash: string;
  targets: DocumentTargetInput[]; replacesEvidenceId?: string;
}

export type PlotThreadSummary = Omit<PlotThreadRecord, 'evidence' | 'reviews'> & { coverage: Record<PlotThreadStage, number> };
