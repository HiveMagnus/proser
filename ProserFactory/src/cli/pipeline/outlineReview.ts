/**
 * Interactive outline review for the CLI pipeline.
 *
 * After the factory generates chapter outlines, this module presents each
 * chapter for user review with Accept / Regenerate / Edit / Skip-all options.
 * @module cli/pipeline/outlineReview
 */

import chalk from 'chalk';
import { output } from '../utils/output';
import { selectOption, editInEditor } from '../utils/prompt';
interface ChapterOutline { chapterId: number; chapterNumber: number; title: string; summary: string; actNumber: number }

export type OutlineAction = 'accept' | 'regenerate' | 'edit' | 'skip-all';

interface ReviewResult {
  action: 'accept' | 'regenerate';
  editedSummary?: string;
}

/**
 * Present a chapter outline for interactive review.
 *
 * @param outline   - Chapter data from the factory runner.
 * @param skipAll   - If true, auto-accept without prompting.
 * @returns The review decision (accept, regenerate, or accept-with-edit).
 */
export async function reviewChapterOutline(
  outline: ChapterOutline,
  skipAll: boolean,
): Promise<{ result: ReviewResult; skipAll: boolean }> {
  if (skipAll) {
    return { result: { action: 'accept' }, skipAll: true };
  }

  output.newline();
  output.section(`Chapter ${outline.chapterNumber} — ${outline.title}`);
  output.data('Act', String(outline.actNumber));
  console.log(chalk.gray(outline.summary));
  output.newline();

  const action = await selectOption<OutlineAction>('Review this chapter outline:', [
    { name: 'Accept', value: 'accept', description: 'Keep as-is and continue' },
    { name: 'Regenerate', value: 'regenerate', description: 'Discard and regenerate from scratch' },
    { name: 'Edit', value: 'edit', description: 'Open in $EDITOR, then accept the edited version' },
    { name: 'Skip all', value: 'skip-all', description: 'Auto-accept remaining chapters' },
  ]);

  switch (action) {
    case 'accept':
      return { result: { action: 'accept' }, skipAll: false };

    case 'regenerate':
      return { result: { action: 'regenerate' }, skipAll: false };

    case 'edit': {
      const edited = await editInEditor(outline.summary, `Edit Chapter ${outline.chapterNumber} summary`);
      output.success('Summary updated.');
      return { result: { action: 'accept', editedSummary: edited.trim() }, skipAll: false };
    }

    case 'skip-all':
      output.info('Auto-accepting remaining chapter outlines.');
      return { result: { action: 'accept' }, skipAll: true };
  }
}
