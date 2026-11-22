import { inferenceParams, INFERENCE_PROFILES } from '../lib/ai/inferenceProfiles';

describe('inference task profiles', () => {
  it('keeps deterministic structured work non-thinking', () => {
    expect(INFERENCE_PROFILES.structured).toMatchObject({ glmThinking: false, presencePenalty: 0 });
    expect(INFERENCE_PROFILES.critic).toMatchObject({ glmThinking: false, presencePenalty: 0 });
  });

  it('bounds planning reasoning and lets callers override output limits', () => {
    expect(INFERENCE_PROFILES.planning).toMatchObject({ glmThinking: true, thinkingBudgetTokens: 768 });
    expect(inferenceParams('planning', { maxTokens: 6000, seed: 7 })).toMatchObject({
      glmThinking: true, thinkingBudgetTokens: 768, maxTokens: 6000, seed: 7,
    });
  });

  it('uses direct prose and revision profiles', () => {
    expect(INFERENCE_PROFILES.prose.glmThinking).toBe(false);
    expect(INFERENCE_PROFILES.revision.glmThinking).toBe(false);
  });
});
