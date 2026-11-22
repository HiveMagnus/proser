export const JUDGE_PROFILES = Object.freeze([
  { key: 'blind_pairwise_v1', version: '1.0.0', enabled: true, dimensions: ['clarity', 'voice', 'specificity', 'rhythm', 'canon'] },
  { key: 'blind_pairwise_adversarial_v1', version: '1.0.0', enabled: true, dimensions: ['unsupported_detail', 'verbosity', 'imitation_risk', 'meta_output', 'invariants'] },
  { key: 'blind_pairwise_tiebreak_v1', version: '1.0.0', enabled: true, dimensions: ['material_benefit', 'risk', 'profile_fidelity'] },
] as const);

export function enabledJudgeProfile(key: string) {
  const profile = JUDGE_PROFILES.find((item) => item.key === key && item.enabled);
  if (!profile) throw new Error(`Editorial judge ${key} is disabled or unknown`);
  return profile;
}
