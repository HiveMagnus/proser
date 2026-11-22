import {
  detectDialogue,
  detectPlaceholders,
  detectPovTense,
  detectRepetition,
  detectRhythm,
  detectSentenceOpenings,
  referenceOverlap,
  styleFingerprint,
} from '@/services/editorial/detectors/coreDetectors';
import {
  analyzeNames,
  nameCollisionScore,
} from '@/services/editorial/detectors/nameOriginalityDetector';
import {
  detectCharacterStateContradictions,
  detectPacingAndThemes,
  detectPromisePayoff,
} from '@/services/editorial/detectors/longRangeDetectors';
import { compareStyleFingerprints } from '@/services/editorial/detectors/styleFingerprintDetector';
import { detectProperNounChanges, normalizeProperNoun } from '@/services/editorial/detectors/properNounDetector';

describe('editorial deterministic detectors', () => {
  it('detects Unicode-safe repetition and sentence-opening monotony', () => {
    const text = 'Élan crossed the empty hall. The empty hall rang. The guard waited. The guard watched. The guard wondered.';
    expect(detectRepetition(text).some((item) => item.category === 'repetition')).toBe(true);
    expect(detectSentenceOpenings(text).some((item) => item.category === 'sentence_opening')).toBe(true);
  });

  it('measures rhythm and dialogue without treating metrics as universal quality', () => {
    expect(detectRhythm('One measured sentence. Two measured sentences. Three measured sentences. Four measured sentences. Five measured sentences. Six measured sentences.').map((item) => item.category)).toContain('rhythm_monotony');
    const wall = `${'word '.repeat(230)}.`;
    expect(detectRhythm(wall).map((item) => item.category)).toContain('paragraph_density');
    expect(detectDialogue('"Go," Mara said softly.\n\n"No," Elian replied quietly.')).toHaveLength(1);
  });

  it('guards POV, tense, placeholders, proper nouns, and copied references', () => {
    expect(detectPovTense('I was there. I had waited and walked. My coat was soaked and I did nothing. She is here and he is ready. They are watching her while she does what he has asked them to do.').length).toBeGreaterThan(0);
    expect(detectPlaceholders('```text\nAs an AI, here is the revised passage.')).not.toHaveLength(0);
    expect(normalizeProperNoun('Dr. ÉLIAN')).toBe('dr. élian');
    expect(detectProperNounChanges('Mara waited.', 'Mara waited beside Corvin.').map((item) => item.category)).toContain('unexplained_named_entity');
    const copied = 'the city woke under rain like a beast beneath a silver sheet every window an unblinking eye';
    expect(referenceOverlap(copied, copied)).toBe(1);
  });

  it('scores name collisions as evidence and never makes them autofixable', () => {
    expect(nameCollisionScore('Mara Vale', 'Maera Vail').score).toBeGreaterThan(0.6);
    const findings = analyzeNames({
      names: [{ name: 'Mara Vale' }, { name: 'Maera Vail' }, { name: 'John Smith' }],
      crossBookNames: ['Mara Vale'],
    });
    expect(findings.map((item) => item.category)).toEqual(expect.arrayContaining([
      'name_collision',
      'cross_book_name_reuse',
      'configured_name_predictability',
    ]));
    expect(findings.every((item) => !item.autofixEligible)).toBe(true);
  });

  it('finds structured long-range contradictions, promise gaps, pacing, and theme concentration', () => {
    expect(detectCharacterStateContradictions([
      { character: 'Mara', sceneId: 1, order: 1, stateKey: 'location', stateValue: 'orchard' },
      { character: 'Mara', sceneId: 2, order: 2, stateKey: 'location', stateValue: 'moon' },
    ])).toHaveLength(1);
    expect(detectPromisePayoff([
      { key: 'glass pear', setupSceneId: 1, dueOrder: 2 },
      { key: 'unknown key', payoffSceneId: 3 },
    ], 3).map((item) => item.category)).toEqual(expect.arrayContaining(['promise_past_due', 'payoff_without_setup']));
    expect(detectPacingAndThemes([
      { id: 1, order: 1, words: 100, themes: ['grief'] },
      { id: 2, order: 2, words: 100, themes: ['grief'] },
      { id: 3, order: 3, words: 500, eventCount: 0, themes: ['grief'] },
      { id: 4, order: 4, words: 100, themes: ['grief'] },
    ]).map((item) => item.category)).toEqual(expect.arrayContaining(['pacing_density_anomaly', 'theme_overconcentration']));
  });

  it('records rich fingerprints and catches grammatically clean voice flattening', () => {
    const source = `Ain't a lock born yet that likes me! Short. Then the tumbling, jangling, impossible sentence ran on—because Jory liked it that way.`;
    const candidate = 'I can open the lock. I am confident. I will begin now. I will finish soon.';
    const fingerprint = styleFingerprint(source);
    expect(fingerprint.version).toBe('style-fingerprint-v1');
    expect(fingerprint.movingAverageTypeTokenRatio).toBeGreaterThan(0);
    expect(compareStyleFingerprints(source, candidate).flattened).toBe(true);
  });
});
