import type { BlindJudgeResult } from './blindPairwiseJudge';

const bounded = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

export function normalizeJudgeResult(value: BlindJudgeResult): BlindJudgeResult {
  if (!['candidate_wins', 'original_wins', 'no_clear_winner', 'invalid_comparison'].includes(value.verdict)) {
    throw new Error('EDITORIAL_JUDGE_INVALID_VERDICT');
  }
  if (!bounded(value.confidence) || !bounded(value.preferenceMargin)) throw new Error('EDITORIAL_JUDGE_SCORE_OUT_OF_BOUNDS');
  if (value.verdict === 'no_clear_winner' && value.preferredLabel !== null) throw new Error('EDITORIAL_JUDGE_SELF_CONTRADICTION');
  if ((value.verdict === 'candidate_wins' || value.verdict === 'original_wins') && !value.preferredLabel) throw new Error('EDITORIAL_JUDGE_MISSING_LABEL');
  for (const score of Object.values(value.dimensionScores)) {
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('EDITORIAL_JUDGE_DIMENSION_OUT_OF_BOUNDS');
  }
  return {
    ...value,
    rationale: value.rationale.slice(0, 2_000),
    evidence: value.evidence.filter(Boolean).slice(0, 8),
    invariantConcerns: value.invariantConcerns.filter(Boolean).slice(0, 20),
  };
}
