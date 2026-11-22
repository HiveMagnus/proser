import type {
  EditorialAutonomy, EditorialChangeBudget, EditorialRisk, EditorialSkipReason,
} from './contracts';

export const EDITORIAL_POLICY_VERSION = 'editorial-policy-v1';

const integer = (name: string, fallback: number) =>
  Math.max(0, Number.parseInt(process.env[name] ?? String(fallback), 10) || fallback);
const decimal = (name: string, fallback: number) =>
  Math.max(0, Number.parseFloat(process.env[name] ?? String(fallback)) || fallback);

export const EDITORIAL_LIMITS = Object.freeze({
  maxActivePerUser: integer('EDITORIAL_MAX_ACTIVE_PER_USER', 2),
  maxActiveGlobal: integer('EDITORIAL_MAX_ACTIVE_GLOBAL', 8),
  maxProposals: integer('EDITORIAL_MAX_PROPOSALS', 100),
  maxCandidatesPerProposal: Math.min(2, integer('EDITORIAL_MAX_CANDIDATES_PER_PROPOSAL', 2)),
  maxChangedPercentScene: Math.min(30, decimal('EDITORIAL_MAX_CHANGED_PERCENT_SCENE', 18)),
  maxChangedPercentTotal: Math.min(20, decimal('EDITORIAL_MAX_CHANGED_PERCENT_TOTAL', 12)),
  maxJudgeEscalations: Math.min(2, integer('EDITORIAL_MAX_JUDGE_ESCALATIONS', 1)),
  maxInferenceTokens: integer('EDITORIAL_MAX_INFERENCE_TOKENS', 100_000),
  minimumConfidence: Math.min(1, decimal('EDITORIAL_MIN_CONFIDENCE', 0.78)),
  minimumPreferenceMargin: Math.min(1, decimal('EDITORIAL_MIN_PREFERENCE_MARGIN', 0.15)),
  referenceOverlapThreshold: Math.min(1, decimal('EDITORIAL_REFERENCE_OVERLAP_THRESHOLD', 0.32)),
});

export function defaultBudget(autonomy: EditorialAutonomy): EditorialChangeBudget {
  const maximal = autonomy === 'max_quality_auto';
  return {
    maxChangedWordsPercentPerScene: Math.min(EDITORIAL_LIMITS.maxChangedPercentScene, maximal ? 18 : 10),
    maxChangedWordsPercentTotal: Math.min(EDITORIAL_LIMITS.maxChangedPercentTotal, maximal ? 12 : 8),
    maxProposals: Math.min(EDITORIAL_LIMITS.maxProposals, maximal ? 100 : 50),
    maxCandidatesPerProposal: EDITORIAL_LIMITS.maxCandidatesPerProposal,
    maxInferenceTokens: EDITORIAL_LIMITS.maxInferenceTokens,
    maxJudgeEscalations: EDITORIAL_LIMITS.maxJudgeEscalations,
  };
}

export function resolveBudget(autonomy: EditorialAutonomy, requested: Partial<EditorialChangeBudget> = {}): EditorialChangeBudget {
  const defaults = defaultBudget(autonomy);
  const upper: EditorialChangeBudget = {
    maxChangedWordsPercentPerScene: EDITORIAL_LIMITS.maxChangedPercentScene,
    maxChangedWordsPercentTotal: EDITORIAL_LIMITS.maxChangedPercentTotal,
    maxProposals: EDITORIAL_LIMITS.maxProposals,
    maxCandidatesPerProposal: EDITORIAL_LIMITS.maxCandidatesPerProposal,
    maxInferenceTokens: EDITORIAL_LIMITS.maxInferenceTokens,
    maxJudgeEscalations: EDITORIAL_LIMITS.maxJudgeEscalations,
  };
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    const requestedValue = requested[key as keyof EditorialChangeBudget];
    return [key, requestedValue === undefined ? value : Math.max(0, Math.min(upper[key as keyof EditorialChangeBudget], requestedValue))];
  })) as unknown as EditorialChangeBudget;
}

const riskRank: Record<EditorialRisk, number> = { low: 0, medium: 1, high: 2 };

export function decideApplication(input: {
  autonomy: EditorialAutonomy;
  risk: EditorialRisk;
  confidence: number;
  preferenceMargin: number;
  hardInvariantsPassed: boolean;
  withinBudget: boolean;
  materialImprovement: boolean;
  judgesAgree: boolean;
  sourceCurrent: boolean;
  sourceMatches: boolean;
  maximumRisk?: 'low' | 'medium';
}): { apply: boolean; skipReason?: EditorialSkipReason } {
  if (input.autonomy === 'review_only') return { apply: false, skipReason: 'review_only' };
  if (input.autonomy === 'propose_only') return { apply: false, skipReason: 'propose_only' };
  if (!input.sourceCurrent) return { apply: false, skipReason: 'source_revision_stale' };
  if (!input.sourceMatches) return { apply: false, skipReason: 'source_text_mismatch' };
  if (!input.hardInvariantsPassed) return { apply: false, skipReason: 'hard_invariant_failed' };
  if (!input.withinBudget) return { apply: false, skipReason: 'change_budget_exceeded' };
  const allowed = input.maximumRisk ?? (input.autonomy === 'max_quality_auto' ? 'medium' : 'low');
  if (riskRank[input.risk] > riskRank[allowed]) return { apply: false, skipReason: 'risk_exceeds_policy' };
  if (!input.judgesAgree) return { apply: false, skipReason: 'judge_disagreement' };
  if (input.confidence < EDITORIAL_LIMITS.minimumConfidence) return { apply: false, skipReason: 'confidence_below_threshold' };
  if (input.preferenceMargin < EDITORIAL_LIMITS.minimumPreferenceMargin) return { apply: false, skipReason: 'preference_margin_too_small' };
  if (!input.materialImprovement) return { apply: false, skipReason: 'no_material_improvement' };
  return { apply: true };
}
