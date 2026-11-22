import { createHash } from 'node:crypto';

import { evaluateLiteraryText } from '@/services/literaryEvaluationService';

import type { EditorialRisk } from '../contracts';
import { changedPercent } from '../textDiff';
import { verifyCandidate } from '../editorialVerificationService';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export interface BlindJudgeResult {
  verdict: 'candidate_wins' | 'original_wins' | 'no_clear_winner' | 'invalid_comparison';
  preferredLabel: string | null;
  confidence: number;
  preferenceMargin: number;
  dimensionScores: Record<string, number>;
  invariantConcerns: string[];
  evidence: string[];
  rationale: string;
}

export interface StoredBlindEvaluation {
  result: BlindJudgeResult;
  candidateOrder: string[];
  preferredCandidateId: string | null;
  risk: EditorialRisk;
  judgeCount?: number;
  judgesAgree?: boolean;
}

/** Deterministic, identity-blind baseline judge used in CI and as a safety voter. */
export function blindPairwiseJudge(input: {
  proposalId: string;
  original: { id: string; text: string };
  candidate: { id: string; text: string };
  protectedElements: string[];
  expectedSourceHash: string;
  maximumEditPercent: number;
  seed?: string;
}): StoredBlindEvaluation {
  const reverse = Number.parseInt(hash(`${input.seed ?? input.proposalId}:order`).slice(0, 2), 16) % 2 === 1;
  const ordered = reverse ? [input.candidate, input.original] : [input.original, input.candidate];
  const labels = ['Option A', 'Option B'];
  const labelById = new Map(ordered.map((item, index) => [item.id, labels[index]]));
  const verification = verifyCandidate({
    original: input.original.text,
    candidate: input.candidate.text,
    expectedSourceHash: input.expectedSourceHash,
    protectedElements: input.protectedElements,
    maxChangedPercent: input.maximumEditPercent,
  });
  if (!verification.passed) return {
    result: {
      verdict: 'original_wins', preferredLabel: labelById.get(input.original.id) ?? null,
      confidence: 1, preferenceMargin: 1, dimensionScores: {},
      invariantConcerns: verification.failures, evidence: [],
      rationale: 'The alternative failed deterministic invariants before preference judging.',
    },
    candidateOrder: ordered.map((item) => item.id),
    preferredCandidateId: input.original.id,
    risk: 'high',
  };
  const originalScore = evaluateLiteraryText(input.original.text);
  const candidateScore = evaluateLiteraryText(input.candidate.text);
  const rawDifference = candidateScore.overallScore - originalScore.overallScore;
  const verbosityPenalty = Math.max(0, input.candidate.text.length / Math.max(1, input.original.text.length) - 1.08) * 20;
  const difference = rawDifference - verbosityPenalty;
  const margin = Math.min(1, Math.abs(difference) / 25);
  const confidence = Math.min(0.98, 0.7 + Math.abs(difference) / 30);
  const material = Math.abs(difference) >= 2;
  const winner = difference > 0 ? input.candidate.id : input.original.id;
  const verdict = !material ? 'no_clear_winner' : difference > 0 ? 'candidate_wins' : 'original_wins';
  const dimensionScores = Object.fromEntries(candidateScore.dimensions.map((row) => [row.dimension, row.score]));
  const changed = changedPercent(input.original.text, input.candidate.text);
  return {
    result: {
      verdict,
      preferredLabel: material ? labelById.get(winner) ?? null : null,
      confidence,
      preferenceMargin: margin,
      dimensionScores,
      invariantConcerns: [],
      evidence: candidateScore.findings.flatMap((item) => item.evidence.map((entry) => entry.text)).slice(0, 5),
      rationale: material
        ? `Blind rubric difference ${difference.toFixed(1)} after length adjustment.`
        : 'The bounded quality difference is not material enough to justify risk.',
    },
    candidateOrder: ordered.map((item) => item.id),
    preferredCandidateId: material ? winner : null,
    risk: changed <= 10 ? 'low' : changed <= 18 ? 'medium' : 'high',
  };
}
