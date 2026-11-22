import { randomUUID } from 'node:crypto';

import type { EditorialFinding } from '../contracts';

export const normalizeProperNoun = (value: string) =>
  value.normalize('NFKC').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export function extractProperNouns(text: string): Array<{ value: string; normalized: string; start: number; end: number }> {
  return [...text.matchAll(/\b(?:\p{Lu}[\p{L}’'-]{1,})(?:\s+\p{Lu}[\p{L}’'-]{1,}){0,2}\b/gu)]
    .filter((match) => match.index !== undefined)
    .map((match) => ({
      value: match[0],
      normalized: normalizeProperNoun(match[0]),
      start: match.index!,
      end: match.index! + match[0].length,
    }));
}

export function detectProperNounChanges(source: string, candidate: string, allowed: string[] = []): EditorialFinding[] {
  const sourceNames = new Set(extractProperNouns(source).map((item) => item.normalized));
  const allowedNames = new Set(allowed.map(normalizeProperNoun));
  return extractProperNouns(candidate)
    .filter((item) => !sourceNames.has(item.normalized) && !allowedNames.has(item.normalized))
    .slice(0, 20)
    .map((item) => ({
      id: randomUUID(),
      detectorKey: 'proper_noun_v1',
      detectorVersion: '1.0.0',
      category: 'unexplained_named_entity',
      severity: 'high',
      confidence: 0.95,
      rationale: `"${item.value}" is new in the replacement span and lacks canonical evidence.`,
      recommendation: 'Retain the original name unless the active pass explicitly proves a rename.',
      risk: 'high',
      autofixEligible: false,
      evidence: [{ start: item.start, end: item.end, text: item.value }],
      protectedClaims: [],
    }));
}
