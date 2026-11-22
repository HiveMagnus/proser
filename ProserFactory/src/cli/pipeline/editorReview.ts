/**
 * AI-powered chapter editor review for the CLI pipeline.
 *
 * Uses the `editor-chapter-review` prompt template to analyse prose
 * and returns structured findings with severity-coloured table output.
 * @module cli/pipeline/editorReview
 */

import chalk from 'chalk';
import { output } from '../utils/output';
import { VllmService } from '@/lib/ai/vllm';
import { interpolatePromptByKey } from '@/prompts/service';
import { extractJson } from '@/cli/utils/extractJson';
import logger from '@/lib/logger';

export interface EditorFinding {
  type: string;
  severity: 'info' | 'warning' | 'error';
  location: string;
  message: string;
  suggestion: string;
}

/**
 * Run the AI editor review on a single chapter's prose.
 *
 * @returns Array of findings (may be empty).
 */
export async function reviewChapterProse(opts: {
  title: string;
  genre?: string;
  chapterNumber: number;
  chapterTitle: string;
  chapterSummary?: string;
  previousContext?: string;
  prose: string;
}): Promise<EditorFinding[]> {
  const ai = new VllmService();
  const prompt = interpolatePromptByKey('editor-chapter-review', {
    title: opts.title,
    genre: opts.genre ?? '',
    chapterNumber: String(opts.chapterNumber),
    chapterTitle: opts.chapterTitle,
    chapterSummary: opts.chapterSummary ?? '',
    previousContext: opts.previousContext ?? '',
    prose: opts.prose,
  });

  try {
    const raw = await ai.generateText({ prompt });
    const parsed = extractJson<EditorFinding[]>(raw);
    if (Array.isArray(parsed)) return parsed;
    logger.warn({ raw: raw.slice(0, 200) }, 'Editor review returned non-array');
    return [];
  } catch (err) {
    logger.warn({ err }, 'Editor review AI call failed');
    return [];
  }
}

/** Severity → chalk colour mapping. */
const SEVERITY_COLOUR: Record<string, (s: string) => string> = {
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
};

/** Print findings as a coloured table. */
export function printFindings(findings: EditorFinding[], chapterLabel: string): void {
  if (findings.length === 0) {
    output.success(`${chapterLabel}: No issues found.`);
    return;
  }

  output.section(`${chapterLabel} — ${findings.length} finding(s)`);
  const rows = findings.map((f) => ({
    Severity: (SEVERITY_COLOUR[f.severity] ?? chalk.white)(f.severity.toUpperCase()),
    Type: f.type,
    Location: f.location,
    Message: f.message,
  }));
  output.table(rows);
}
