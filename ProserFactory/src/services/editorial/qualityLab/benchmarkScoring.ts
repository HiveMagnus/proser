export interface BenchmarkCaseScore {
  verdict: string;
  expectedMatch: boolean;
  hardInvariantCorrect: boolean;
  expectedOriginal: boolean;
  retainedOriginal: boolean;
  latencyMs: number;
  inferenceTokens: number;
  changedWords: number;
  escalated: boolean;
  position: 'a' | 'b';
  originalWords: number;
  candidateWords: number;
  referenceCopyDetected?: boolean;
  styleFlatteningDetected?: boolean;
  voicePreserved?: boolean;
  nameCollisionDetected?: boolean;
  skipReason?: string;
  providerFailed?: boolean;
}

const rate = (rows: boolean[]) => rows.length ? rows.filter(Boolean).length / rows.length : 1;
const percentile = (rows: number[], value: number) => {
  if (!rows.length) return 0;
  const ordered = [...rows].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * value))];
};

export function scoreBenchmark(rows: BenchmarkCaseScore[]) {
  const originalCases = rows.filter((row) => row.expectedOriginal);
  const candidateWins = rows.filter((row) => row.verdict === 'candidate_wins');
  const latencies = rows.map((row) => row.latencyMs);
  const tokens = rows.map((row) => row.inferenceTokens);
  return {
    caseCount: rows.length,
    hardInvariantPassRate: rate(rows.map((row) => row.hardInvariantCorrect)),
    originalRetentionAccuracy: rate(originalCases.map((row) => row.retainedOriginal)),
    autoApplyPrecision: rate(candidateWins.map((row) => row.expectedMatch)),
    improvementAcceptanceRate: candidateWins.length / Math.max(1, rows.length),
    regressionRate: 1 - rate(rows.map((row) => row.expectedMatch)),
    expectedMatchRate: rate(rows.map((row) => row.expectedMatch)),
    falsePositiveRate: rate(rows.filter((row) => row.expectedOriginal).map((row) => !row.retainedOriginal)),
    falseNegativeRate: rate(rows.filter((row) => !row.expectedOriginal).map((row) => row.retainedOriginal)),
    judgeAgreement: rate(rows.map((row) => !row.escalated)),
    judgeAbstention: rows.filter((row) => row.verdict === 'no_clear_winner').length / Math.max(1, rows.length),
    positionBias: Math.abs(rows.filter((row) => row.position === 'a' && row.verdict === 'candidate_wins').length - rows.filter((row) => row.position === 'b' && row.verdict === 'candidate_wins').length) / Math.max(1, rows.length),
    lengthBias: candidateWins.reduce((sum, row) => sum + row.candidateWords / Math.max(1, row.originalWords), 0) / Math.max(1, candidateWins.length),
    meanLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    meanInferenceTokens: tokens.reduce((sum, value) => sum + value, 0) / Math.max(1, tokens.length),
    p95InferenceTokens: percentile(tokens, 0.95),
    escalationRate: rows.filter((row) => row.escalated).length / Math.max(1, rows.length),
    changesPerThousandWords: rows.reduce((sum, row) => sum + row.changedWords, 0) / Math.max(1, rows.reduce((sum, row) => sum + row.originalWords, 0)) * 1_000,
    referenceCopyDetectionRate: rate(rows.filter((row) => row.referenceCopyDetected !== undefined).map((row) => Boolean(row.referenceCopyDetected))),
    styleFlatteningDetectionRate: rate(rows.filter((row) => row.styleFlatteningDetected !== undefined).map((row) => Boolean(row.styleFlatteningDetected))),
    characterVoicePreservationRate: rate(rows.filter((row) => row.voicePreserved !== undefined).map((row) => Boolean(row.voicePreserved))),
    nameCollisionDetectionRate: rate(rows.filter((row) => row.nameCollisionDetected !== undefined).map((row) => Boolean(row.nameCollisionDetected))),
    skippedProposalReasons: Object.fromEntries([...new Set(rows.map((row) => row.skipReason).filter(Boolean))].map((reason) => [
      reason!,
      rows.filter((row) => row.skipReason === reason).length,
    ])),
  };
}
