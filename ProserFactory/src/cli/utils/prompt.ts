/**
 * Interactive prompt wrappers for CLI pipeline.
 *
 * Wraps @inquirer/prompts (ESM) to provide a consistent, testable API.
 * @module cli/utils/prompt
 */

import { confirm, select, editor } from '@inquirer/prompts';

/** Ask a yes/no confirmation question. */
export async function confirmAction(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

/** Present a single-select list. Returns the chosen value. */
export async function selectOption<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T; description?: string }>,
): Promise<T> {
  return select({ message, choices });
}

/** Open $EDITOR for freeform text editing. Returns the edited text. */
export async function editInEditor(content: string, message = 'Edit content'): Promise<string> {
  return editor({ message, default: content });
}
