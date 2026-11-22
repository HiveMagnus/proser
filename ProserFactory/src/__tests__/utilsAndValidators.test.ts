import { hashPrompt } from '../lib/resilience';
import { countWords, hasBannedPlaceholders, ensureMinWords, sanitizeArtifacts, validatePOV, validateTense } from '../lib/content/validators';

describe('hashPrompt', () => {
  it('is deterministic and short', () => {
    const h1 = hashPrompt('hello', 'v1');
    const h2 = hashPrompt('hello', 'v1');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{12}$/);
  });
  it('changes with recipeVersion', () => {
    const h1 = hashPrompt('hello', 'v1');
    const h2 = hashPrompt('hello', 'v2');
    expect(h1).not.toBe(h2);
  });
});

describe('validators', () => {
  it('counts words and enforces minimum', () => {
    const t = 'one two three four five';
    expect(countWords(t)).toBe(5);
    expect(ensureMinWords(t, 3)).toBe(true);
    expect(ensureMinWords(t, 6)).toBe(false);
  });
  it('detects placeholders and sanitizes artifacts', () => {
    const bad = 'Text with <character> and ```code``` {{placeholder}}';
    expect(hasBannedPlaceholders(bad)).toBe(true);
    const clean = sanitizeArtifacts(bad);
    expect(typeof clean).toBe('string');
  });
  it('validates POV roughly', () => {
    const first = 'I walk to the store and my shoes are wet.';
    const third = 'He walks to the store and his shoes are wet.';
    expect(validatePOV(first, 'first')).toBe(true);
    expect(validatePOV(third, 'third')).toBe(true);
  });
  it('validates tense roughly', () => {
    const present = 'She is walking and says it is fine.';
    const past = 'She was walking and said it was fine.';
    expect(validateTense(present, 'present')).toBe(true);
    expect(validateTense(past, 'past')).toBe(true);
  });
});
