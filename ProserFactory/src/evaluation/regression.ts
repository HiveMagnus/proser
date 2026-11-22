import { createHash } from 'node:crypto';

import corpus from './corpus/long-form-v1.json';
import { evaluateLiteraryText } from '@/services/literaryEvaluationService';

export interface PairwiseResult {
  blindIds: { A: string; B: string };
  winner: 'A' | 'B' | 'tie';
  margin: number;
  rationale: Array<{ dimension: string; a: number; b: number }>;
}

/** Selector sees only blinded prose and contract context, never generation metadata. */
export function compareCandidatesPairwise(candidateA: string, candidateB: string, genre?: string): PairwiseResult {
  const a = evaluateLiteraryText(candidateA, { genre });
  const b = evaluateLiteraryText(candidateB, { genre });
  const margin = Math.round((a.overallScore - b.overallScore) * 10) / 10;
  return {
    blindIds: { A: createHash('sha256').update(candidateA).digest('hex').slice(0, 12), B: createHash('sha256').update(candidateB).digest('hex').slice(0, 12) },
    winner: Math.abs(margin) < 0.5 ? 'tie' : margin > 0 ? 'A' : 'B',
    margin: Math.abs(margin),
    rationale: a.dimensions.map((dimension, index) => ({ dimension: dimension.dimension, a: dimension.score, b: b.dimensions[index].score })),
  };
}

export function runLongFormRegression() {
  const results = corpus.cases.map((testCase) => {
    const selection = compareCandidatesPairwise(testCase.candidateA, testCase.candidateB, testCase.genre);
    return { id: testCase.id, expectedWinner: testCase.expectedWinner, selection, pass: selection.winner === testCase.expectedWinner, invariants: testCase.invariants };
  });
  return { corpusVersion: corpus.version, cases: results, passed: results.filter((result) => result.pass).length, total: results.length, pass: results.every((result) => result.pass) };
}

