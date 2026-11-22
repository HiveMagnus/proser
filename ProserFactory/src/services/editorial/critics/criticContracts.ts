import type { EditorialFinding } from '../contracts';

export const CRITIC_PROFILES = Object.freeze([
  'line_editor_v1',
  'dialogue_editor_v1',
  'voice_guardian_v1',
  'scene_editor_v1',
  'continuity_auditor_v1',
  'developmental_editor_v1',
  'adversarial_reviewer_v1',
] as const);
export type CriticProfile = (typeof CRITIC_PROFILES)[number];

export interface CriticInput {
  profile: CriticProfile;
  scopeId: number;
  proseExcerpt: string;
  contextMap: Record<string, unknown>;
  protectedElements: string[];
  maximumFindings: number;
  inputHash: string;
}
export interface CriticResult {
  profile: CriticProfile;
  version: '1.0.0';
  abstained: boolean;
  findings: EditorialFinding[];
  inputHash: string;
}
