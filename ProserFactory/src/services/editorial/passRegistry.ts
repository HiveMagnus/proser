import type { EditorialPassDefinition, EditorialPassKey } from './contracts';
import { defaultBudget } from './editorialPolicy';

const scopes = ['book', 'act', 'chapter', 'scene'] as const;
const judges = ['blind_pairwise_v1', 'blind_pairwise_adversarial_v1'];
const verify = ['source_anchor_v1', 'canon_guard_v1', 'style_drift_v1', 'placeholder_guard_v1'];

function pass(
  key: EditorialPassKey,
  displayName: string,
  description: string,
  detectorKeys: string[],
  criticKeys: string[],
  mayChange: string[],
  mustPreserve: string[],
  defaultAutonomy: EditorialPassDefinition['defaultAutonomy'] = 'safe_auto',
): EditorialPassDefinition {
  return {
    key, version: '1.0.0', displayName, description, supportedScopes: [...scopes],
    defaultAutonomy, allowedRisk: ['low', 'medium'], detectorKeys, criticKeys,
    candidateRecipe: `${key}-candidate-v1`, judgeProfiles: judges, verificationKeys: verify,
    mayChange, mustPreserve, defaultBudget: defaultBudget(defaultAutonomy), enabled: true,
  };
}

export const EDITORIAL_PASSES: readonly EditorialPassDefinition[] = Object.freeze([
  pass('line_edit_safe', 'Safe line edit', 'Localized clarity, cadence, repetition, and specificity improvements.', ['repetition_v1', 'sentence_opening_v1', 'rhythm_v1', 'placeholder_v1'], ['line_editor_v1'], ['wording', 'sentence rhythm', 'local clarity'], ['canon', 'voice', 'POV', 'tense', 'scene outcome']),
  pass('dialogue', 'Dialogue', 'Dialogue clarity, attribution, subtext, and character voice.', ['dialogue_v1', 'rhythm_v1', 'placeholder_v1'], ['dialogue_editor_v1'], ['dialogue wording', 'speech tags'], ['speaker identity', 'intent', 'character voice', 'canon']),
  pass('voice_preservation', 'Voice preservation', 'Detect and correct generic prose and voice convergence.', ['style_fingerprint_v1', 'reference_overlap_v1'], ['voice_guardian_v1'], ['localized diction'], ['narrator voice', 'character voice', 'meaning']),
  pass('scene_energy', 'Scene energy', 'Improve scene movement, tension, specificity, and ending pressure.', ['rhythm_v1', 'pacing_v1'], ['scene_editor_v1'], ['localized pacing', 'specificity'], ['plot', 'outcome', 'chronology', 'canon']),
  pass('continuity', 'Continuity', 'Detect canon, chronology, character-state, and promise/payoff problems.', ['continuity_v1', 'character_arc_v1', 'promise_payoff_v1'], ['continuity_auditor_v1'], ['proven local contradictions'], ['canon identity', 'timeline', 'relationships'], 'review_only'),
  pass('name_originality', 'Name originality', 'Find visual, phonetic, and cross-book name collisions.', ['name_originality_v1'], ['developmental_editor_v1'], [], ['all existing names'], 'review_only'),
  pass('final_polish', 'Final polish', 'Bounded publication polish with all deterministic safeguards.', ['repetition_v1', 'sentence_opening_v1', 'rhythm_v1', 'dialogue_v1', 'pov_tense_v1', 'placeholder_v1', 'reference_overlap_v1', 'style_fingerprint_v1'], ['line_editor_v1', 'voice_guardian_v1', 'adversarial_reviewer_v1'], ['localized wording', 'punctuation', 'cadence'], ['canon', 'voice', 'POV', 'tense', 'chronology', 'outcome']),
  pass('custom', 'Custom objective', 'A bounded user objective under the same autonomous safety policy.', ['placeholder_v1', 'proper_noun_v1', 'style_fingerprint_v1'], ['adversarial_reviewer_v1'], ['objective-bounded local text'], ['all protected elements']),
]);

const knownDetectors = new Set(EDITORIAL_PASSES.flatMap((item) => item.detectorKeys));
const knownCritics = new Set(['line_editor_v1', 'dialogue_editor_v1', 'voice_guardian_v1', 'scene_editor_v1', 'continuity_auditor_v1', 'developmental_editor_v1', 'adversarial_reviewer_v1']);
const knownJudges = new Set(judges);
const knownVerifiers = new Set(verify);

export function validatePassRegistry(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const item of EDITORIAL_PASSES) {
    if (keys.has(item.key)) errors.push(`Duplicate pass ${item.key}`);
    keys.add(item.key);
    for (const key of item.detectorKeys) if (!knownDetectors.has(key)) errors.push(`Unknown detector ${key}`);
    for (const key of item.criticKeys) if (!knownCritics.has(key)) errors.push(`Unknown critic ${key}`);
    for (const key of item.judgeProfiles) if (!knownJudges.has(key)) errors.push(`Unknown judge ${key}`);
    for (const key of item.verificationKeys) if (!knownVerifiers.has(key)) errors.push(`Unknown verifier ${key}`);
  }
  return { valid: errors.length === 0, errors };
}

export function getEditorialPass(key: string): EditorialPassDefinition {
  const value = EDITORIAL_PASSES.find((item) => item.enabled && item.key === key);
  if (!value) throw new Error(`EDITORIAL_PASS_NOT_FOUND: ${key}`);
  return value;
}
