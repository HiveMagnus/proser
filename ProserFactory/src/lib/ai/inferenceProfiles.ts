export type InferenceProfileName =
  | 'structured'
  | 'critic'
  | 'prose'
  | 'planning'
  | 'revision';

export interface InferenceRequestParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
  seed?: number;
  glmThinking?: boolean;
  glmPreserveThinking?: boolean;
  thinkingBudgetTokens?: number;
}

export const INFERENCE_PROFILES: Record<InferenceProfileName, Readonly<InferenceRequestParams>> = {
  structured: {
    temperature: 0.15,
    topP: 0.85,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1,
    glmThinking: false,
  },
  critic: {
    temperature: 0.2,
    topP: 0.85,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1,
    glmThinking: false,
  },
  prose: {
    temperature: 0.75,
    topP: 0.9,
    topK: 20,
    minP: 0,
    presencePenalty: 1.5,
    repeatPenalty: 1,
    glmThinking: false,
  },
  planning: {
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1,
    glmThinking: true,
    thinkingBudgetTokens: 768,
  },
  revision: {
    temperature: 0.35,
    topP: 0.85,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1,
    glmThinking: false,
  },
};

export function inferenceParams(
  profile: InferenceProfileName,
  overrides: InferenceRequestParams = {},
): InferenceRequestParams {
  return { ...INFERENCE_PROFILES[profile], ...overrides };
}
