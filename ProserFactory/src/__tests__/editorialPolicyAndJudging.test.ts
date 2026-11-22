import { editorialOptimizeSchema } from '@/api/schemas/editorial';
import { verifyCandidate } from '@/services/editorial/editorialVerificationService';
import { decideApplication, resolveBudget } from '@/services/editorial/editorialPolicy';
import { getEditorialPass, validatePassRegistry } from '@/services/editorial/passRegistry';
import { anchors, resolveAnchor, sentences, textHash, tokenize } from '@/services/editorial/textAnchors';
import { applyPatch, changedPercent } from '@/services/editorial/textDiff';
import { normalizeCandidate } from '@/services/editorial/candidates/candidateNormalizer';
import { blindPairwiseJudge } from '@/services/editorial/judging/blindPairwiseJudge';
import { normalizeJudgeResult } from '@/services/editorial/judging/evaluationNormalizer';
import { escalationDecision } from '@/services/editorial/judging/judgeEscalation';

describe('editorial policy, candidates, and blind arbitration', () => {
  it('keeps Unicode code-unit offsets stable and rejects ambiguous anchors', () => {
    const text = 'Mara saw 🌘 moonlight. Mara saw 🌘 moonlight.';
    expect(tokenize(text)[2].text).toBe('moonlight');
    const span = sentences(text)[0];
    const anchor = anchors(text, span.start, span.end);
    expect(resolveAnchor(text, { originalText: span.text, startOffset: span.start, endOffset: span.end, ...anchor })).toEqual({ start: span.start, end: span.end });
    expect(resolveAnchor(text, { originalText: 'Mara', startOffset: 999, endOffset: 1003, sourceHash: textHash('Mara') })).toBeNull();
    expect(applyPatch('abc', 1, 2, 'Z')).toBe('aZc');
    expect(changedPercent('one two', 'one three')).toBeGreaterThan(0);
  });

  it('validates all pass packs and caps caller budgets', () => {
    expect(validatePassRegistry()).toEqual({ valid: true, errors: [] });
    expect(getEditorialPass('final_polish').version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolveBudget('safe_auto', { maxChangedWordsPercentPerScene: 99 }).maxChangedWordsPercentPerScene).toBeLessThanOrEqual(18);
  });

  it('rejects unsafe custom structural objectives', () => {
    expect(editorialOptimizeSchema.safeParse({
      bookId: 1, scope: { type: 'book' }, passPack: 'custom', autonomy: 'safe_auto',
      objective: 'Rewrite the entire book and add a scene',
    }).success).toBe(false);
  });

  it('preserves the original for disagreement, low confidence, or invariant failure', () => {
    expect(decideApplication({
      autonomy: 'safe_auto', risk: 'low', confidence: 0.7, preferenceMargin: 0.2,
      hardInvariantsPassed: true, withinBudget: true, materialImprovement: true,
      judgesAgree: true, sourceCurrent: true, sourceMatches: true,
    }).apply).toBe(false);
    expect(escalationDecision({
      autonomy: 'safe_auto',
      results: [
        { verdict: 'candidate_wins', preferredLabel: 'Option A', confidence: 0.7, preferenceMargin: 0.1, dimensionScores: {}, invariantConcerns: [], evidence: [], rationale: '' },
        { verdict: 'original_wins', preferredLabel: 'Option B', confidence: 0.8, preferenceMargin: 0.2, dimensionScores: {}, invariantConcerns: [], evidence: [], rationale: '' },
      ],
      maximumEscalations: 2, minimumConfidence: 0.78, minimumMargin: 0.15,
      inferenceBudgetRemaining: true,
    })).toEqual({ action: 'retain_original', reason: 'judge_disagreement' });
  });

  it('normalizes generated prose and validates judge bounds', () => {
    expect(normalizeCandidate('```text\nReplacement: A clean line.\n```')).toBe('A clean line.');
    expect(() => normalizeJudgeResult({
      verdict: 'candidate_wins', preferredLabel: 'Option A', confidence: 2,
      preferenceMargin: 0.2, dimensionScores: {}, invariantConcerns: [], evidence: [], rationale: '',
    })).toThrow('EDITORIAL_JUDGE_SCORE_OUT_OF_BOUNDS');
  });

  it('randomizes persisted candidate order and blocks canon-breaking fluent alternatives', () => {
    const original = "Mara took her sister Elian's hand.";
    const result = blindPairwiseJudge({
      proposalId: 'proposal',
      original: { id: 'original-id', text: original },
      candidate: { id: 'candidate-id', text: "Mara took her brother Elian's hand." },
      protectedElements: ['sister'],
      expectedSourceHash: textHash(original),
      maximumEditPercent: 100,
    });
    expect(result.candidateOrder.sort()).toEqual(['candidate-id', 'original-id']);
    expect(result.result.verdict).toBe('original_wins');
    expect(result.result.invariantConcerns).not.toHaveLength(0);
  });

  it('blocks placeholder, protected-value, reference-copy, and budget regressions', () => {
    const source = 'Mara waited for 3 days beside the glass pear.';
    const result = verifyCandidate({
      original: source,
      candidate: 'Here is the revised passage: Mara waited for 4 nights beside a silver pear.',
      expectedSourceHash: textHash(source),
      protectedElements: ['glass pear'],
      references: ['Here is the revised passage Mara waited for four nights beside a silver pear'],
      maxChangedPercent: 10,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(['change_budget_exceeded']));
  });
});
