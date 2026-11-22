import { EDITORIAL_LIMITS } from './editorialPolicy';
import { placeholderFailures, referenceOverlap } from './detectors/coreDetectors';
import { changedPercent } from './textDiff';
import { textHash } from './textAnchors';
import { compareStyleFingerprints } from './detectors/styleFingerprintDetector';

const properNouns = (text: string) =>
  new Set([...text.matchAll(/(?<![.!?]\s)(?<!^)\b\p{Lu}[\p{L}’'-]{2,}\b/gu)].map((match) => match[0].normalize('NFKC')));
const values = (text: string) =>
  new Set(text.match(/\b(?:\d+(?:[.,]\d+)?|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:January|February|March|April|May|June|July|August|September|October|November|December))\b/gi) ?? []);

export interface VerificationResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  sourceHash: string;
  candidateHash: string;
  changedPercent: number;
  referenceOverlap: number;
  styleDrift: number;
}

export function verifyCandidate(input: {
  original: string;
  candidate: string;
  expectedSourceHash: string;
  protectedElements?: string[];
  references?: string[];
  maxChangedPercent: number;
  allowNewNames?: boolean;
}): VerificationResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const sourceHash = textHash(input.original);
  const candidateHash = textHash(input.candidate);
  if (sourceHash !== input.expectedSourceHash) failures.push('source_text_mismatch');
  if (!input.candidate.trim()) failures.push('empty_candidate');
  failures.push(...placeholderFailures(input.candidate).map((item) => `placeholder:${item}`));
  for (const protectedElement of input.protectedElements ?? []) {
    if (input.original.includes(protectedElement) && !input.candidate.includes(protectedElement)) failures.push(`protected_element_removed:${protectedElement.slice(0, 80)}`);
  }
  const originalValues = values(input.original);
  for (const value of originalValues) if (!values(input.candidate).has(value)) failures.push(`protected_value_changed:${value}`);
  if (!input.allowNewNames) {
    const sourceNames = properNouns(input.original);
    for (const name of properNouns(input.candidate)) if (!sourceNames.has(name)) failures.push(`unexplained_named_entity:${name}`);
  }
  const percent = changedPercent(input.original, input.candidate);
  if (percent > input.maxChangedPercent) failures.push('change_budget_exceeded');
  const overlap = Math.max(0, ...(input.references ?? []).map((reference) => referenceOverlap(input.candidate, reference)));
  if (overlap > EDITORIAL_LIMITS.referenceOverlapThreshold) failures.push('reference_overlap');
  const comparison = compareStyleFingerprints(input.original, input.candidate);
  const styleDrift = comparison.distance;
  if (comparison.flattened || comparison.voiceConvergence) failures.push('style_voice_flattening');
  if (styleDrift > 0.3) failures.push('style_fingerprint_drift');
  else if (styleDrift > 0.18) warnings.push('style_fingerprint_drift_near_limit');
  return { passed: failures.length === 0, failures, warnings, sourceHash, candidateHash, changedPercent: percent, referenceOverlap: overlap, styleDrift };
}
