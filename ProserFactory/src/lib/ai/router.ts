import { AIProvider, VllmService } from './vllm';
import { MockAIProvider } from './__mocks__/mockProvider';

export type TaskKind =
  | 'character'
  | 'location'
  | 'item'
  | 'outline'
  | 'summary'
  | 'title'
  | 'tagline'
  | 'inline'
  | 'feedback'
  | 'structure'
  | 'generic';

export class ModelRouter {
  private providers: AIProvider[];

  constructor(providers?: AIProvider[]) {
    if (providers && providers.length) {
      this.providers = providers;
    } else {
      const useMock = process.env.AI_PROVIDER === 'mock' || process.env.NODE_ENV === 'test';
      this.providers = [useMock ? new MockAIProvider() : new VllmService()];
    }
  }

  choose(_task: TaskKind, _hintModel?: string): AIProvider {
    // For now, return the first provider; in future, score by capability/latency.
    return this.providers[0];
  }
  /** Request-local model selection and metadata must not share mutable state. */
  forRequest(task: TaskKind, hintModel?: string, options: { noTransportReplay?: boolean } = {}): AIProvider {
    const provider = this.choose(task, hintModel);
    return provider instanceof VllmService ? new VllmService(hintModel, options) : provider;
  }
}

// Singleton default router for convenience
export const defaultModelRouter = new ModelRouter();
