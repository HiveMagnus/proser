import type {
  DocumentTargetInput,
  DocumentProposalProviderResult,
} from "./proposal-model";
export type CampaignPreset =
  "antagonist" | "character-arc" | "pacing" | "theme";
export interface CampaignCitation {
  sceneId: number;
  sceneRevisionId: string;
  blockId: string;
  from: number;
  to: number;
  quote: string;
}
export interface CampaignRule {
  text: string;
  citations: CampaignCitation[];
}
export interface CampaignConstraints {
  facts: CampaignRule[];
  voice: CampaignRule[];
}
export interface CampaignStep {
  id: string;
  sceneId: number;
  chapterId: number;
  title: string;
  instruction: string;
  citations: CampaignCitation[];
  prerequisites: string[];
  consequences: Array<{ prediction: string; citations: CampaignCitation[] }>;
  questions: string[];
  manual: boolean;
}
export interface CampaignCoverage {
  sceneId: number;
  chapterId: number;
  sceneRevisionId: string;
  blockId: string;
  from: number;
  to: number;
  status: "reviewed" | "empty" | "unavailable" | "failed" | "budget-limited";
  reason?: string;
}
export interface CampaignEvidenceRecheck {
  target: string;
  assessment: "holds" | "changed" | "missing" | "inconclusive";
  explanation: string;
  citations: CampaignCitation[];
}
export interface CampaignAnalysis {
  rechecks: CampaignEvidenceRecheck[];
  summary: string;
  suggestions: CampaignConstraints;
  steps: CampaignStep[];
  coverage: CampaignCoverage[];
  gaps: string[];
  complete: boolean;
}
export interface CampaignRecord {
  id: string;
  bookId: number;
  version: number;
  goal: string;
  preset: CampaignPreset;
  constraints: CampaignConstraints;
  confirmed: boolean;
  status: string;
}
export interface CampaignPlanRecord {
  id: string;
  campaignId: string;
  runId: string;
  campaignVersion: number;
  bookRevisionId: string;
  stale: boolean;
  approved: boolean;
  analysis?: CampaignAnalysis;
  workflowStatus: string;
  failureReason?: string | null;
  decisions: Array<{
    stepId: string;
    decision: string;
    reason: string;
    proposalId?: string;
  }>;
}
export interface CampaignDetail {
  campaign: CampaignRecord;
  plans: CampaignPlanRecord[];
  complete: boolean;
  verifications: CampaignVerification[];
}
export interface CampaignProposalContext {
  campaignId: string;
  campaignVersion: number;
  planId: string;
  stepId: string;
  bookRevisionId: string;
  goal: string;
  constraints: CampaignConstraints;
  step: CampaignStep;
  downstream: CampaignStep[];
}
export interface CampaignVerification {
  proposalId: string;
  targetIds: string[];
  candidateHash: string;
  bookRevisionId: string;
  passed: boolean;
  facts: string;
  voice: string;
  consequences: string;
  citations: CampaignCitation[];
  failures: string[];
  provider?: DocumentProposalProviderResult["provenance"];
}
export interface CampaignPreparedTarget {
  sceneId: number;
  targets: DocumentTargetInput[];
}
