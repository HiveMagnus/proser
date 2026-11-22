import type { Skill, SkillFinding, SkillInput, SkillResult } from './types';

type Analyze = (input: SkillInput) => SkillFinding[];

function finding(type: string, message: string, suggestion: string, confidence = 0.72, span?: { start: number; end: number }): SkillFinding {
  return { type, severity: 'warning', message, suggestion, confidence, span };
}

function sentences(text: string): string[] { return text.split(/(?<=[.!?])\s+/).filter(Boolean); }
function words(text: string): string[] { return text.toLowerCase().match(/[a-z']+/g) ?? []; }

const analyses: Record<string, Analyze> = {
  'scene-causality': ({ prose, sceneOutline }) => {
    const causal = (prose.match(/\b(because|therefore|so that|but|however|consequently|forcing|which meant)\b/gi) ?? []).length;
    return causal < Math.max(1, words(prose).length / 500) ? [finding('weak_causality', 'The scene has few explicit causal pivots relative to its length.', 'Strengthen but/therefore links between choices, obstacles, turns, and the exit.', 0.68)] : sceneOutline ? [] : [finding('missing_contract_context', 'No scene outline or contract was supplied to the causality critic.', 'Analyze against the accepted scene contract.', 0.9)];
  },
  'character-motivation': ({ prose }) => /\b(want|need|must|refuse|decide|choose|risk|goal)\b/i.test(prose) ? [] : [finding('motivation_not_legible', 'No clear desire, decision, or refusal is legible in the scene.', 'Make the viewpoint character pursue a concrete scene goal through observable tactics.')],
  'dialogue-subtext': ({ prose }) => {
    const dialogue = prose.match(/[“"][^”"]+[”"]/g) ?? [];
    if (dialogue.length < 2) return [];
    const onNose = dialogue.filter((line) => /\b(i feel|i am angry|i am sad|let me explain|as you know)\b/i.test(line));
    return onNose.length ? [finding('on_the_nose_dialogue', 'Some dialogue states emotion or shared information directly.', 'Let tactics, evasion, action beats, and implication carry the subtext.', 0.78)] : [];
  },
  pacing: ({ prose }) => {
    const paras = prose.split(/\n\s*\n/).filter(Boolean);
    const long = paras.find((p) => words(p).length > 220);
    return long ? [finding('pacing_block', 'A paragraph exceeds 220 words and may stall scene movement.', 'Break or redistribute the block around action, reaction, or a turn.', 0.75, { start: prose.indexOf(long), end: prose.indexOf(long) + long.length })] : [];
  },
  tension: ({ prose }) => /\b(risk|threat|deadline|before|unless|danger|lose|cost|trap|refuse)\b/i.test(prose) ? [] : [finding('low_pressure', 'The scene does not surface an immediate risk, cost, or time pressure.', 'Clarify what worsens if the character fails or delays.', 0.67)],
  exposition: ({ prose }) => {
    const paras = prose.split(/\n\s*\n/).filter(Boolean);
    const block = paras.find((p) => words(p).length > 150 && !/[“"]/.test(p) && !/\b(ran|moved|opened|turned|reached|stepped|grabbed)\b/i.test(p));
    return block ? [finding('exposition_block', 'A long paragraph contains little dialogue or physical action.', 'Distribute only necessary information through conflict and present action.', 0.74)] : [];
  },
  'sensory-grounding': ({ prose }) => {
    const sensory = (prose.match(/\b(saw|looked|heard|sound|smell|scent|taste|touched|felt|cold|warm|rough|smooth|bright|dark)\b/gi) ?? []).length;
    return sensory < 2 ? [finding('thin_sensory_grounding', 'The scene has very few concrete sensory anchors.', 'Add selective viewpoint-filtered sensory detail that affects action or emotion.', 0.7)] : [];
  },
  'emotional-progression': ({ prose }) => {
    const parts = [prose.slice(0, Math.ceil(prose.length / 4)), prose.slice(-Math.ceil(prose.length / 4))];
    const emotion = (part: string) => (part.match(/\b(afraid|angry|hope|relief|grief|joy|shame|guilt|love|hate|dread|calm|panic|tender)\w*\b/gi) ?? []).map((x) => x.toLowerCase()).sort().join('|');
    return emotion(parts[0]) === emotion(parts[1]) ? [finding('flat_emotional_value', 'Opening and ending emotional signals appear unchanged.', 'Make the turn alter the scene emotional value, even if the plot outcome is subtle.', 0.66)] : [];
  },
  repetition: ({ prose }) => {
    const tokens = words(prose); const seen = new Map<string, number>();
    for (let i = 0; i < tokens.length - 3; i++) { const gram = tokens.slice(i, i + 4).join(' '); seen.set(gram, (seen.get(gram) ?? 0) + 1); }
    const repeated = [...seen.entries()].find(([, count]) => count >= 3);
    return repeated ? [finding('accidental_repetition', `The phrase pattern “${repeated[0]}” repeats ${repeated[1]} times.`, 'Keep it only if it is an intentional motif; otherwise vary the construction.', 0.92)] : [];
  },
  'cliche-detection': ({ prose }) => {
    const clichés = ['heart skipped a beat', 'let out a breath', 'time stood still', 'piercing blue eyes', 'could cut the tension with a knife', 'little did they know'];
    const hit = clichés.find((phrase) => prose.toLowerCase().includes(phrase));
    return hit ? [finding('cliche', `The phrase “${hit}” is a familiar default construction.`, 'Replace it with character-, setting-, and moment-specific observation.', 0.95)] : [];
  },
  'setup-payoff-health': ({ prose }) => /\b(remember|again|finally|returned|payoff|promise|realized)\b/i.test(prose) ? [] : [finding('ledger_context_required', 'No visible setup/payoff signal was found in this isolated prose pass.', 'Verify the scene against the accepted promise/setup/payoff ledger.', 0.55)],
  'pov-knowledge': ({ prose, characterNames }) => !characterNames?.length ? [finding('knowledge_context_required', 'POV knowledge cannot be verified without character context.', 'Supply the POV character and knowledge-before ledger in the scene packet.', 0.9)] : /\b(somehow knew|could not have known|unbeknownst)\b/i.test(prose) ? [finding('possible_knowledge_leak', 'The prose contains language associated with knowledge outside the viewpoint.', 'Check the claim against the POV knowledge ledger.', 0.72)] : [],
  'genre-expectations': ({ genre, prose }) => !genre ? [finding('genre_contract_missing', 'No genre contract was supplied to the genre critic.', 'Evaluate the scene against the accepted reader promise and genre obligations.', 0.9)] : words(prose).length < 250 ? [finding('thin_genre_delivery', `The ${genre} scene is too short to establish a meaningful reader-promise beat.`, 'Add a specific genre-relevant complication, discovery, relationship shift, or fear beat.', 0.65)] : [],
  'chapter-cohesion': ({ prose }) => {
    const ss = sentences(prose); const opening = ss[0] ?? ''; const ending = ss.at(-1) ?? '';
    return opening.length < 20 || ending.length < 20 ? [finding('weak_scene_seam', 'The scene opening or ending is too slight to carry a strong chapter handoff.', 'Connect the opening to prior momentum and make the ending create a specific forward question.', 0.64)] : [];
  },
};

export class FocusedCritic implements Skill {
  readonly version = '1.0.0';
  readonly description: string;
  constructor(readonly name: string) { this.description = `Focused ${name} critic with bounded findings.`; }
  async analyze(input: SkillInput): Promise<SkillResult> {
    const started = performance.now();
    return { skillName: this.name, version: this.version, status: 'completed', findings: analyses[this.name]?.(input) ?? [], latencyMs: performance.now() - started };
  }
}

export const FOCUSED_CRITIC_NAMES = Object.keys(analyses);

