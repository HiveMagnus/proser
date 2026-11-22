import { randomUUID } from 'node:crypto';

import type { EditorialFinding } from '../contracts';
import { normalizeProperNoun } from './properNounDetector';

const defaultCliches = ['john smith', 'jane doe', 'jack steel', 'raven black', 'luna night'];

const bare = (value: string) =>
  normalizeProperNoun(value).replace(/^(?:mr|mrs|ms|miss|dr|sir|lady|captain)\.?\s+/, '');
const parts = (value: string) => bare(value).split(/\s+/).filter(Boolean);
const consonants = (value: string) => bare(value).replace(/[aeiouy\W_]/g, '');
const bigrams = (value: string) => {
  const normalized = bare(value).replace(/\s+/g, '');
  return new Set([...normalized].slice(0, -1).map((letter, index) => letter + normalized[index + 1]));
};
const jaccard = (left: Set<string>, right: Set<string>) => {
  const overlap = [...left].filter((item) => right.has(item)).length;
  return overlap / Math.max(1, left.size + right.size - overlap);
};

export function editDistance(left: string, right: string): number {
  const a = [...bare(left)];
  const b = [...bare(right)];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prior = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prior + (a[i - 1] === b[j - 1] ? 0 : 1));
      prior = saved;
    }
  }
  return row[b.length];
}

export function nameCollisionScore(left: string, right: string): {
  score: number;
  evidence: string[];
} {
  const a = bare(left);
  const b = bare(right);
  if (!a || !b || a === b) return { score: a === b && a ? 1 : 0, evidence: a === b && a ? ['exact normalized match'] : [] };
  const leftParts = parts(a);
  const rightParts = parts(b);
  const distance = editDistance(a, b) / Math.max(a.length, b.length);
  const evidence: string[] = [];
  let score = (1 - distance) * 0.42 + jaccard(bigrams(a), bigrams(b)) * 0.28;
  if (consonants(a) === consonants(b)) { score += 0.22; evidence.push('same consonant skeleton'); }
  if (a[0] === b[0]) { score += 0.08; evidence.push('same initial'); }
  if (a.slice(-2) === b.slice(-2)) { score += 0.08; evidence.push('same ending'); }
  if (leftParts.some((item) => rightParts.includes(item))) { score += 0.18; evidence.push('shared name component'); }
  if (Math.abs(a.length - b.length) <= 1) evidence.push('similar visual length');
  if (distance <= 0.34) evidence.push('small edit distance');
  return { score: Math.min(1, score), evidence };
}

export function analyzeNames(input: {
  names: Array<{ name: string; sceneId?: number }>;
  crossBookNames?: string[];
  clicheNames?: string[];
}): EditorialFinding[] {
  const findings: EditorialFinding[] = [];
  const unique = [...new Map(input.names.map((item) => [bare(item.name), item])).values()];
  for (let left = 0; left < unique.length; left += 1) {
    for (let right = left + 1; right < unique.length; right += 1) {
      const collision = nameCollisionScore(unique[left].name, unique[right].name);
      if (collision.score < 0.62) continue;
      findings.push({
        id: randomUUID(), detectorKey: 'name_originality_v1', detectorVersion: '1.0.0',
        category: 'name_collision', severity: collision.score > 0.8 ? 'high' : 'medium',
        confidence: collision.score,
        rationale: `"${unique[left].name}" and "${unique[right].name}" may be confused: ${collision.evidence.join(', ')}.`,
        recommendation: 'Consider a culturally and project-appropriate alternative; no name is objectively bad.',
        risk: 'high', autofixEligible: false, evidence: [], protectedClaims: [unique[left].name, unique[right].name],
        sceneId: unique[left].sceneId,
      });
    }
  }
  const used = new Set(unique.map((item) => bare(item.name)));
  for (const name of input.crossBookNames ?? []) if (used.has(bare(name))) {
    findings.push({
      id: randomUUID(), detectorKey: 'name_originality_v1', detectorVersion: '1.0.0',
      category: 'cross_book_name_reuse', severity: 'low', confidence: 0.9,
      rationale: `"${name}" is reused in another non-deleted book owned by this author.`,
      recommendation: 'Review reuse in project context; reuse alone is not a quality failure.',
      risk: 'high', autofixEligible: false, evidence: [], protectedClaims: [name],
    });
  }
  const cliches = new Set([...(input.clicheNames ?? []), ...defaultCliches].map(bare));
  for (const item of unique) if (cliches.has(bare(item.name))) {
    findings.push({
      id: randomUUID(), detectorKey: 'name_originality_v1', detectorVersion: '1.0.0',
      category: 'configured_name_predictability', severity: 'low', confidence: 0.75,
      rationale: `"${item.name}" matches the versioned project predictability list.`,
      recommendation: 'Return evidence and alternatives in proposal modes; do not auto-rename.',
      risk: 'high', autofixEligible: false, evidence: [], protectedClaims: [item.name], sceneId: item.sceneId,
    });
  }
  return findings.slice(0, 100);
}
