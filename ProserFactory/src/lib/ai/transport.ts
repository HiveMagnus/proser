import { createHash } from 'node:crypto';

import { currentWorkflowExecution, currentWorkflowSignal } from '@/services/workflowExecutionContext';

/** Build private inference headers without ever placing a credential in a URL. */
export function inferenceRequestHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const apiKey = process.env.INFERENCE_API_KEY?.trim();
  return {
    ...headers,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

const positiveInt = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const inferenceLimits = {
  requestTimeoutMs: () => positiveInt('AI_REQUEST_TIMEOUT_MS', 300_000),
  idleTimeoutMs: () => positiveInt('AI_IDLE_TIMEOUT_MS', 60_000),
  responseBytes: () => positiveInt('AI_MAX_RESPONSE_BYTES', 16 * 1024 * 1024),
  errorBytes: () => positiveInt('AI_MAX_ERROR_BYTES', 64 * 1024),
  sseLineBytes: () => positiveInt('AI_MAX_SSE_LINE_BYTES', 1024 * 1024),
  sseBufferBytes: () => positiveInt('AI_MAX_SSE_BUFFER_BYTES', 2 * 1024 * 1024),
};

export function combinedInferenceSignal(caller?: AbortSignal): AbortSignal {
  const signals = [caller, currentWorkflowSignal(), AbortSignal.timeout(inferenceLimits.requestTimeoutMs())]
    .filter((signal): signal is AbortSignal => Boolean(signal));
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export async function readBoundedBody(response: Response, maximumBytes = inferenceLimits.responseBytes()): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Inference response idle timeout after ${inferenceLimits.idleTimeoutMs()}ms`)), inferenceLimits.idleTimeoutMs());
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error(`Inference response exceeded ${maximumBytes} bytes`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson<T>(response: Response, maximumBytes = inferenceLimits.responseBytes()): Promise<T> {
  // Some unit-test transports expose only Response.json(). Real fetch
  // responses always use the bounded stream path below.
  if (!response.body) return await response.json() as T;
  const text = await readBoundedBody(response, maximumBytes);
  return JSON.parse(text) as T;
}

export function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 120_000)) : null;
}

export function safeInferenceLog(content: string | null | undefined): Record<string, unknown> {
  const value = content ?? '';
  const metadata: Record<string, unknown> = {
    contentHash: createHash('sha256').update(value).digest('hex').slice(0, 16),
    characters: value.length,
    workflowId: currentWorkflowExecution()?.runId,
  };
  const enabled = /^(?:1|true|yes)$/i.test(process.env.AI_DIAGNOSTIC_CONTENT_LOGGING ?? '');
  const until = Date.parse(process.env.AI_DIAGNOSTIC_CONTENT_LOGGING_UNTIL ?? '');
  // A diagnostic window must expire and may never be opened for more than one hour.
  if (!enabled || !Number.isFinite(until) || until <= Date.now() || until > Date.now() + 60 * 60 * 1000) return metadata;
  metadata.content = value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, positiveInt('AI_DIAGNOSTIC_CONTENT_MAX_CHARS', 8_000));
  return metadata;
}

const openingTag = /<\s*(?:think|thinking|analysis|reasoning|scratchpad|cot)\s*>/i;
const closingTag = /<\s*\/\s*(?:think|thinking|analysis|reasoning|scratchpad|cot)\s*>/i;
const openingBracket = /\[\s*(?:think|thinking|analysis|reasoning|scratchpad|cot)\s*\]/i;
const closingBracket = /\[\s*\/\s*(?:think|thinking|analysis|reasoning|scratchpad|cot)\s*\]/i;

/** Streaming sanitizer that withholds possible split markers across chunks. */
export class ReasoningBlockSanitizer {
  private pending = '';
  private closing: RegExp | null = null;

  push(chunk: string, final = false): string {
    this.pending += chunk;
    let visible = '';
    while (this.pending) {
      if (this.closing) {
        const match = this.closing.exec(this.pending);
        if (!match?.index && match?.index !== 0) {
          if (final) this.pending = '';
          else this.pending = this.pending.slice(-64);
          break;
        }
        this.pending = this.pending.slice(match.index + match[0].length);
        this.closing = null;
        continue;
      }
      const tag = openingTag.exec(this.pending);
      const bracket = openingBracket.exec(this.pending);
      const match = !tag ? bracket : !bracket ? tag : tag.index <= bracket.index ? tag : bracket;
      if (match) {
        visible += this.pending.slice(0, match.index);
        this.pending = this.pending.slice(match.index + match[0].length);
        this.closing = match[0].startsWith('<') ? closingTag : closingBracket;
        continue;
      }
      if (final) {
        visible += this.pending;
        this.pending = '';
        break;
      }
      const possible = Math.max(this.pending.lastIndexOf('<'), this.pending.lastIndexOf('['));
      if (possible >= 0 && this.pending.length - possible <= 64) {
        visible += this.pending.slice(0, possible);
        this.pending = this.pending.slice(possible);
      } else {
        const keep = Math.min(64, this.pending.length);
        visible += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(-keep);
      }
      break;
    }
    return visible;
  }
}
