import crypto from 'node:crypto';

export interface RetryOptions {
  timeoutMs?: number;
  jitter?: boolean;
  reasonTag?: string;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: (signal: AbortSignal) => Promise<T>, attempts?: number, onRetry?: (attempt: number, error: unknown) => void, options?: RetryOptions): Promise<T>;
export async function withRetry<T>(fn: () => Promise<T>, attempts?: number, onRetry?: (attempt: number, error: unknown) => void, options?: RetryOptions): Promise<T>;
export async function withRetry<T>(fn: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>), attempts = 3, onRetry?: (attempt: number, error: unknown) => void, options?: RetryOptions): Promise<T> {
  let lastError: unknown;
  const timeout = typeof options?.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = timeout ? new AbortController() : null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const operation = fn.length >= 1 ? (fn as (signal: AbortSignal) => Promise<T>)(controller?.signal as AbortSignal) : (fn as () => Promise<T>)();
      if (!timeout) return await operation;
      return await Promise.race([operation, new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          const error: Error & { code?: string } = new Error('withRetry: timeout exceeded');
          error.code = 'ETIMEDOUT';
          reject(error);
        }, timeout);
      })]);
    } catch (error) {
      lastError = error;
      if (options?.shouldRetry && !options.shouldRetry(error)) throw error;
      if (attempt < attempts) onRetry?.(attempt, error);
      if (attempt < attempts) {
        const base = attempt === 1 ? 1000 : attempt === 2 ? 4000 : 10_000;
        const jitter = options?.jitter ? Math.floor(Math.random() * 150) : 0;
        await new Promise((resolve) => setTimeout(resolve, base + jitter));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError;
}

export function hashPrompt(prompt: string, recipeVersion: string): string {
  return crypto.createHash('sha256').update(`${recipeVersion}::${prompt}`).digest('hex').slice(0, 12);
}
