
export const LITERARY_DIMENSIONS = [
  'scenePurpose', 'causalMovement', 'characterization', 'dialogue',
  'emotionalChange', 'specificity', 'clarity', 'rhythm', 'originality',
  'continuity', 'genreFit', 'endingStrength',
] as const;

export interface RubricDimension {
  dimension: typeof LITERARY_DIMENSIONS[number];
  score: number;
  confidence: number;
  evidence: Array<{ start: number; end: number; text: string; rationale: string }>;
}
function clamp(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }
function tokenCount(text: string): number { return text.match(/\S+/g)?.length ?? 0; }
function count(text: string, pattern: RegExp): number { return text.match(pattern)?.length ?? 0; }
function evidence(text: string, pattern: RegExp, rationale: string) {
  const match = pattern.exec(text);
  const start = match?.index ?? Math.max(0, text.length - 260);
  const excerpt = match?.[0] ?? text.slice(start, start + 220);
  return [{ start, end: start + excerpt.length, text: excerpt.slice(0, 240), rationale }];
}
function sentenceLengths(text: string): number[] { return text.split(/(?<=[.!?])\s+/).filter(Boolean).map(tokenCount); }
function variance(values: number[]): number { if (!values.length) return 0; const mean = values.reduce((a, b) => a + b, 0) / values.length; return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length; }

/** Evidence-backed local rubric. It never uses draft/final labels or acceptance state. */
export function evaluateLiteraryText(text: string, context: { genre?: string | null; contract?: Record<string, unknown> } = {}) {
  const words = tokenCount(text);
  const dialogueCount = count(text, /[“"][^”"]{4,}[”"]/g);
  const causalCount = count(text, /\b(because|therefore|but|however|so that|forcing|which meant|consequently|unless)\b/gi);
  const choiceCount = count(text, /\b(chose|decided|refused|risked|wanted|needed|must|could not)\b/gi);
  const emotionCount = count(text, /\b(fear|afraid|anger|angry|hope|relief|grief|joy|shame|guilt|love|dread|panic|tender)\w*\b/gi);
  const sensoryCount = count(text, /\b(saw|heard|sound|smell|scent|taste|touch|felt|cold|warm|rough|smooth|bright|dark)\w*\b/gi);
  const concreteCount = count(text, /\b(door|hand|room|street|glass|wood|metal|rain|blood|coat|table|wall|floor|sky|river|stone)\b/gi);
  const passiveCount = count(text, /\b(was|were|been|being)\s+\w+ed\b/gi);
  const clichéCount = count(text, /\b(heart skipped a beat|let out a breath|time stood still|little did (?:he|she|they) know|piercing blue eyes)\b/gi);
  const lengths = sentenceLengths(text);
  const ending = text.slice(-Math.min(600, text.length));
  const endingPressure = count(ending, /[?!]|\b(but|until|unless|realized|decided|opened|arrived|gone|never|now)\b/gi);
  const purposeTerms = context.contract ? Object.values(context.contract).flatMap((value) => typeof value === 'string' ? value.toLowerCase().match(/[a-z]{5,}/g) ?? [] : []) : [];
  const purposeMatches = purposeTerms.slice(0, 30).filter((term) => text.toLowerCase().includes(term)).length;
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  const repeatedStarts = new Map<string, number>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) { const start = (sentence.toLowerCase().match(/^[^a-z]*([a-z]+\s+[a-z]+)/)?.[1]); if (start) repeatedStarts.set(start, (repeatedStarts.get(start) ?? 0) + 1); }
  const repetitionPenalty = [...repeatedStarts.values()].filter((value) => value >= 3).reduce((a, b) => a + b, 0);
  const quoteRatio = words ? dialogueCount / Math.max(1, words / 100) : 0;
  const dimensions: RubricDimension[] = [
    { dimension: 'scenePurpose', score: clamp(55 + Math.min(25, choiceCount * 4) + Math.min(20, purposeMatches * 3)), confidence: context.contract ? 0.88 : 0.62, evidence: evidence(text, /\b(chose|decided|refused|wanted|needed|must)\b[^.!?]{0,140}/i, 'Observable objective, choice, or refusal supports scene purpose.') },
    { dimension: 'causalMovement', score: clamp(48 + Math.min(45, causalCount * 6) + Math.min(10, choiceCount * 2)), confidence: 0.79, evidence: evidence(text, /\b(because|therefore|but|however|forcing|unless)\b[^.!?]{0,160}/i, 'Causal connector or reversal links events.') },
    { dimension: 'characterization', score: clamp(52 + Math.min(28, choiceCount * 4) + Math.min(18, dialogueCount * 2)), confidence: 0.73, evidence: evidence(text, /\b(chose|decided|refused|wanted|needed|risked)\b[^.!?]{0,180}/i, 'Choice and tactic reveal character under pressure.') },
    { dimension: 'dialogue', score: clamp(dialogueCount ? 58 + Math.min(30, quoteRatio * 8) - clichéCount * 4 : 62), confidence: dialogueCount ? 0.78 : 0.55, evidence: evidence(text, /[“"][^”"]{8,}[”"]/g, dialogueCount ? 'Dialogue is evaluated for presence and distribution.' : 'No dialogue was required by the supplied contract.') },
    { dimension: 'emotionalChange', score: clamp(50 + Math.min(40, emotionCount * 5) + Math.min(10, endingPressure * 2)), confidence: 0.69, evidence: evidence(text, /\b(fear|afraid|anger|angry|hope|relief|grief|joy|shame|guilt|love|dread|panic|tender)\w*\b[^.!?]{0,140}/i, 'Emotion signal anchors progression or changed value.') },
    { dimension: 'specificity', score: clamp(48 + Math.min(30, sensoryCount * 4) + Math.min(22, concreteCount * 2)), confidence: 0.76, evidence: evidence(text, /\b(saw|heard|smell|scent|taste|touch|cold|warm|rough|smooth|door|glass|wood|metal|rain|stone)\w*\b[^.!?]{0,120}/i, 'Concrete sensory or physical detail supports specificity.') },
    { dimension: 'clarity', score: clamp(88 - passiveCount * 2 - lengths.filter((value) => value > 45).length * 4), confidence: 0.83, evidence: evidence(text, /[^.!?]{180,1000}[.!?]/g, 'Long or syntactically dense sentence is the main clarity pressure point.') },
    { dimension: 'rhythm', score: clamp(58 + Math.min(32, Math.sqrt(variance(lengths)) * 4) - paragraphs.filter((p) => tokenCount(p) > 220).length * 8), confidence: 0.81, evidence: evidence(text, /[^.!?]{1,1000}[.!?]\s+[^.!?]{1,1000}[.!?]/g, 'Adjacent sentence lengths provide rhythm evidence.') },
    { dimension: 'originality', score: clamp(86 - clichéCount * 14 - repetitionPenalty * 3), confidence: 0.8, evidence: evidence(text, /\b(heart skipped a beat|let out a breath|time stood still|little did (?:he|she|they) know|piercing blue eyes)\b/i, clichéCount ? 'Familiar stock phrase reduces originality.' : 'No configured stock phrase was detected; excerpt sampled for specificity.') },
    { dimension: 'continuity', score: clamp(75 + Math.min(15, causalCount * 2) - count(text, /\b(somehow knew|could not have known|unbeknownst)\b/gi) * 12), confidence: 0.58, evidence: evidence(text, /\b(somehow knew|could not have known|unbeknownst|again|remembered)\b[^.!?]{0,140}/i, 'Knowledge or prior-state language is the available local continuity evidence.') },
    { dimension: 'genreFit', score: clamp(context.genre ? 70 + Math.min(20, causalCount + sensoryCount) : 60), confidence: context.genre ? 0.63 : 0.4, evidence: evidence(text, /[^.!?]{40,220}[.!?]/g, context.genre ? `Passage sampled against the ${context.genre} reader promise.` : 'No genre contract supplied; confidence is reduced.') },
    { dimension: 'endingStrength', score: clamp(50 + Math.min(45, endingPressure * 7)), confidence: 0.79, evidence: [{ start: Math.max(0, text.length - ending.length), end: text.length, text: ending.slice(-240), rationale: 'Final passage is evaluated for changed state and forward pressure.' }] },
  ];
  const overallScore = dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length;
  const findings = dimensions.filter((item) => item.score < 65).map((item) => ({ type: item.dimension, severity: item.score < 50 ? 'critical' : 'warning', score: item.score, evidence: item.evidence, recommendation: `Revise ${item.dimension} using the accepted contract and rerun only this dimension.` }));
  return { dimensions, overallScore: Math.round(overallScore * 10) / 10, confidence: Math.round(dimensions.reduce((sum, item) => sum + item.confidence, 0) / dimensions.length * 100) / 100, pass: overallScore >= 76 && findings.every((item) => item.severity !== 'critical'), findings, wordCount: words, evaluatorVersion: 'literary-rubric-v1' };
}
