import {DocumentError} from '@/documents/errors';
import { BOOK_AI_DISABLED } from './bookAiPolicy';
import {admitReleaseMutation} from '@/operations/releaseAdmission';
import Ajv, { type SchemaObject } from 'ajv';
import addFormats from 'ajv-formats';
import dotenv from 'dotenv';
import { loadInferenceSettingsFile } from '@/core/inferenceSettingsFile';
import { createHash } from 'node:crypto';
import logger, { promptLogger } from '../logger';
import { stripThinkingBlocks } from './sanitize';
import { getSystemPrompt } from '../../prompts/system';
import { AIServiceError } from '../errors';
import { aiRequestQueue } from './requestQueue';
import type { InferenceRequestParams } from './inferenceProfiles';
import { enforceTerminalReason, InferenceTerminalError, TERMINAL_REASON_POLICIES, type InferenceTerminalPolicy } from './terminalReason';
export { InferenceTerminalError, TERMINAL_REASON_POLICIES } from './terminalReason';
export type { InferenceTerminalPolicy, InferenceTerminalReason } from './terminalReason';
import {
  combinedInferenceSignal,
  inferenceLimits,
  inferenceRequestHeaders,
  readBoundedBody,
  readBoundedJson,
  ReasoningBlockSanitizer,
  retryAfterMs,
  safeInferenceLog,
} from './transport';
import { recordInferenceOutcome, type InferenceOutcome } from '@/metrics/inference';

const inheritedEnvironment = { ...process.env };
try { dotenv.config({ quiet: true }); } catch {}
try { dotenv.config({ path: '.env.local', override: true }); } catch {}
Object.assign(process.env, inheritedEnvironment);
loadInferenceSettingsFile();

// ─── Types ────────────────────────────────────────────────────────────────────

export type AIChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
}

export interface AIChatMessage {
  role: AIChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AIToolCall[];
  reasoning_content?: string;
}

export interface AIFunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

export interface AIWebSearchResult {
  title?: string;
  content?: string;
  link?: string;
  media?: string;
  icon?: string;
  refer?: string;
  publishDate?: string;
}

export interface AIChatCompletionOptions {
  messages: AIChatMessage[];
  tools?: AIFunctionToolDefinition[];
  toolChoice?: 'auto';
  responseFormat?: { type: 'text' | 'json_object' } | {
    type: 'json_schema';
    json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
  };
  thinking?: 'enabled' | 'disabled';
  preserveThinking?: boolean;
  toolStream?: boolean;
  userId?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
  seed?: number;
  thinkingBudgetTokens?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  terminalPolicy?: InferenceTerminalPolicy;
}

export interface AIChatCompletionResult {
  model: string;
  message: AIChatMessage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  usage?: VllmInferenceMetadata['usage'];
  reasoningContent?: string;
  webSearch?: AIWebSearchResult[];
}

interface VllmChatResponse {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: unknown;
        };
      }>;
    };
    finish_reason: string;
  }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  web_search?: Array<{
    title?: string;
    content?: string;
    link?: string;
    media?: string;
    icon?: string;
    refer?: string;
    publish_date?: string;
  }>;
}

type VllmUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export interface VllmInferenceMetadata {
  model: string;
  reportedModel?: string;
  stream: boolean;
  capturedAt: string;
  reasoning?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface Character {
  name: string;
  description: string;
  traits?: string[];
  background?: string;
}

interface Location {
  name: string;
  description: string;
  atmosphere?: string;
  significance?: string;
}

interface Item {
  name: string;
  description: string;
  significance?: string;
  properties?: string[];
}

export const DEFAULT_INFERENCE_BASE_URL = 'http://127.0.0.1:8000';
export const DEFAULT_INFERENCE_MODEL = 'qwen3.6-35b';
export const DEFAULT_INFERENCE_BACKEND = 'llamacpp';

type InferenceBackend = 'ollama' | 'llamacpp' | 'vllm';

export function resolveInferenceBaseUrl(): string {
  return (
    process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_HOST ||
    process.env.INFERENCE_HOST ||
    process.env.VLLM_BASE_URL ||
    DEFAULT_INFERENCE_BASE_URL
  ).replace(/\/+$/, '');
}

export function resolveInferenceModel(override?: string): string {
  return (
    override ||
    process.env.OLLAMA_MODEL ||
    process.env.VLLM_MODEL ||
    DEFAULT_INFERENCE_MODEL
  );
}

export async function fetchInferenceModelIds(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
    headers: inferenceRequestHeaders({ Accept: 'application/json' }),
    signal: combinedInferenceSignal(AbortSignal.timeout(10_000)),
  });
  if (!res.ok) {
    const detail = await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '');
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }

  const data = await readBoundedJson<{ data?: Array<{ id?: string }> }>(res);
  return (data.data ?? [])
    .map((model) => String(model.id ?? '').trim())
    .filter(Boolean);
}

function isOllamaBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.port === '11434' || /ollama/i.test(url.hostname);
  } catch {
    return /:11434(?:$|[/?#])/.test(baseUrl) || /ollama/i.test(baseUrl);
  }
}

function resolveInferenceBackend(baseUrl: string): InferenceBackend {
  const configured = (process.env.INFERENCE_BACKEND || '').trim().toLowerCase();
  if (configured === 'ollama' || configured === 'llamacpp' || configured === 'vllm') {
    return configured;
  }

  if (isOllamaBaseUrl(baseUrl)) return 'ollama';

  try {
    const url = new URL(baseUrl);
    if (/llama/i.test(url.hostname)) return 'llamacpp';
  } catch {
    if (/llama/i.test(baseUrl)) return 'llamacpp';
  }

  return DEFAULT_INFERENCE_BACKEND;
}

function isInferenceMetadataCaptureEnabled(): boolean {
  const value = (process.env.AI_CAPTURE_REASONING_ENABLED || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function extractTextPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractTextPayload(item)).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'reasoning', 'reasoning_content']) {
      const extracted = extractTextPayload(obj[key]);
      if (extracted) return extracted;
    }
  }
  return '';
}

function normalizeUsage(usage?: VllmUsage): VllmInferenceMetadata['usage'] | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function isGlmModel(model: string): boolean {
  return /(^|[/:_-])glm(?:[-_.]|\d)/i.test(model);
}

function resolveGlmSystemPrompt(base: string, thinkingEnabled: boolean): string {
  const cleaned = base.replace(/\s*\/(think|nothink)\s*$/i, '').trimEnd();
  return `${cleaned} ${thinkingEnabled ? '/think' : '/nothink'}`;
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function normalizeToolCalls(toolCalls?: Array<{
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}>): AIToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function?.name ?? `tool_${index + 1}`,
      arguments: stringifyToolArguments(toolCall.function?.arguments),
    },
    index,
  }));
}

function normalizeWebSearch(results?: VllmChatResponse['web_search']): AIWebSearchResult[] | undefined {
  if (!results?.length) return undefined;
  return results.map((result) => ({
    title: result.title,
    content: result.content,
    link: result.link,
    media: result.media,
    icon: result.icon,
    refer: result.refer,
    publishDate: result.publish_date,
  }));
}

// Provider abstraction (re-export the same interface used across the codebase)
export interface AIProvider {
  id: string;
  generateText(opts: { prompt: string; stream?: boolean; params?: InferenceRequestParams; signal?: AbortSignal; terminalPolicy?: InferenceTerminalPolicy }): Promise<string>;
  generateStream?(opts: { prompt: string; params?: Record<string, unknown>; signal?: AbortSignal; terminalPolicy?: InferenceTerminalPolicy }): AsyncGenerator<string>;
  generateChatCompletion?(opts: AIChatCompletionOptions): Promise<AIChatCompletionResult>;
  supports(type: 'chat' | 'completion' | 'json'): boolean;
  setModel?(model: string): void;
  getModel?(): string;
}

// ─── VllmService ──────────────────────────────────────────────────────────────

/** Minimal shape of a streamed OpenAI-compatible chat completion chunk. */
interface StreamChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string; reasoning?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }>;
  usage?: VllmUsage;
}

interface StreamErrorClassification {
  outcome?: InferenceOutcome;
  affectsProviderHealth: boolean;
}

function classifyStreamError(error: unknown, callerSignal?: AbortSignal): StreamErrorClassification {
  if (error instanceof InferenceTerminalError) {
    if (error.code === 'INFERENCE_TRUNCATED') return { outcome: 'truncation', affectsProviderHealth: false };
    if (error.code === 'INFERENCE_BLOCKED') return { outcome: 'content_filter', affectsProviderHealth: false };
    return { outcome: 'policy_rejection', affectsProviderHealth: false };
  }

  const message = error instanceof Error ? error.message : String(error);
  if ((error as Error)?.name === 'AbortError' && callerSignal?.aborted) return { affectsProviderHealth: false };
  if (/SSE|stream (?:exceeded|premature EOF)|missing readable body/i.test(message)) {
    return { outcome: 'protocol_failure', affectsProviderHealth: true };
  }
  if (/idle timeout|timed? out|network|fetch failed|socket|ECONN|HTTP (?:408|5\d\d)\b/i.test(message)) {
    return { outcome: 'provider_failure', affectsProviderHealth: true };
  }
  return { affectsProviderHealth: false };
}

export class VllmService implements AIProvider {
  private baseUrl: string;
  private model: string;
  private activeAdapterName: string | null = null;
  public id = 'vllm';
  private failureCount = 0;
  private breakerOpenUntil = 0;
  private ajv: Ajv;
  private lastInferenceMetadata: VllmInferenceMetadata | null = null;
  private readonly noTransportReplay: boolean;

  constructor(model?: string, options: { noTransportReplay?: boolean } = {}) {
    this.noTransportReplay = options.noTransportReplay === true;
    this.baseUrl = resolveInferenceBaseUrl();
    this.model = resolveInferenceModel(model);
    this.ajv = new Ajv({ allErrors: true });
    try { addFormats(this.ajv); } catch { /* optional */ }
  }

  setModel(model: string): void { this.model = model; }
  getModel(): string { return this.model; }
  getActiveAdapterName(): string | null { return this.activeAdapterName; }
  get backendLabel(): InferenceBackend { return resolveInferenceBackend(this.baseUrl); }
  supportsDynamicAdapters(): boolean { return this.backendLabel === 'vllm'; }

  /**
   * Load a LoRA adapter by name+path and mark it as the active adapter.
   * Subsequent requests will use `<baseModel>:<adapterName>` as the model string.
   */
  async activateAdapter(name: string, path: string): Promise<boolean> {
    const ok = await this.loadAdapter(name, path);
    if (ok) {
      this.activeAdapterName = name;
      logger.info({ name }, 'LoRA adapter activated');
    }
    return ok;
  }

  /**
   * Unload the currently active LoRA adapter and revert to base model.
   */
  async deactivateAdapter(): Promise<boolean> {
    if (!this.activeAdapterName) return true;
    const name = this.activeAdapterName;
    const ok = await this.unloadAdapter(name);
    if (ok) {
      this.activeAdapterName = null;
      logger.info({ name }, 'LoRA adapter deactivated');
    }
    return ok;
  }
  getLastInferenceMetadata(): VllmInferenceMetadata | null {
    if (!this.lastInferenceMetadata) return null;
    return {
      ...this.lastInferenceMetadata,
      usage: this.lastInferenceMetadata.usage ? { ...this.lastInferenceMetadata.usage } : undefined,
    };
  }

  private resetInferenceMetadata(): void {
    this.lastInferenceMetadata = null;
  }

  private captureInferenceMetadata(metadata: {
    model?: string;
    stream: boolean;
    reasoning?: string;
    usage?: VllmInferenceMetadata['usage'];
  }): void {
    // Provider attribution and usage are durable evidence even when private
    // reasoning capture is disabled. Never retain or log reasoning implicitly.
    const reasoning = isInferenceMetadataCaptureEnabled() ? metadata.reasoning?.trim() : undefined;
    const usage = metadata.usage;

    this.lastInferenceMetadata = {
      model: metadata.model || this.model,
      ...(metadata.model ? { reportedModel: metadata.model } : {}),
      stream: metadata.stream,
      capturedAt: new Date().toISOString(),
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
    };

    try {
      promptLogger.info({
        model: metadata.model || this.model,
        provider: this.backendLabel,
        kind: metadata.stream ? 'stream-metadata' : 'chat-metadata',
        usage,
        ...(isInferenceMetadataCaptureEnabled() ? safeInferenceLog(reasoning) : {}),
        reasoning_chars: reasoning?.length ?? 0,
      }, 'Captured inference metadata');
    } catch {}
  }

  /** Build chat messages from a raw prompt string. */
  private buildMessages(
    prompt: string,
    params?: { glmThinking?: boolean },
  ): AIChatMessage[] {
    const systemPrompt = this.resolveSystemPromptForRequest(
      getSystemPrompt(this.model),
      params?.glmThinking ?? false,
    );
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];
  }

  private resolveSystemPromptForRequest(basePrompt: string, glmThinking: boolean): string {
    if (!isGlmModel(this.model) || this.backendLabel !== 'ollama') {
      return basePrompt;
    }
    return resolveGlmSystemPrompt(basePrompt, glmThinking);
  }

  private buildThinkingPayload(glmThinking: boolean, preserveThinking: boolean): Record<string, unknown> {
    // llama.cpp exposes thinking control through the chat-template parameters.
    // Apply it even when a deployment uses a generic model alias such as
    // "vllm": the server still resolves that alias to its loaded Qwen model.
    if (this.backendLabel === 'llamacpp') {
      return {
        chat_template_kwargs: {
          enable_thinking: glmThinking,
        },
      };
    }

    if (!isGlmModel(this.model) || this.backendLabel === 'ollama') {
      return {};
    }

    return {
      thinking: {
        type: glmThinking ? 'enabled' : 'disabled',
        clear_thinking: !preserveThinking,
      },
    };
  }

  private normalizeMessages(
    messages: AIChatMessage[],
    opts?: { thinking?: 'enabled' | 'disabled' },
  ): Array<Record<string, unknown>> {
    const glmThinking = (opts?.thinking ?? 'disabled') === 'enabled';
    const normalized = messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.tool_calls ? {
        tool_calls: message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })),
      } : {}),
    }));

    const defaultSystemPrompt = this.resolveSystemPromptForRequest(
      getSystemPrompt(this.model),
      glmThinking,
    );

    if (normalized[0]?.role === 'system') {
      normalized[0] = {
        ...normalized[0],
        content: this.resolveSystemPromptForRequest(
          String(normalized[0].content ?? defaultSystemPrompt),
          glmThinking,
        ),
      };
      return normalized;
    }

    return [{ role: 'system', content: defaultSystemPrompt }, ...normalized];
  }

  private normalizeFinishReason(reason?: string): AIChatCompletionResult['finishReason'] {
    if (reason === 'tool_calls') return 'tool_calls';
    if (reason === 'stop') return 'stop';
    if (reason === 'length') return 'length';
    return 'error';
  }

  /**
   * The effective model name for inference requests.
   * When a LoRA adapter is active on a backend that supports runtime adapters,
   * uses `<baseModel>:<adapterName>` so the request routes through the adapter.
   */
  get effectiveModel(): string {
    return this.activeAdapterName ? `${this.model}:${this.activeAdapterName}` : this.model;
  }

  // ─── Core request (non-streaming) ────────────────────────────────────────

  private async makeRequest(
    prompt: string,
    signal?: AbortSignal,
    params?: {
      temperature?: number;
      maxTokens?: number;
      glmThinking?: boolean;
      preserveThinking?: boolean;
      topP?: number;
      topK?: number;
      minP?: number;
      presencePenalty?: number;
      repeatPenalty?: number;
      seed?: number;
      thinkingBudgetTokens?: number;
      terminalPolicy?: InferenceTerminalPolicy;
    },
  ): Promise<string> {
    this.resetInferenceMetadata();

    // Circuit breaker
    const now = Date.now();
    if (now < this.breakerOpenUntil) {
      throw new Error('AI provider temporarily unavailable (circuit open)');
    }

    // Revision-bound callers cannot replay an uncertain provider effect.
    const maxAttempts = this.noTransportReplay ? 1 : 3;
    let attempt = 0;
    let lastErrorMsg = '';
    let serverRetryDelay = 0;

    while (attempt < maxAttempts) {
      attempt++;
      const jitter = Math.floor(Math.random() * 150);
      const backoff = Math.max((attempt - 1) * 250 + jitter, serverRetryDelay);
      serverRetryDelay = 0;
      if (attempt > 1) { await new Promise(r => setTimeout(r, backoff)); }

      try {
      try {
          promptLogger.info({ model: this.effectiveModel, provider: this.backendLabel, kind: 'chat', ...safeInferenceLog(prompt) });
        } catch {}

        const body: Record<string, unknown> = {
          model: this.effectiveModel,
          messages: this.buildMessages(prompt, { glmThinking: params?.glmThinking }),
          stream: false,
          max_tokens: params?.maxTokens ?? 4096,
          ...(this.backendLabel === 'ollama' ? { keep_alive: '30m' } : {}),
          ...this.buildThinkingPayload(
            params?.glmThinking ?? false,
            params?.preserveThinking ?? false,
          ),
          ...(typeof params?.topP === 'number' ? { top_p: params.topP } : {}),
          ...(typeof params?.topK === 'number' ? { top_k: params.topK } : {}),
          ...(typeof params?.minP === 'number' ? { min_p: params.minP } : {}),
          ...(typeof params?.presencePenalty === 'number' ? { presence_penalty: params.presencePenalty } : {}),
          ...(typeof params?.repeatPenalty === 'number' ? { repeat_penalty: params.repeatPenalty } : {}),
          ...(typeof params?.seed === 'number' ? { seed: params.seed } : {}),
          ...(typeof params?.thinkingBudgetTokens === 'number' ? { thinking_budget_tokens: params.thinkingBudgetTokens } : {}),
        };
        if (typeof params?.temperature === 'number') {
          body.temperature = params.temperature;
        }

        await admitReleaseMutation('provider','chat-completions',{model:this.effectiveModel,body});
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: inferenceRequestHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
          signal: combinedInferenceSignal(signal),
        });

        if (!res.ok) {
          const text = await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '');
          let detail = '';
          try { detail = JSON.parse(text).error?.message || JSON.parse(text).error || text; } catch { detail = text; }
          if (res.status === 429) serverRetryDelay = retryAfterMs(res) ?? 1_000;
          const isPermanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          const isModelError = /failed to (initialize|load) model|not found|not supported/i.test(detail);
          if (isPermanent || isModelError) {
            throw new Error(`Non-retryable HTTP ${res.status}: ${detail}`);
          }
          throw new Error(`HTTP ${res.status}: ${detail}`);
        }

        const data = await readBoundedJson<VllmChatResponse>(res);
        const msg = data.choices?.[0]?.message;
        this.captureInferenceMetadata({
          model: data.model,
          stream: false,
          reasoning: extractTextPayload(msg?.reasoning ?? msg?.reasoning_content),
          usage: normalizeUsage(data.usage),
        });
        // Use only content — reasoning_content is intentionally discarded (model reasoned, we keep output)
        const raw = stripThinkingBlocks((msg?.content || '').trim());
        if (!raw) {
          const finishReason = data.choices?.[0]?.finish_reason ?? 'unknown';
          throw new Error(`Inference returned no visible content (finish_reason=${finishReason})`);
        }
        enforceTerminalReason(data.choices?.[0]?.finish_reason, params?.terminalPolicy, raw);
        this.failureCount = 0;
        return raw;
      } catch (error) {
        if(error instanceof DocumentError&&(error.code.startsWith('DOCUMENT_ADMISSIONS_')||error.code===BOOK_AI_DISABLED))throw error;
        const msg = (error as Error).message || '';
        lastErrorMsg = msg;
        const nonRetryable = /Non-retryable/.test(msg);
        if (error instanceof InferenceTerminalError) {
          recordInferenceOutcome(
            error.code === 'INFERENCE_TRUNCATED' ? 'truncation'
              : error.code === 'INFERENCE_BLOCKED' ? 'content_filter'
                : 'policy_rejection',
            { backend: this.backendLabel, model: this.model, stream: false },
          );
          this.failureCount = 0;
          throw error;
        }
        if ((error as Error).name === 'AbortError' || signal?.aborted) throw error;
        logger.warn({ attempt, error: msg, backend: this.backendLabel }, 'Inference request attempt');
        if (nonRetryable) {
          throw new AIServiceError(error as Error, `AI generation failed (model: ${this.model})`);
        }
      }
    }

    // Open circuit after exhausting retries
    recordInferenceOutcome(
      /JSON|Unexpected token|no visible content|response exceeded/i.test(lastErrorMsg) ? 'protocol_failure' : 'provider_failure',
      { backend: this.backendLabel, model: this.model, stream: false },
    );
    this.failureCount++;
    const openMs = Math.min(5000 + this.failureCount * 1000, 20000);
    this.breakerOpenUntil = Date.now() + openMs;
    logger.error({ failureCount: this.failureCount, openMs, model: this.model, lastError: lastErrorMsg }, 'Opening AI circuit breaker');
    throw new AIServiceError(new Error(lastErrorMsg || 'All retry attempts failed'), `AI generation failed (model: ${this.model})`);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async generate(prompt: string, signal?: AbortSignal, params?: { temperature?: number; maxTokens?: number }): Promise<string> {
    return aiRequestQueue.enqueue(
      () => this.makeRequest(prompt, signal, params),
      'generate',
    );
  }

  async generateText(opts: { prompt: string; stream?: boolean; params?: InferenceRequestParams; signal?: AbortSignal; terminalPolicy?: InferenceTerminalPolicy }): Promise<string> {
    return aiRequestQueue.enqueue(
      () => this.makeRequest(opts.prompt, opts.signal, {
        temperature: typeof opts.params?.temperature === 'number' ? opts.params.temperature : undefined,
        maxTokens: typeof opts.params?.maxTokens === 'number' ? opts.params.maxTokens : undefined,
        glmThinking: typeof opts.params?.glmThinking === 'boolean' ? opts.params.glmThinking : undefined,
        preserveThinking: typeof opts.params?.glmPreserveThinking === 'boolean' ? opts.params.glmPreserveThinking : undefined,
        topP: opts.params?.topP,
        topK: opts.params?.topK,
        minP: opts.params?.minP,
        presencePenalty: opts.params?.presencePenalty,
        repeatPenalty: opts.params?.repeatPenalty,
        seed: opts.params?.seed,
        thinkingBudgetTokens: opts.params?.thinkingBudgetTokens,
        terminalPolicy: opts.terminalPolicy,
      }),
      'generateText',
    );
  }

  private async postChatJson(body: Record<string, unknown>, caller?: AbortSignal): Promise<VllmChatResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await admitReleaseMutation('provider','chat-completions',{model:this.effectiveModel,body});
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: inferenceRequestHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
          signal: combinedInferenceSignal(caller),
        });
        if (!res.ok) {
          const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          const wait = res.status === 429 ? retryAfterMs(res) : null;
          const text = await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '');
          if (!retryable) throw new Error(`Non-retryable HTTP ${res.status}: ${text}`);
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, wait ?? attempt * 500));
          lastError = new Error(`HTTP ${res.status}: ${text}`);
          continue;
        }
        return await readBoundedJson<VllmChatResponse>(res);
      } catch (error) {
        if(error instanceof DocumentError&&(error.code.startsWith('DOCUMENT_ADMISSIONS_')||error.code===BOOK_AI_DISABLED))throw error;
        if ((error as Error).name === 'AbortError' || caller?.aborted || /Non-retryable/.test((error as Error).message)) throw error;
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Inference request failed');
  }

  async generateChatCompletion(opts: AIChatCompletionOptions): Promise<AIChatCompletionResult> {
    this.resetInferenceMetadata();

    return aiRequestQueue.enqueue(async () => {
      const thinking = opts.thinking ?? 'disabled';
      const preserveThinking = opts.preserveThinking ?? false;
      const body: Record<string, unknown> = {
        model: this.effectiveModel,
        messages: this.normalizeMessages(opts.messages, { thinking }),
        stream: false,
        max_tokens: opts.maxTokens ?? 4096,
        ...(this.backendLabel === 'ollama' ? { keep_alive: '30m' } : {}),
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
        ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
        ...(typeof opts.topK === 'number' ? { top_k: opts.topK } : {}),
        ...(typeof opts.minP === 'number' ? { min_p: opts.minP } : {}),
        ...(typeof opts.presencePenalty === 'number' ? { presence_penalty: opts.presencePenalty } : {}),
        ...(typeof opts.repeatPenalty === 'number' ? { repeat_penalty: opts.repeatPenalty } : {}),
        ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
        ...(typeof opts.thinkingBudgetTokens === 'number' ? { thinking_budget_tokens: opts.thinkingBudgetTokens } : {}),
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
        ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
        ...(opts.toolStream ? { tool_stream: opts.toolStream } : {}),
        ...(opts.userId ? { user_id: opts.userId } : {}),
        ...this.buildThinkingPayload(thinking === 'enabled', preserveThinking),
      };

      try {
        promptLogger.info({
          model: this.effectiveModel,
          provider: this.backendLabel,
          kind: 'chat-completion',
          messageCount: opts.messages.length,
          messages: opts.messages.map((message) => ({ role: message.role, ...safeInferenceLog(message.content) })),
          toolCount: opts.tools?.length ?? 0,
          toolNames: opts.tools?.map((tool) => tool.function.name),
        });
      } catch {}

      const data = await this.postChatJson(body, opts.signal);
      const choice = data.choices?.[0];
      const message = choice?.message;
      const reasoningContent = extractTextPayload(message?.reasoning ?? message?.reasoning_content);
      const usage = normalizeUsage(data.usage);

      this.captureInferenceMetadata({
        model: data.model,
        stream: false,
        reasoning: reasoningContent,
        usage,
      });

      enforceTerminalReason(choice?.finish_reason, opts.terminalPolicy, stripThinkingBlocks((message?.content || '').trim()));

      return {
        model: data.model || this.model,
        message: {
          role: 'assistant',
          content: stripThinkingBlocks((message?.content || '').trim()),
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(normalizeToolCalls(message?.tool_calls) ? { tool_calls: normalizeToolCalls(message?.tool_calls) } : {}),
        },
        finishReason: this.normalizeFinishReason(choice?.finish_reason),
        usage,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(normalizeWebSearch(data.web_search) ? { webSearch: normalizeWebSearch(data.web_search) } : {}),
      };
    }, 'generateChatCompletion');
  }

  async runToolLoop(
    opts: AIChatCompletionOptions & {
      executeTool: (toolCall: AIToolCall) => Promise<unknown>;
      maxRounds?: number;
    },
  ): Promise<AIChatCompletionResult> {
    const maxRounds = Math.max(1, opts.maxRounds ?? 4);
    const messages = [...opts.messages];

    for (let round = 0; round < maxRounds; round += 1) {
      const completion = await this.generateChatCompletion({
        ...opts,
        messages,
        terminalPolicy: TERMINAL_REASON_POLICIES.agentLoop,
      });

      const toolCalls = completion.message.tool_calls ?? [];
      if (!toolCalls.length || completion.finishReason !== 'tool_calls') {
        return completion;
      }

      messages.push({
        role: 'assistant',
        content: completion.message.content,
        ...(opts.preserveThinking && completion.reasoningContent
          ? { reasoning_content: completion.reasoningContent }
          : {}),
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const toolResult = await opts.executeTool(toolCall);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        });
      }
    }

    throw new Error(`Tool loop exceeded ${maxRounds} rounds`);
  }

  // ─── Streaming via SSE (OpenAI-compatible) ───────────────────────────────

  async *generateStream(opts: { prompt: string; params?: Record<string, unknown>; signal?: AbortSignal; terminalPolicy?: InferenceTerminalPolicy }): AsyncGenerator<string> {
    this.resetInferenceMetadata();

    const now = Date.now();
    if (now < this.breakerOpenUntil) {
      throw new Error('AI provider temporarily unavailable (circuit open)');
    }

    const release = await aiRequestQueue.acquire('generateStream');
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const partialOutputHash = createHash('sha256');
    let partialOutputBytes = 0;
    let protocolErrors = 0;
    try {
      try {
        promptLogger.info({ model: this.effectiveModel, provider: this.backendLabel, kind: 'stream', ...safeInferenceLog(opts.prompt) });
      } catch {}

      const body: Record<string, unknown> = {
        model: this.effectiveModel,
        messages: this.buildMessages(opts.prompt, {
          glmThinking: typeof opts.params?.glmThinking === 'boolean' ? opts.params.glmThinking : undefined,
        }),
        stream: true,
        max_tokens: opts.params?.maxTokens ?? 4096,
        ...this.buildThinkingPayload(
          typeof opts.params?.glmThinking === 'boolean' ? opts.params.glmThinking : false,
          typeof opts.params?.glmPreserveThinking === 'boolean' ? opts.params.glmPreserveThinking : false,
        ),
      };
      if (typeof opts.params?.temperature === 'number') {
        body.temperature = opts.params.temperature;
      }

      await admitReleaseMutation('provider','chat-completions',{model:this.effectiveModel,body});
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: inferenceRequestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: combinedInferenceSignal(opts.signal),
      });

      if (!res.ok) {
        const text = await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader?.();
      if (!reader) {
        throw new Error('Inference SSE protocol error: response is missing readable body');
      }
      activeReader = reader;

      const decoder = new TextDecoder();
      let buffer = '';
      let eventData: string[] = [];
      let totalBytes = 0;
      let streamReasoning = '';
      let streamUsage: VllmInferenceMetadata['usage'];
      let streamReportedModel: string | undefined;
      let terminalFinishReason: string | null = null;
      let sawDone = false;
      const sanitizer = new ReasoningBlockSanitizer();
      const recordPartialOutput = (content: string) => {
        partialOutputHash.update(content);
        partialOutputBytes += Buffer.byteLength(content);
      };

      const parseEvent = (payload: string): { done: boolean; content?: string } => {
        if (payload.trim() === '[DONE]') return { done: true };
        try {
          const obj = JSON.parse(payload) as StreamChunk;
          if (typeof obj?.model === 'string' && obj.model) { streamReportedModel = obj.model; }
          const delta = obj.choices?.[0]?.delta;
          const reasoningDelta = extractTextPayload(delta?.reasoning ?? delta?.reasoning_content);
          if (reasoningDelta) streamReasoning += reasoningDelta;
          const usage = normalizeUsage(obj.usage);
          if (usage) streamUsage = usage;
          const finishReason = obj.choices?.[0]?.finish_reason;
          if (typeof finishReason === 'string' && finishReason) terminalFinishReason = finishReason;
          const content = delta?.content;
          if (typeof content === 'string' && content) recordPartialOutput(content);
          return { done: false, ...(typeof content === 'string' && content ? { content: sanitizer.push(content) } : {}) };
        } catch (error) {
          protocolErrors += 1;
          throw new Error(`Inference SSE protocol error: malformed JSON frame (${(error as Error).message})`);
        }
      };

      const readWithIdleTimeout = async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Inference stream idle timeout after ${inferenceLimits.idleTimeoutMs()}ms`)), inferenceLimits.idleTimeoutMs());
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      while (true) {
        const { done, value } = await readWithIdleTimeout();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > inferenceLimits.responseBytes()) throw new Error(`Inference stream exceeded ${inferenceLimits.responseBytes()} bytes`);
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > inferenceLimits.sseBufferBytes()) throw new Error(`Inference SSE buffer exceeded ${inferenceLimits.sseBufferBytes()} bytes`);

        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.length > inferenceLimits.sseLineBytes()) throw new Error(`Inference SSE line exceeded ${inferenceLimits.sseLineBytes()} bytes`);
          if (!line) {
            if (!eventData.length) continue;
            const event = parseEvent(eventData.join('\n'));
            eventData = [];
            if (event.content) yield event.content;
            if (event.done) {
              sawDone = true;
              enforceTerminalReason(terminalFinishReason, opts.terminalPolicy);
              if (typeof reader.cancel === 'function') await reader.cancel().catch(() => undefined);
              const tail = sanitizer.push('', true);
              if (tail) yield tail;
              this.captureInferenceMetadata({ model: streamReportedModel, stream: true, reasoning: streamReasoning, usage: streamUsage });
              this.failureCount = 0;
              return;
            }
            continue;
          }
          if (line.startsWith(':')) continue;
          if (line === 'data') eventData.push('');
          else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
        }
      }

      buffer += decoder.decode();
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
      if (buffer) {
        if (buffer.length > inferenceLimits.sseLineBytes()) throw new Error(`Inference SSE line exceeded ${inferenceLimits.sseLineBytes()} bytes`);
        if (buffer.startsWith('data:')) eventData.push(buffer.slice(5).replace(/^ /, ''));
      }
      if (eventData.length) {
        const event = parseEvent(eventData.join('\n'));
        if (event.content) yield event.content;
        if (event.done) sawDone = true;
      }
      const validTerminalReasons = new Set(['stop', 'length', 'tool_calls', 'content_filter']);
      if (protocolErrors || (!sawDone && !validTerminalReasons.has(terminalFinishReason ?? ''))) {
        throw new Error(`Inference stream premature EOF without a valid terminal event (finish_reason=${terminalFinishReason ?? 'missing'})`);
      }
      enforceTerminalReason(terminalFinishReason, opts.terminalPolicy);
      const tail = sanitizer.push('', true);
      if (tail) yield tail;

      this.captureInferenceMetadata({
        model: streamReportedModel,
        stream: true,
        reasoning: streamReasoning,
        usage: streamUsage,
      });
      this.failureCount = 0;
    } catch (error) {
      if(error instanceof DocumentError&&(error.code.startsWith('DOCUMENT_ADMISSIONS_')||error.code===BOOK_AI_DISABLED))throw error;
      const classification = classifyStreamError(error, opts.signal);
      if (classification.outcome) {
        recordInferenceOutcome(classification.outcome, { backend: this.backendLabel, model: this.model, stream: true });
      }
      if (classification.outcome && !classification.affectsProviderHealth) this.failureCount = 0;
      let openMs = 0;
      if (classification.affectsProviderHealth) {
        this.failureCount++;
        openMs = Math.min(5000 + this.failureCount * 1000, 20000);
        this.breakerOpenUntil = Date.now() + openMs;
      }
      logger.error({
        failureCount: this.failureCount,
        affectsProviderHealth: classification.affectsProviderHealth,
        outcome: classification.outcome,
        openMs,
        err: (error as Error).message,
        backend: this.backendLabel,
        protocolErrors,
        partialOutputBytes,
        partialOutputHash: partialOutputHash.copy().digest('hex'),
      }, classification.affectsProviderHealth ? 'Inference stream error, opening circuit' : 'Inference stream terminal outcome');
      throw error;
    } finally {
      if (typeof activeReader?.cancel === 'function') await activeReader.cancel().catch(() => undefined);
      release();
    }
  }

  supports(type: 'chat' | 'completion' | 'json'): boolean {
    return type === 'completion' || type === 'json' || type === 'chat';
  }

  // ─── Entity generators (JSON extraction + AJV validation) ────────────────

  async generateCharacter(prompt: string): Promise<Character> {
    const response = await this.makeRequest(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const schema: SchemaObject = {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            traits: { type: 'array', items: { type: 'string' } },
            background: { type: 'string' }
          },
          required: ['name', 'description'],
          additionalProperties: true
        };
        const validate = this.ajv.compile(schema);
        if (!validate(parsed)) {
          logger.warn({ errors: validate.errors }, 'AI JSON validation failed (character)');
          throw new Error('Invalid character JSON');
        }
        return parsed as Character;
      }
      return { name: 'Generated Character', description: response, traits: [], background: '' };
    } catch {
      return { name: 'Generated Character', description: response, traits: [], background: '' };
    }
  }

  async generateLocation(prompt: string): Promise<Location> {
    const response = await this.makeRequest(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const schema: SchemaObject = {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            atmosphere: { type: 'string' },
            significance: { type: 'string' }
          },
          required: ['name', 'description'],
          additionalProperties: true
        };
        const validate = this.ajv.compile(schema);
        if (!validate(parsed)) {
          logger.warn({ errors: validate.errors }, 'AI JSON validation failed (location)');
          throw new Error('Invalid location JSON');
        }
        return parsed as Location;
      }
      return { name: 'Generated Location', description: response, atmosphere: '', significance: '' };
    } catch {
      return { name: 'Generated Location', description: response, atmosphere: '', significance: '' };
    }
  }

  async generateItem(prompt: string): Promise<Item> {
    const response = await this.makeRequest(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const schema: SchemaObject = {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            properties: { type: 'array', items: { type: 'string' } },
            significance: { type: 'string' }
          },
          required: ['name', 'description'],
          additionalProperties: true
        };
        const validate = this.ajv.compile(schema);
        if (!validate(parsed)) {
          logger.warn({ errors: validate.errors }, 'AI JSON validation failed (item)');
          throw new Error('Invalid item JSON');
        }
        return parsed as Item;
      }
      return { name: 'Generated Item', description: response, properties: [], significance: '' };
    } catch {
      return { name: 'Generated Item', description: response, properties: [], significance: '' };
    }
  }

  async generateStoryOutline(prompt: string): Promise<string> {
    return this.makeRequest(prompt);
  }

  async generateSummary(prompt: string): Promise<string> {
    return this.makeRequest(prompt);
  }

  async generateTitle(prompt: string): Promise<string> {
    return this.makeRequest(prompt);
  }

  async generateTagline(prompt: string): Promise<string> {
    return this.makeRequest(prompt);
  }

  async generateInlineSuggestion(prompt: string): Promise<string> {
    return this.makeRequest(prompt);
  }

  async generateFeedback(prompt: string): Promise<string> {
    return this.makeRequest(prompt);
  }

  async generateBookStructure(prompt: string): Promise<Record<string, unknown>> {
    const response = await this.makeRequest(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const schema: SchemaObject = {
          type: 'object',
          properties: {
            acts: {
              type: 'array',
              items: {
                type: 'object',
                properties: { chapters: { type: 'array', items: { type: 'object' } } },
                required: ['chapters']
              }
            }
          },
          required: ['acts']
        };
        const validate = this.ajv.compile(schema);
        if (!validate(parsed)) {
          logger.warn({ errors: validate.errors }, 'AI JSON validation failed (structure)');
          throw new Error('Invalid structure JSON');
        }
        return parsed as Record<string, unknown>;
      }
      return this.defaultBookStructure(response);
    } catch {
      return this.defaultBookStructure(response);
    }
  }

  private defaultBookStructure(description: string): Record<string, unknown> {
    const defaultActs = 3;
    const defaultChapters = 5;
    return {
      acts: Array.from({ length: defaultActs }, (_, i) => ({
        act: i + 1,
        title: `Act ${i + 1}`,
        description: description || `Act ${i + 1} description`,
        chapters: Array.from({ length: defaultChapters }, (_, j) => ({
          chapter: j + 1,
          title: `Chapter ${i * defaultChapters + j + 1}`,
          description: 'Chapter description',
          wordCount: '2000-4000'
        }))
      }))
    };
  }

  // ─── Model listing via active inference backend /v1/models ───────────────

  async getAvailableModels(): Promise<string[]> {
    try {
      const models = await fetchInferenceModelIds(this.baseUrl);
      return models.length > 0 ? models : [this.model];
    } catch (error) {
      logger.warn({ err: error, backend: this.backendLabel }, 'Failed to fetch available models from the inference backend');
      return [this.model];
    }
  }

  // ─── Dynamic LoRA adapter management ─────────────────────────────────────

  async loadAdapter(name: string, path: string, inPlace = false): Promise<boolean> {
    if (!this.supportsDynamicAdapters()) {
      logger.warn({ name, path, backend: this.backendLabel }, 'Dynamic adapters are unavailable on the active inference backend');
      return false;
    }
    try {
      await admitReleaseMutation('provider','load-lora',{model:this.effectiveModel});
      const res = await fetch(`${this.baseUrl}/v1/load_lora_adapter`, {
        method: 'POST',
        headers: inferenceRequestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          lora_name: name,
          lora_path: path,
          ...(inPlace ? { load_inplace: true } : {}),
        }),
        signal: combinedInferenceSignal(),
      });
      if (!res.ok) {
        const text = await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '');
        logger.error({ name, path, status: res.status, body: text }, 'Failed to load LoRA adapter');
        return false;
      }
      logger.info({ name, path, inPlace }, 'LoRA adapter loaded successfully');
      return true;
    } catch (error) {
      logger.error({ err: error, name, path }, 'Error loading LoRA adapter');
      return false;
    }
  }

  async unloadAdapter(name: string): Promise<boolean> {
    if (!this.supportsDynamicAdapters()) {
      logger.warn({ name, backend: this.backendLabel }, 'Dynamic adapters are unavailable on the active inference backend');
      return false;
    }
    try {
      await admitReleaseMutation('provider','unload-lora',{model:this.effectiveModel});
      const res = await fetch(`${this.baseUrl}/v1/unload_lora_adapter`, {
        method: 'POST',
        headers: inferenceRequestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ lora_name: name }),
        signal: combinedInferenceSignal(),
      });
      if (!res.ok) {
        const text = await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '');
        logger.error({ name, status: res.status, body: text }, 'Failed to unload LoRA adapter');
        return false;
      }
      logger.info({ name }, 'LoRA adapter unloaded successfully');
      return true;
    } catch (error) {
      logger.error({ err: error, name }, 'Error unloading LoRA adapter');
      return false;
    }
  }
}

/**
 * Shared singleton VllmService instance.
 *
 * Use this when adapter state (the active adapter) must persist across multiple
 * requests — e.g. from the adapter admin routes.
 * Controllers that only need one-shot generation can still instantiate their own.
 */
export const vllmService = new VllmService();
