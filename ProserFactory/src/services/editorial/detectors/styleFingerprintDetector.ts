import { styleFingerprint } from './coreDetectors';
import { changedPercent } from '../textDiff';

export interface StyleDriftResult {
  version: 'style-drift-v1';
  distance: number;
  flattened: boolean;
  voiceConvergence: boolean;
  dimensions: Record<string, number>;
}

const mean = (rows: number[]) => rows.reduce((sum, value) => sum + value, 0) / Math.max(1, rows.length);
const variance = (rows: number[]) => {
  const average = mean(rows);
  return mean(rows.map((value) => (value - average) ** 2));
};

export function compareStyleFingerprints(sourceText: string, candidateText: string, intentionalDrift = false): StyleDriftResult {
  const source = styleFingerprint(sourceText);
  const candidate = styleFingerprint(candidateText);
  const dimensions = {
    vocabulary: Math.abs(source.typeTokenRatio - candidate.typeTokenRatio),
    dialogue: Math.abs(source.dialogueRatio - candidate.dialogueRatio),
    contraction: Math.abs(source.contractionRate - candidate.contractionRate),
    pronoun: Math.abs(source.pronounRate - candidate.pronounRate),
    adverb: Math.abs(source.adverbRate - candidate.adverbRate),
    hedge: Math.abs(source.hedgeRate - candidate.hedgeRate),
    sentenceVariance: Math.abs(variance(source.sentenceWords) - variance(candidate.sentenceWords)) / Math.max(10, variance(source.sentenceWords)),
  };
  const distance = Object.values(dimensions).reduce((sum, value) => sum + Math.min(1, value), 0) / Object.keys(dimensions).length;
  const rhythmFlattened = variance(source.sentenceWords) > 12
    && variance(candidate.sentenceWords) < variance(source.sentenceWords) * 0.35;
  const dictionFlattened = source.contractionRate >= 0.04
    && candidate.contractionRate === 0
    && changedPercent(sourceText, candidateText) > 50;
  const flattened = !intentionalDrift && (rhythmFlattened || dictionFlattened);
  return {
    version: 'style-drift-v1',
    distance,
    flattened,
    voiceConvergence: flattened && (dimensions.vocabulary > 0.05 || dictionFlattened),
    dimensions,
  };
}
