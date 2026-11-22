import { buildBeatsPrompt, buildProsePrompt, RECIPE_VERSION } from '../prompts/builders';

describe('prompt builders', () => {
  it('builds beats prompt with JSON hints', () => {
    const p = buildBeatsPrompt({ bookTitle: 'Book', chapterTitle: 'Ch1', chapterSummary: 'Sum', recapPrev: '', codex: [], targetWords: 900 });
    expect(typeof p).toBe('string');
    expect(p.toLowerCase()).toContain('json');
    expect(p).toContain('beats');
    expect(RECIPE_VERSION).toBeTruthy();
  });
  it('builds prose prompt from beats JSON', () => {
    const beatsJson = JSON.stringify({ beats: ['a','b','c'], pov: 'third', tense: 'past', target_words: 900 });
    const p = buildProsePrompt({ beatsJson, style: { pov: 'third', tense: 'past', wordsRange: [800,1200] } });
    expect(typeof p).toBe('string');
    expect(p).toContain('beats');
  });
});
