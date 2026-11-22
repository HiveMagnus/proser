/**
 * Backward-compatibility shim.
 *
 * The monolith prompt templates have been split into per-category modules
 * under `./templates/`. This file re-exports everything so existing imports
 * (`import { DEFAULT_PROMPTS } from './templates'`) continue to work.
 *
 * New code should import from `./templates/index` or the specific category file.
 */
export {
  DEFAULT_PROMPTS,
  CHAPTER_OUTLINE_TEMPLATE,
  SCENE_OUTLINE_TEMPLATE,
  SCENE_SUMMARY_TEMPLATE,
  SHORT_SUMMARY_TEMPLATE,
} from './templates/index';
