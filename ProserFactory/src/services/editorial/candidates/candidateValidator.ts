import type { EditorialPassDefinition } from '../contracts';
import { verifyCandidate } from '../editorialVerificationService';
import { normalizeCandidate } from './candidateNormalizer';

export function validateGeneratedCandidate(input: {
  value: string;
  original: string;
  sourceHash: string;
  pass: EditorialPassDefinition;
  protectedElements: string[];
  references?: string[];
  maximumEditPercent: number;
}) {
  const normalized = normalizeCandidate(input.value);
  const verification = verifyCandidate({
    original: input.original,
    candidate: normalized,
    expectedSourceHash: input.sourceHash,
    protectedElements: input.protectedElements,
    references: input.references,
    maxChangedPercent: input.maximumEditPercent,
    allowNewNames: input.pass.key === 'name_originality',
  });
  return { normalized, verification };
}
