import type { EditorialAutonomy } from '../contracts';
import type { BlindJudgeResult } from './blindPairwiseJudge';

export function escalationDecision(input: {
  autonomy: EditorialAutonomy;
  results: BlindJudgeResult[];
  maximumEscalations: number;
  minimumConfidence: number;
  minimumMargin: number;
  inferenceBudgetRemaining: boolean;
}): { action: 'accept' | 'retain_original' | 'run_second' | 'run_tiebreaker'; reason: string } {
  const last = input.results.at(-1);
  if (!last || !input.inferenceBudgetRemaining) return { action: 'retain_original', reason: 'inference_budget_exhausted' };
  if (input.results.length === 1 && last.verdict === 'original_wins' && last.confidence >= input.minimumConfidence) return { action: 'retain_original', reason: 'original_wins' };
  if (input.results.length === 1 && last.verdict === 'candidate_wins' && last.confidence >= input.minimumConfidence && last.preferenceMargin >= input.minimumMargin) return { action: 'accept', reason: 'clear_candidate_win' };
  if (input.results.length === 1 && input.maximumEscalations >= 1) return { action: 'run_second', reason: 'close_or_uncertain' };
  const candidateWins = input.results.filter((item) => item.verdict === 'candidate_wins').length;
  const originalWins = input.results.filter((item) => item.verdict === 'original_wins').length;
  if (candidateWins >= 2) return { action: 'accept', reason: 'two_concurring_candidate_votes' };
  if (originalWins >= 1 || input.autonomy === 'safe_auto') return { action: 'retain_original', reason: 'judge_disagreement' };
  if (input.autonomy === 'max_quality_auto' && input.results.length === 2 && input.maximumEscalations >= 2) return { action: 'run_tiebreaker', reason: 'bounded_tiebreaker' };
  return { action: 'retain_original', reason: 'no_clear_winner' };
}
