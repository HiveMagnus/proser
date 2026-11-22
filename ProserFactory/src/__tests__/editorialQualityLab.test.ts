import { runDocumentBenchmark } from '@/services/editorial/qualityLab/documentBenchmark';
import { scoreBenchmark } from '@/services/editorial/qualityLab/benchmarkScoring';
import { loadCorpus, loadHiddenExpected, validateCorpus } from '@/services/editorial/qualityLab/corpusLoader';

describe('editorial Quality Lab', () => {
  it('passes the complete pinned structured-document corpus without provider access', async () => {
    const report = await runDocumentBenchmark();
    expect(report.passed).toBe(true); expect(report.caseCount).toBe(16); expect(report.liveCalls).toBe(0);
  });
  it('validates versioned source fixtures and scorer-isolated hidden outcomes', async () => {
    const validation = await validateCorpus();
    expect(validation.valid).toBe(true);
    expect(validation.caseCount).toBeGreaterThanOrEqual(5);
    const corpus = await loadCorpus();
    expect(JSON.stringify(corpus.cases)).not.toContain('expectedVerdict');
    expect((await loadHiddenExpected(corpus.cases[0].id)).expectedVerdict).toMatch(/wins/);
  });

  it('computes release and evaluator-gaming metrics deterministically', () => {
    const metrics = scoreBenchmark([
      { verdict: 'original_wins', expectedMatch: true, hardInvariantCorrect: true, expectedOriginal: true, retainedOriginal: true, latencyMs: 5, inferenceTokens: 0, changedWords: 0, escalated: false, position: 'a', originalWords: 20, candidateWords: 35 },
      { verdict: 'candidate_wins', expectedMatch: true, hardInvariantCorrect: true, expectedOriginal: false, retainedOriginal: false, latencyMs: 7, inferenceTokens: 10, changedWords: 3, escalated: true, position: 'b', originalWords: 20, candidateWords: 19 },
    ]);
    expect(metrics.hardInvariantPassRate).toBe(1);
    expect(metrics.originalRetentionAccuracy).toBe(1);
    expect(metrics.autoApplyPrecision).toBe(1);
    expect(metrics.p95LatencyMs).toBeGreaterThan(0);
    expect(metrics.escalationRate).toBe(0.5);
  });
});
