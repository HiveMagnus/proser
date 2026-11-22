import { randomUUID } from 'node:crypto';

import type { EditorialFinding, EvidenceSpan } from '../contracts';
import { paragraphs, sentences, tokenize } from '../textAnchors';

const finding = (
  detectorKey: string,
  category: string,
  rationale: string,
  recommendation: string,
  evidence: EvidenceSpan[],
  confidence = 0.85,
  autofixEligible = true,
): EditorialFinding => ({
  id: randomUUID(), detectorKey, detectorVersion: '1.0.0', category,
  severity: 'medium', confidence, rationale, recommendation,
  risk: autofixEligible ? 'low' : 'medium', autofixEligible, evidence, protectedClaims: [],
});

export function detectRepetition(text: string): EditorialFinding[] {
  const tokens = tokenize(text);
  const occurrences = new Map<string, TextTokenLike[]>();
  for (const token of tokens) {
    if (token.normalized.length < 5) continue;
    const rows = occurrences.get(token.normalized) ?? [];
    rows.push(token);
    occurrences.set(token.normalized, rows);
  }
  const findings: EditorialFinding[] = [];
  for (const [word, rows] of occurrences) {
    const clusters = rows.filter((row, index) => index > 0 && row.start - rows[index - 1].start < 240);
    if (clusters.length < 1) continue;
    findings.push(finding('repetition_v1', 'repetition', `"${word}" recurs inside a short window.`, 'Replace or remove only an unintentional local repetition.', rows.slice(0, 4).map((row) => ({ start: row.start, end: row.end, text: row.text }))));
  }
  const ngrams = new Map<string, Array<{ start: number; end: number; text: string }>>();
  for (let index = 0; index <= tokens.length - 3; index += 1) {
    const slice = tokens.slice(index, index + 3);
    const key = slice.map((item) => item.normalized).join(' ');
    const rows = ngrams.get(key) ?? [];
    rows.push({ start: slice[0].start, end: slice[2].end, text: text.slice(slice[0].start, slice[2].end) });
    ngrams.set(key, rows);
  }
  for (const [phrase, rows] of ngrams) if (rows.length >= 2 && rows.at(-1)!.start - rows[0].start < 2_000) {
    findings.push(finding('repetition_v1', 'repeated_phrase', `The phrase "${phrase}" repeats nearby.`, 'Vary one occurrence only if this is not an intentional refrain.', rows.slice(0, 4), 0.9));
  }
  return findings.slice(0, 20);
}

type TextTokenLike = { text: string; start: number; end: number };

export function detectSentenceOpenings(text: string): EditorialFinding[] {
  const rows = sentences(text);
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const opening = tokenize(row.text).slice(0, 2).map((item) => item.normalized).join(' ');
    if (!opening) continue;
    const group = groups.get(opening) ?? [];
    group.push(row);
    groups.set(opening, group);
  }
  return [...groups.entries()].filter(([, rows]) => rows.length >= 3).slice(0, 8).map(([opening, matches]) =>
    finding('sentence_opening_v1', 'sentence_opening', `Several sentences begin with "${opening}".`, 'Vary one or two openings while preserving deliberate parallelism.', matches.slice(0, 5), 0.78));
}

export function rhythmMetrics(text: string) {
  const sentenceRows = sentences(text);
  const lengths = sentenceRows.map((row) => tokenize(row.text).length);
  const mean = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, lengths.length);
  const paragraphLengths = paragraphs(text).map((row) => tokenize(row.text).length);
  const dialogueWords = [...text.matchAll(/[“"][^”"]+[”"]/g)].reduce((sum, match) => sum + tokenize(match[0]).length, 0);
  return {
    sentenceCount: lengths.length, meanSentenceWords: mean, sentenceVariance: variance,
    burstiness: mean ? Math.sqrt(variance) / mean : 0, paragraphLengths,
    dialogueRatio: dialogueWords / Math.max(1, tokenize(text).length),
    longSentenceClusters: lengths.filter((value) => value > 45).length,
    paragraphWalls: paragraphLengths.filter((value) => value > 220).length,
    fragmentProxy: lengths.filter((value) => value <= 3).length / Math.max(1, lengths.length),
  };
}

export function detectRhythm(text: string): EditorialFinding[] {
  const metrics = rhythmMetrics(text);
  const evidence = sentences(text).slice(0, 5);
  const output: EditorialFinding[] = [];
  if (metrics.sentenceCount >= 6 && metrics.sentenceVariance < 8) output.push(finding('rhythm_v1', 'rhythm_monotony', 'Sentence lengths have unusually low local variance.', 'Introduce bounded sentence-length contrast without changing voice.', evidence, 0.72));
  if (metrics.longSentenceClusters >= 3) output.push(finding('rhythm_v1', 'long_sentence_cluster', 'Several long sentences cluster in this passage.', 'Clarify one syntactically dense sentence.', evidence, 0.8));
  if (metrics.paragraphWalls) output.push(finding('rhythm_v1', 'paragraph_density', 'A paragraph exceeds the configured density threshold.', 'Consider a natural paragraph break.', paragraphs(text).filter((row) => tokenize(row.text).length > 220).slice(0, 3), 0.84));
  return output;
}

export function detectDialogue(text: string): EditorialFinding[] {
  const output: EditorialFinding[] = [];
  const tags = [...text.matchAll(/\b(said|asked|replied|whispered|shouted)\s+(\w+ly)\b/gi)];
  if (tags.length >= 2) output.push(finding('dialogue_v1', 'adverbial_dialogue_tags', 'Multiple dialogue tags rely on adverbs.', 'Strengthen only a demonstrably weak action or line; do not add unnecessary tags.', tags.slice(0, 5).map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0] })), 0.76));
  const dialogueParagraphs = paragraphs(text).filter((row) => /^[“"]/.test(row.text));
  if (dialogueParagraphs.length >= 4 && !dialogueParagraphs.some((row) => /\b(said|asked|replied|whispered|shouted)\b/i.test(row.text))) {
    output.push(finding('dialogue_v1', 'speaker_handoff', 'A long dialogue exchange has no measurable speaker anchors.', 'Clarify one ambiguous handoff only if speaker identity is not already clear.', dialogueParagraphs.slice(0, 5), 0.65, false));
  }
  return output;
}

export function detectPovTense(text: string): EditorialFinding[] {
  const outsideDialogue = text.replace(/[“"][^”"]+[”"]/g, '');
  const first = outsideDialogue.match(/\b(I|me|my|mine|we|our)\b/gi)?.length ?? 0;
  const third = outsideDialogue.match(/\b(he|she|they|him|her|his|their)\b/gi)?.length ?? 0;
  const past = outsideDialogue.match(/\b(?:was|were|had|did|\w+ed)\b/gi)?.length ?? 0;
  const present = outsideDialogue.match(/\b(?:is|are|has|does)\b/gi)?.length ?? 0;
  const output: EditorialFinding[] = [];
  if (first >= 3 && third >= 6) output.push(finding('pov_tense_v1', 'pov_drift', 'First- and third-person narration both appear outside dialogue.', 'Review viewpoint continuity; uncertain head-hopping is never auto-fixed.', [], 0.62, false));
  if (past >= 8 && present >= 5) output.push(finding('pov_tense_v1', 'tense_drift', 'Past and present narration both appear frequently outside dialogue.', 'Review local tense continuity.', [], 0.68, false));
  return output;
}

export function placeholderFailures(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['markdown_fence', /```/],
    ['model_disclaimer', /\bas an ai\b/i],
    ['editing_commentary', /\b(?:here is|i have)\s+(?:the|your)\s+(?:revised|edited|rewritten)\b/i],
    ['placeholder', /\[(?:insert|todo|tbd|continue|generation note)[^\]]*\]/i],
    ['truncation_marker', /(?:\.\.\.|…)\s*\[(?:truncated|continued)\]/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
}

export function detectPlaceholders(text: string): EditorialFinding[] {
  return placeholderFailures(text).map((reason) => finding('placeholder_v1', 'meta_output', `Non-prose output detected: ${reason}.`, 'Reject this candidate.', [], 1, false));
}

export function referenceOverlap(text: string, reference: string): number {
  const shingles = (value: string) => {
    const words = tokenize(value).map((item) => item.normalized);
    return new Set(words.slice(0, -4).map((_, index) => words.slice(index, index + 5).join(' ')));
  };
  const left = shingles(text); const right = shingles(reference);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  return intersection / (left.size + right.size - intersection);
}

export function styleFingerprint(text: string) {
  const tokens = tokenize(text);
  const words = tokens.map((item) => item.normalized);
  const unique = new Set(words);
  const sentenceRows = sentences(text);
  const paragraphRows = paragraphs(text);
  const contractions = words.filter((word) => word.includes("'")).length;
  const pronouns = words.filter((word) => /^(?:i|me|my|we|our|you|he|him|his|she|her|they|them|their)$/.test(word)).length;
  const adverbs = words.filter((word) => word.endsWith('ly')).length;
  const hedges = text.match(/\b(?:perhaps|maybe|seemed|somewhat|almost|rather)\b/gi)?.length ?? 0;
  const sensoryDomains = {
    visual: words.filter((word) => /^(?:bright|dark|color|glow|shadow|red|blue|green|white|black)$/.test(word)).length,
    auditory: words.filter((word) => /^(?:sound|hear|heard|whisper|ring|crack|silence|voice)$/.test(word)).length,
    tactile: words.filter((word) => /^(?:touch|cold|warm|rough|smooth|soft|hard|ache)$/.test(word)).length,
    scentTaste: words.filter((word) => /^(?:smell|scent|taste|bitter|sweet|salt|smoke)$/.test(word)).length,
  };
  const functionWords = ['a', 'and', 'as', 'at', 'but', 'for', 'if', 'in', 'of', 'on', 'or', 'that', 'the', 'to', 'with'];
  const functionWordDistribution = Object.fromEntries(functionWords.map((word) => [
    word,
    words.filter((item) => item === word).length / Math.max(1, words.length),
  ]));
  const repeatedPhrases = new Map<string, number>();
  for (let index = 0; index <= words.length - 3; index += 1) {
    const phrase = words.slice(index, index + 3).join(' ');
    repeatedPhrases.set(phrase, (repeatedPhrases.get(phrase) ?? 0) + 1);
  }
  const windows = words.length < 50 ? [words] : Array.from(
    { length: Math.ceil(words.length / 25) },
    (_, index) => words.slice(index * 25, index * 25 + 50),
  ).filter((row) => row.length);
  const movingAverageTypeTokenRatio = windows.reduce(
    (sum, row) => sum + new Set(row).size / Math.max(1, row.length),
    0,
  ) / Math.max(1, windows.length);
  const dialogueText = [...text.matchAll(/[“"][^”"]+[”"]/g)].map((match) => match[0]).join(' ');
  const narratorText = text.replace(/[“"][^”"]+[”"]/g, ' ');
  const dialogueVocabulary = new Set(tokenize(dialogueText).map((item) => item.normalized));
  const narratorVocabulary = new Set(tokenize(narratorText).map((item) => item.normalized));
  const punctuation = Object.fromEntries(['.', ',', ';', ':', '!', '?', '—', '…'].map((mark) => [mark, [...text].filter((item) => item === mark).length / Math.max(1, text.length)]));
  return {
    version: 'style-fingerprint-v1',
    wordCount: words.length,
    typeTokenRatio: unique.size / Math.max(1, words.length),
    movingAverageTypeTokenRatio,
    vocabularyRarityProxy: words.filter((word) => words.indexOf(word) === words.lastIndexOf(word)).length / Math.max(1, words.length),
    sentenceWords: sentenceRows.map((row) => tokenize(row.text).length),
    paragraphWords: paragraphRows.map((row) => tokenize(row.text).length),
    dialogueRatio: rhythmMetrics(text).dialogueRatio,
    contractionRate: contractions / Math.max(1, words.length),
    pronounRate: pronouns / Math.max(1, words.length),
    adverbRate: adverbs / Math.max(1, words.length),
    hedgeRate: hedges / Math.max(1, words.length),
    sensoryDomainDistribution: Object.fromEntries(Object.entries(sensoryDomains).map(([key, value]) => [key, value / Math.max(1, words.length)])),
    figurativeLanguageProxy: (text.match(/\b(?:like|as if|as though)\b/gi)?.length ?? 0) / Math.max(1, sentenceRows.length),
    repeatedPhraseProfile: [...repeatedPhrases.entries()].filter(([, count]) => count > 1).sort((left, right) => right[1] - left[1]).slice(0, 20),
    functionWordDistribution,
    narratorDialogueSeparation: {
      narratorVocabularySize: narratorVocabulary.size,
      dialogueVocabularySize: dialogueVocabulary.size,
      overlap: [...dialogueVocabulary].filter((word) => narratorVocabulary.has(word)).length / Math.max(1, dialogueVocabulary.size),
    },
    punctuation,
  };
}

export function runCoreDetectors(text: string, keys: string[]): { findings: EditorialFinding[]; metrics: Record<string, unknown> } {
  const findings = [
    ...(keys.includes('repetition_v1') ? detectRepetition(text) : []),
    ...(keys.includes('sentence_opening_v1') ? detectSentenceOpenings(text) : []),
    ...(keys.includes('rhythm_v1') ? detectRhythm(text) : []),
    ...(keys.includes('dialogue_v1') ? detectDialogue(text) : []),
    ...(keys.includes('pov_tense_v1') ? detectPovTense(text) : []),
    ...(keys.includes('placeholder_v1') ? detectPlaceholders(text) : []),
  ];
  return { findings, metrics: { rhythm: rhythmMetrics(text), style: styleFingerprint(text) } };
}
