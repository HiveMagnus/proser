/**
 * Skills barrel — exports skill interfaces, runner, and built-in skills.
 *
 * Registers continuity, voice, and focused novel-production critics at module
 * load time so they are available
 * as soon as any consumer imports this module.
 *
 * @module skills
 */

export type {
  Skill,
  SkillInput,
  SkillResult,
  SkillFinding,
  FindingSeverity,
  SkillRunnerOptions,
  SkillRunnerResult,
} from './types';

export {
  registerSkill,
  getSkill,
  getRegisteredSkills,
  runSkills,
} from './runner';

export { ContinuityCritic } from './continuity-critic';
export { VoiceDriftDetector } from './voice-drift-detector';
export { FocusedCritic, FOCUSED_CRITIC_NAMES } from './focused-critics';

// ---------------------------------------------------------------------------
// Auto-register built-in skills
// ---------------------------------------------------------------------------

import { registerSkill } from './runner';
import { ContinuityCritic } from './continuity-critic';
import { VoiceDriftDetector } from './voice-drift-detector';
import { FocusedCritic, FOCUSED_CRITIC_NAMES } from './focused-critics';

registerSkill(new ContinuityCritic());
registerSkill(new VoiceDriftDetector());
for (const name of FOCUSED_CRITIC_NAMES) registerSkill(new FocusedCritic(name));
