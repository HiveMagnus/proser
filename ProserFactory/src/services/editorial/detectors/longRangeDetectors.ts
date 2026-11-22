import { randomUUID } from 'node:crypto';

import type { EditorialFinding } from '../contracts';

export interface LongRangeScene {
  id: number;
  order: number;
  words: number;
  summary?: string | null;
  outline?: string | null;
  eventCount?: number;
  conflict?: boolean;
  turn?: boolean;
  themes?: string[];
}
export interface CharacterStateEvidence {
  character: string;
  sceneId: number;
  order: number;
  stateKey: string;
  stateValue: string;
}
export interface PromiseEvidence {
  key: string;
  setupSceneId?: number;
  payoffSceneId?: number;
  dueOrder?: number;
  resolved?: boolean;
}

const finding = (
  detectorKey: string,
  category: string,
  rationale: string,
  sceneId?: number,
): EditorialFinding => ({
  id: randomUUID(), detectorKey, detectorVersion: '1.0.0', category,
  severity: 'medium', confidence: 0.76, rationale,
  recommendation: 'Preserve as bounded long-range evidence; ambiguous findings are not auto-fixed.',
  risk: 'high', autofixEligible: false, evidence: [], protectedClaims: [], sceneId,
});

export function detectCharacterStateContradictions(states: CharacterStateEvidence[]): EditorialFinding[] {
  const output: EditorialFinding[] = [];
  const grouped = new Map<string, CharacterStateEvidence[]>();
  for (const state of states) {
    const key = `${state.character.normalize('NFKC').toLowerCase()}:${state.stateKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), state]);
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.order - right.order);
    for (let index = 1; index < rows.length; index += 1) {
      const prior = rows[index - 1];
      const current = rows[index];
      if (prior.stateValue !== current.stateValue && current.order - prior.order <= 1) {
        output.push(finding('character_arc_v1', 'character_state_contradiction', `${current.character}'s ${current.stateKey} changes from "${prior.stateValue}" to "${current.stateValue}" without a recorded intervening transition.`, current.sceneId));
      }
    }
  }
  return output;
}

export function detectPromisePayoff(promises: PromiseEvidence[], finalOrder: number): EditorialFinding[] {
  return promises.flatMap((item) => {
    if (!item.setupSceneId && item.payoffSceneId) return [finding('promise_payoff_v1', 'payoff_without_setup', `"${item.key}" pays off without a recorded setup.`, item.payoffSceneId)];
    if (item.setupSceneId && !item.payoffSceneId && !item.resolved && (item.dueOrder ?? finalOrder) <= finalOrder) {
      return [finding('promise_payoff_v1', 'promise_past_due', `"${item.key}" remains unresolved beyond its configured horizon.`, item.setupSceneId)];
    }
    return [];
  });
}

export function detectPacingAndThemes(scenes: LongRangeScene[]): EditorialFinding[] {
  if (!scenes.length) return [];
  const output: EditorialFinding[] = [];
  const mean = scenes.reduce((sum, scene) => sum + scene.words, 0) / scenes.length;
  for (const scene of scenes) {
    if (scenes.length >= 3 && scene.words > mean * 2.25 && (scene.eventCount ?? 0) <= 1) {
      output.push(finding('pacing_v1', 'pacing_density_anomaly', `Scene ${scene.id} is over twice the local mean length with sparse recorded event movement.`, scene.id));
    }
  }
  const quietRun = scenes.filter((scene) => !scene.conflict && !scene.turn);
  if (quietRun.length >= Math.max(3, Math.ceil(scenes.length * 0.7))) {
    output.push(finding('pacing_v1', 'pacing_monotony', 'Most selected scenes have neither recorded conflict nor a turn; this is diagnostic, not proof of poor quality.'));
  }
  const counts = new Map<string, number>();
  for (const scene of scenes) for (const theme of scene.themes ?? []) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  for (const [theme, count] of counts) {
    if (count === scenes.length && scenes.length >= 4) output.push(finding('theme_v1', 'theme_overconcentration', `"${theme}" appears in every selected scene.`));
    if (count === 1 && scenes.length >= 6) output.push(finding('theme_v1', 'theme_disappearance', `"${theme}" appears once across the selected long-range scope.`));
  }
  return output;
}
