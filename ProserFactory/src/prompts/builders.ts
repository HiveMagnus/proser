import { getPrompt, interpolatePromptByKey } from './service';

export const RECIPE_VERSION: string = process.env.AI_RECIPE_VERSION ?? '2026-03-28';

// Prompt builders (Phase 2). Keep pure; do not include system prefix here.
export interface BeatsPromptInput {
  bookTitle?: string;
  chapterTitle?: string;
  chapterSummary?: string;
  recapPrev?: string;
  codex?: Array<{ entryType: string; entryName: string; entryDescription?: string }>;
  targetWords?: number;
}

export function buildBeatsPrompt(input: BeatsPromptInput): string {
  const template = getPrompt('beats');
  if (!template) {
    // Fallback to hardcoded template if centralized one is not found
    const lines: string[] = [];
    lines.push(`Plan a scene as strict JSON with keys {"beats": string[5..8], "pov": "first|third", "tense": "past|present", "target_words": number}.`);
    lines.push('Output ONLY JSON. No commentary.');
    if (input.bookTitle) lines.push(`Book: ${input.bookTitle}`);
    if (input.chapterTitle) lines.push(`Chapter: ${input.chapterTitle}`);
    if (input.chapterSummary) lines.push(`Chapter summary: ${input.chapterSummary}`);
    if (input.recapPrev) lines.push(`Previous chapter recap: ${input.recapPrev}`);
    if (input.codex && input.codex.length) {
      lines.push('Codex context:');
      for (const c of input.codex.slice(0, 5)) {
        lines.push(`- [${c.entryType}] ${c.entryName}: ${c.entryDescription ?? ''}`.trim());
      }
    }
    const tw = Math.max(400, Math.min(1600, input.targetWords ?? 900));
    lines.push(`Aim for target_words ≈ ${tw}.`);
    return lines.join('\n');
  }

  const tw = Math.max(400, Math.min(1600, input.targetWords ?? 900));
  return interpolatePromptByKey('beats', {
    bookTitle: input.bookTitle,
    chapterTitle: input.chapterTitle,
    chapterSummary: input.chapterSummary,
    recapPrev: input.recapPrev,
    codex: input.codex,
    targetWords: tw
  });
}

export interface ProsePromptInput {
  beatsJson: string;
  priorSummary?: string; // summary of the previous scene for continuity
  style?: { pov?: 'first' | 'second' | 'third'; tense?: 'past' | 'present'; wordsRange?: [number, number]; guardrails?: string[] };
}

export function buildProsePrompt(input: ProsePromptInput): string {
  const template = getPrompt('prose-from-beats');
  if (!template) {
    // Fallback to hardcoded template if centralized one is not found
    const range = input.style?.wordsRange ? `${input.style!.wordsRange![0]}-${input.style!.wordsRange![1]} words` : '~800-1200 words';
    const rails = input.style?.guardrails ?? [
      'Stay consistent with names and facts.',
      'No placeholders like <character> or {{...}}.',
      'Avoid meta-commentary or system messages.',
      'Do not use any emphasis in your response, including bolding or italics.'
    ];
    const pov = input.style?.pov ? `POV: ${input.style.pov}.` : '';
    const tense = input.style?.tense ? `Tense: ${input.style.tense}.` : '';
    const prior = (input.priorSummary && input.priorSummary.trim().length > 0)
      ? [`Previous scene summary (for continuity; do not repeat it verbatim):`, input.priorSummary.trim()]
      : [];
    return [
      ...prior,
      `Write a cohesive, engaging scene based on these beats (strict JSON):`,
      input.beatsJson,
      `Target length: ${range}. ${pov} ${tense}`.trim(),
      'Guardrails:',
      ...rails.map(r => `- ${r}`),
    ].join('\n');
  }

  const range = input.style?.wordsRange ? `${input.style!.wordsRange![0]}-${input.style!.wordsRange![1]} words` : '~800-1200 words';
  const rails = input.style?.guardrails ?? [
    'Stay consistent with names and facts.',
    'No placeholders like <character> or {{...}}.',
    'Avoid meta-commentary or system messages.',
    'Do not use any emphasis in your response, including bolding or italics.'
  ];

  return interpolatePromptByKey('prose-from-beats', {
    beatsJson: input.beatsJson,
    priorSummary: input.priorSummary,
    wordsRange: range,
    pov: input.style?.pov,
    tense: input.style?.tense,
    guardrails: rails
  });
}

export interface ReviewPromptInput { constraints?: { pov?: string; tense?: string; maxEditPct?: number } }

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const template = getPrompt('prose-review');
  if (!template) {
    // Fallback to hardcoded template if centralized one is not found
    const maxEdit = input.constraints?.maxEditPct ?? 10;
    const pov = input.constraints?.pov ? `POV: ${input.constraints.pov}.` : '';
    const tense = input.constraints?.tense ? `Tense: ${input.constraints.tense}.` : '';
    return `Lightly revise the scene to fix tense/POV consistency and remove repetition. Limit changes to ~${maxEdit}% of text. ${pov} ${tense}`.trim();
  }

  return interpolatePromptByKey('prose-review', {
    maxEditPct: input.constraints?.maxEditPct ?? 10,
    pov: input.constraints?.pov,
    tense: input.constraints?.tense
  });
}
