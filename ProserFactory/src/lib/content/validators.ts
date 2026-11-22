import { stripThinkingBlocks } from '../ai/sanitize';
import { getPrompt, interpolatePromptByKey } from '@/prompts/service';

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

export function hasBannedPlaceholders(text: string): boolean {
  if (!text) return false;
  const banned = /(\<character\>|\{\{[^}]+\}\}|\<[^>]+\>|```[\s\S]*?```)/i;
  return banned.test(text);
}

export function validatePOV(text: string, pov: 'first'|'second'|'third'): boolean {
  const raw = (text || '').toLowerCase();
  // downweight quoted dialogue which can contain mixed pronouns
  const t = raw.replace(/"[^"\n]*"/g, ' ');
  const count = (re: RegExp) => (t.match(re) || []).length;
  // pronoun sets
  const first = count(/\b(i|my|me|mine|we|our|us|ours)\b/g) + count(/\b(i\s+(am|was|feel|think))\b/g) * 2;
  const second = count(/\b(you|your|yours|yourself|yourselves)\b/g) + count(/\b(you\s+(are|were|feel|think))\b/g) * 2;
  const third = count(/\b(he|she|they|him|her|them|his|hers|theirs)\b/g);
  const max = Math.max(first, second, third);
  const sorted = [first, second, third].sort((a,b)=>b-a);
  const marginOk = sorted[0] >= sorted[1] + 1 && sorted[0] >= 3; // require at least 3 hits and > next by 1
  if (!marginOk || max === 0) return true; // inconclusive => do not fail
  const winner = max === first ? 'first' : max === second ? 'second' : 'third';
  return winner === pov;
}

export function validateTense(text: string, tense: 'past'|'present'): boolean {
  const raw = (text || '').toLowerCase();
  const t = raw.replace(/"[^"\n]*"/g, ' ');
  const count = (re: RegExp) => (t.match(re) || []).length;
  // auxiliaries and endings
  const presAux = count(/\b(is|are|am|has|have|do|does|say|says)\b/g);
  const presProg = count(/\b(is|are|am)\s+\w+ing\b/g) * 2; // weight progressive higher
  const pres3rd = count(/\b(he|she|it)\s+\w+s\b/g);
  const presentHits = presAux + presProg + pres3rd;

  const pastAux = count(/\b(was|were|had|did|said|went)\b/g);
  const pastProg = count(/\b(was|were)\s+\w+ing\b/g) * 2;
  const pastEd = count(/\b\w+ed\b/g);
  const pastHits = pastAux + pastProg + pastEd;

  if (presentHits === 0 && pastHits === 0) return true; // inconclusive
  const marginOk = Math.abs(presentHits - pastHits) >= 2; // demand some margin
  if (!marginOk) return true;
  return tense === 'present' ? presentHits > pastHits : pastHits > presentHits;
}

export function sanitizeArtifacts(text: string): string {
  let out = stripThinkingBlocks(text || '');
  // remove stray code fences
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''));
  return out.trim();
}

/**
 * Strip markdown formatting from a title string.
 * Removes: heading markers (#), bold and italic markers,
 * surrounding quotes, leading list markers, and collapses whitespace.
 */
export function cleanTitle(raw: string): string {
  let t = (raw || '').trim();
  // Remove leading heading markers (e.g. "# Title" or "## Title")
  t = t.replace(/^#{1,6}\s+/, '');
  // Remove bold/italic markers
  t = t.replace(/\*{1,3}/g, '');
  // Remove underline bold/italic markers
  t = t.replace(/_{1,3}/g, ' ');
  // Remove surrounding double or single quotes
  t = t.replace(/^["\u0027]+|["\u0027]+$/g, '');
  // Remove leading list markers (- or *)
  t = t.replace(/^[-*]\s+/, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function ensureMinWords(text: string, min: number): boolean {
  return countWords(text) >= min;
}

export interface RepairConstraints { pov?: 'first'|'second'|'third'; tense?: 'past'|'present'; minWords?: number }

export async function repairProse(original: string, _c: RepairConstraints, generate: (prompt: string) => Promise<string>): Promise<string> {
  const template = getPrompt('prose-repair');
  let prompt: string;
  
  if (!template) {
    // Fallback to hardcoded prompt if centralized one is not found
    prompt = `Revise the following scene to remove placeholders and minor artifacts. Keep voice and meaning. Output only the revised prose.\n\n---\n${original}\n---`;
  } else {
    prompt = interpolatePromptByKey('prose-repair', {
      originalText: original
    });
  }
  
  try { 
    const revised = await generate(prompt); 
    return sanitizeArtifacts(revised); 
  } catch { 
    return original; 
  }
}

// Lightweight validator to check beats JSON shape without Ajv (for unit tests and quick checks)
export function validateBeatsJson(text: string): boolean {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return false;
    if (!Array.isArray(obj.beats) || obj.beats.length < 3) return false;
    if (!obj.beats.every((b: unknown) => typeof b === 'string' && b.trim().length > 0)) return false;
    if (obj.pov !== undefined && typeof obj.pov !== 'string') return false;
    if (obj.tense !== undefined && typeof obj.tense !== 'string') return false;
    if (obj.target_words !== undefined && typeof obj.target_words !== 'number') return false;
    return true;
  } catch { return false; }
}
