export const EDITORIAL_AUTONOMIES = ['review_only', 'propose_only', 'safe_auto', 'max_quality_auto'] as const;
export type EditorialAutonomy = (typeof EDITORIAL_AUTONOMIES)[number];

export const EDITORIAL_PASS_KEYS = [
  'line_edit_safe', 'dialogue', 'voice_preservation', 'scene_energy',
  'continuity', 'name_originality', 'final_polish', 'custom',
] as const;
export type EditorialPassKey = (typeof EDITORIAL_PASS_KEYS)[number];
export type EditorialScopeType = 'book' | 'act' | 'chapter' | 'scene';
export type EditorialRisk = 'low' | 'medium' | 'high';

export type EditorialSkipReason =
  | 'review_only' | 'propose_only' | 'source_revision_stale' | 'source_text_mismatch'
  | 'risk_exceeds_policy' | 'change_budget_exceeded' | 'hard_invariant_failed'
  | 'judge_disagreement' | 'confidence_below_threshold' | 'preference_margin_too_small'
  | 'original_wins' | 'no_clear_winner' | 'overlapping_proposal' | 'unsupported_evidence'
  | 'optional_pass_failed' | 'verification_failed' | 'no_material_improvement';

export type EditorialRunOutcome =
  | 'completed_with_changes' | 'completed_no_changes' | 'completed_with_skips'
  | 'completed_review_only' | 'completed_proposals_only' | 'superseded_by_new_revision';

export interface EditorialChangeBudget {
  maxChangedWordsPercentPerScene: number;
  maxChangedWordsPercentTotal: number;
  maxProposals: number;
  maxCandidatesPerProposal: number;
  maxInferenceTokens: number;
  maxJudgeEscalations: number;
}

export interface EditorialOptimizeInput {
  bookId: number;
  scope: { type: EditorialScopeType; id?: number };
  objective?: string;
  passPack: EditorialPassKey;
  autonomy: EditorialAutonomy;
  profileId?: string;
  protectedElements?: string[];
  changeBudget?: Partial<EditorialChangeBudget>;
  acceptancePolicy?: {
    minimumConfidence?: number;
    minimumPreferenceMargin?: number;
    maximumRisk?: 'low' | 'medium';
    requireNoHardRegression?: boolean;
  };
  modelPolicy?: {
    generator?: string;
    primaryJudge?: string;
    secondaryJudge?: string;
    tieBreakerJudge?: string;
    longRangeCritic?: string;
  };
}

export interface EditorialPassDefinition {
  key: EditorialPassKey;
  version: string;
  displayName: string;
  description: string;
  supportedScopes: EditorialScopeType[];
  defaultAutonomy: EditorialAutonomy;
  allowedRisk: Array<'low' | 'medium'>;
  detectorKeys: string[];
  criticKeys: string[];
  candidateRecipe: string | null;
  judgeProfiles: string[];
  verificationKeys: string[];
  mayChange: string[];
  mustPreserve: string[];
  defaultBudget: EditorialChangeBudget;
  enabled: boolean;
}

export interface EvidenceSpan {
  start: number;
  end: number;
  text: string;
}

export interface EditorialFinding {
  id: string;
  detectorKey: string;
  detectorVersion: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  rationale: string;
  recommendation: string;
  risk: EditorialRisk;
  autofixEligible: boolean;
  evidence: EvidenceSpan[];
  protectedClaims: string[];
  sceneId?: number;
}

export interface EditorialRunSummary {
  runId: string;
  workflowType: 'editorial_optimize';
  status: 'completed';
  outcome: EditorialRunOutcome;
  bookId: number;
  scope: { type: EditorialScopeType; id?: number };
  sourceRevisionId: string;
  resultRevisionId: string | null;
  passPack: { key: EditorialPassKey; version: string };
  policyVersion: string;
  profile: { id: string | null; version: string; hash: string };
  counts: {
    scopesReviewed: number;
    findingsCreated: number;
    proposalsGenerated: number;
    proposalsApplied: number;
    originalWins: number;
    noClearWinner: number;
    skipped: number;
    verificationPassed: number;
    verificationFailed: number;
  };
  change: { changedWords: number; changedWordsPercent: number };
  quality: { hardInvariantsPassed: boolean; judgeAgreementRate: number; styleDriftWithinProfile: boolean };
  unresolved: { count: number; topCategories: string[] };
  artifactIds: { summary: string | null; verification: string | null; releaseEvidence: string | null };
  retry: { safeToRepeat: true; useSameIdempotencyKey: true };
}
