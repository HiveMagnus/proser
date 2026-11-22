import { evaluateLiteraryText, LITERARY_DIMENSIONS } from '@/services/literaryEvaluationService';
import { getRegisteredSkills } from '@/lib/skills';

const prose = `Mara wanted the key, but the guard closed his hand around it. “Tell me why,” he said. Rain ticked against the cold glass. Because waiting would cost her brother another night, Mara chose to risk the truth. Shame tightened her voice, then eased when the guard opened the iron door. She stepped through. Behind her, the lock clicked twice—and someone in the dark whispered her name?`;

describe('literary rubric', () => {
  it('scores evidence-backed literary dimensions without lifecycle bonuses', () => {
    const first = evaluateLiteraryText(prose, { genre: 'thriller' });
    const second = evaluateLiteraryText(prose, { genre: 'thriller' });
    expect(first.overallScore).toBe(second.overallScore);
    expect(first.dimensions.map((item) => item.dimension)).toEqual([...LITERARY_DIMENSIONS]);
    expect(first.dimensions).toHaveLength(12);
    expect(first.dimensions.every((item) => item.evidence.length > 0 && item.confidence > 0)).toBe(true);
    expect(first.evaluatorVersion).toBe('literary-rubric-v1');
  });

  it('registers the expanded focused critic suite', () => {
    const names = new Set(getRegisteredSkills().map((skill) => skill.name));
    for (const name of ['scene-causality', 'character-motivation', 'dialogue-subtext', 'pacing', 'tension', 'exposition', 'sensory-grounding', 'emotional-progression', 'repetition', 'cliche-detection', 'setup-payoff-health', 'pov-knowledge', 'genre-expectations', 'chapter-cohesion']) expect(names.has(name)).toBe(true);
  });

  it('evaluates a large punctuation-free model result with bounded evidence', () => {
    const text = 'unpunctuated '.repeat(10000).trim();
    const result = evaluateLiteraryText(text);
    expect(result.wordCount).toBe(10000);
    expect(Number.isFinite(result.overallScore)).toBe(true);
    expect(result.dimensions).toHaveLength(12);
    for (const dimension of result.dimensions) for (const item of dimension.evidence) {
      expect(item.text.length).toBeLessThanOrEqual(240);
      expect(item.start).toBeGreaterThanOrEqual(0);
      expect(item.end).toBeLessThanOrEqual(text.length);
    }
  });
});
