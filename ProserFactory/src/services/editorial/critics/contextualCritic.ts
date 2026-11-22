import { randomUUID } from 'node:crypto';

import { placeholderFailures } from '../detectors/coreDetectors';
import type { CriticInput, CriticResult } from './criticContracts';

/**
 * Deterministic structured critic used as the resilient baseline. Configured model
 * critics may enrich this contract, but malformed/failed optional critics never block a run.
 */
export function runContextualCritic(input: CriticInput): CriticResult {
  const findings = [];
  if (input.proseExcerpt.length > 4_000) throw new Error('EDITORIAL_CRITIC_CONTEXT_BUDGET_EXCEEDED');
  const vague = [...input.proseExcerpt.matchAll(/\b(?:thing|something|somehow|very|really)\b/gi)].slice(0, input.maximumFindings);
  for (const match of vague) findings.push({
    id: randomUUID(), detectorKey: input.profile, detectorVersion: '1.0.0',
    category: 'critic_specificity', severity: 'low' as const, confidence: 0.68,
    rationale: `"${match[0]}" may be underspecific in the supplied passage.`,
    recommendation: 'Consider a local, evidence-preserving alternative; abstain when specificity would invent facts.',
    risk: 'low' as const, autofixEligible: input.profile === 'line_editor_v1',
    evidence: [{ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0] }],
    protectedClaims: input.protectedElements, sceneId: input.scopeId,
  });
  if (placeholderFailures(input.proseExcerpt).length) findings.length = 0;
  return {
    profile: input.profile,
    version: '1.0.0',
    abstained: findings.length === 0,
    findings: findings.slice(0, input.maximumFindings),
    inputHash: input.inputHash,
  };
}
