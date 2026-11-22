import type { EditorialSkipReason } from '@/services/editorial/contracts';
import { normalizeTerminalProposalOutcome } from '@/services/editorial/editorialWorkflowService';

describe('editorial terminal proposal outcomes', () => {
  const skipReasons: Array<EditorialSkipReason | undefined> = [
    undefined,
    'original_wins',
    'no_clear_winner',
    'risk_exceeds_policy',
    'change_budget_exceeded',
  ];
  const verdicts = ['candidate_wins', 'original_wins', 'no_clear_winner'] as const;

  it.each(
    [false, true].flatMap((applied) =>
      skipReasons.flatMap((skipReason) =>
        verdicts.map((verdict) => ({ applied, skipReason, verdict })),
      ),
    ),
  )('normalizes applied=$applied skip=$skipReason verdict=$verdict exactly once', ({
    applied,
    skipReason,
    verdict,
  }) => {
    const outcome = normalizeTerminalProposalOutcome(applied, skipReason, verdict);
    expect(['candidate_wins', 'original_wins', 'no_clear_winner', 'policy_skip']).toContain(outcome);
    if (applied) expect(outcome).toBe('candidate_wins');
    else if (skipReason === 'original_wins' || verdict === 'original_wins') expect(outcome).toBe('original_wins');
    else if (verdict === 'no_clear_winner') expect(outcome).toBe('no_clear_winner');
    else expect(outcome).toBe('policy_skip');
  });
});
