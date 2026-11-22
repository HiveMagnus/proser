import { validateBeatsJson } from '../lib/content/validators';
import { withRetry } from '../lib/resilience';

describe('beats JSON repair path', () => {
  it('fails first parse then succeeds on repair', async () => {
    const bad = 'not-json';
    const good = JSON.stringify({ beats: ['a','b','c'], pov: 'third', tense: 'past', target_words: 900 });

    // simulate model that outputs bad then good
    let calls = 0;
    const generate = async () => {
      calls++;
      return calls === 1 ? bad : good;
    };

    // first attempt
    const first = await generate();
    expect(validateBeatsJson(first)).toBe(false);

    // "repair" attempt (just the second call), wrapped in withRetry for parity with production flow
    const repaired = await withRetry(async () => generate(), 1);
    expect(validateBeatsJson(repaired)).toBe(true);
    expect(calls).toBe(2);
  });
});
