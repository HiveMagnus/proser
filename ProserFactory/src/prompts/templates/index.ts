/**
 * Prompt templates barrel — aggregates per-category modules into a single DEFAULT_PROMPTS map.
 *
 * Each category file exports a `Record<string, PromptTemplate>` with keyed entries.
 * This index merges them all and re-exports the additional (non-keyed) templates.
 *
 * To add a new category:
 *   1. Create `prompts/templates/<category>.ts` exporting `{ [key]: PromptTemplate }`.
 *   2. Import and spread it into `DEFAULT_PROMPTS` below.
 */
import type { PromptTemplate } from '@/types';
import { titlePrompts } from './title';
import { structurePrompts, CHAPTER_OUTLINE_TEMPLATE, SCENE_OUTLINE_TEMPLATE, SCENE_SUMMARY_TEMPLATE, SHORT_SUMMARY_TEMPLATE } from './structure';
import { codexPrompts } from './codex';
import { prosePrompts } from './prose';
import { feedbackPrompts } from './feedback';
import { interactivePrompts } from './interactive';
import { cliPrompts } from './cli';
import { editorPrompts } from './editor';

/** Merged map of all default prompt templates, keyed by slug (e.g., 'title', 'prose', 'beats'). */
export const DEFAULT_PROMPTS: Record<string, PromptTemplate> = {
  ...titlePrompts,
  ...structurePrompts,
  ...codexPrompts,
  ...prosePrompts,
  ...feedbackPrompts,
  ...interactivePrompts,
  ...cliPrompts,
  ...editorPrompts,
};

// Re-export additional (non-keyed) templates for backward compatibility
export { CHAPTER_OUTLINE_TEMPLATE, SCENE_OUTLINE_TEMPLATE, SCENE_SUMMARY_TEMPLATE, SHORT_SUMMARY_TEMPLATE };
