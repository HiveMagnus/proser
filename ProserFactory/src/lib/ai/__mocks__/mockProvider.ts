import type { AIProvider } from '../vllm';

// Very simple deterministic mock: returns a string based on prompt hash
function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export class MockAIProvider implements AIProvider {
  id = 'mock';
  supports(): boolean { return true; }
  async generateText(opts: { prompt: string; signal?: AbortSignal }): Promise<string> {
    // Support an optional testing directive in the prompt: "DELAY_MS=<n>" to simulate slow providers
    const delayMatch = opts.prompt.match(/DELAY_MS=(\d+)/);
    const delayMs = delayMatch ? Number(delayMatch[1]) : 0;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), delayMs);
        if (opts.signal) {
          const onAbort = () => {
            clearTimeout(t);
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (opts.signal.aborted) return onAbort();
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    const h = simpleHash(opts.prompt);
    const variants = [
      'Mock response A',
      'Mock response B',
      'Mock response C',
      'Mock response D'
    ];
    return variants[h % variants.length];
  }
}
