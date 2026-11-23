import { z } from 'zod';
import dotenv from 'dotenv';
import { installedRevision } from './installedRevision';
import { loadInferenceSettingsFile } from './inferenceSettingsFile';

// Ensure environment variables from .env and .env.local are loaded before parsing
// This file may be imported before the server initializes dotenv, so we load here too.
const inheritedEnvironment = { ...process.env };
try { dotenv.config({ quiet: true }); } catch {}
try { dotenv.config({ path: '.env.local', override: true }); } catch {}
Object.assign(process.env, inheritedEnvironment);
loadInferenceSettingsFile();

const revision = installedRevision();
if (revision) { process.env.GIT_COMMIT = revision; process.env.COMMIT_SHA = revision; }

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Preferred inference endpoint/model (llama.cpp on inference-host). Legacy OLLAMA_*/VLLM_* vars remain supported.
  INFERENCE_BACKEND: z.enum(['ollama', 'llamacpp', 'vllm']).default('llamacpp'),
  INFERENCE_HOST: z.string().url().optional(),
  INFERENCE_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:8000'),
  OLLAMA_HOST: z.string().url().optional(),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.6-35b'),
  VLLM_BASE_URL: z.string().url().default('http://127.0.0.1:8000'),
  VLLM_MODEL: z.string().min(1).default('qwen3.6-35b'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().optional(),
  CORS_ALLOWLIST: z.string().optional(),
  GIT_COMMIT: z.string().optional(),
  COMMIT_SHA: z.string().optional(),
  BUILD_ID: z.string().optional(),
  // Image generation (Qwen Image 2.1 on WebUI Forge)
  WEBUI_FORGE_URL: z.string().url().default('http://127.0.0.1:7861'),
  FORGE_MODEL: z.string().min(1).default('qwen-image-2.1'),
  FORGE_SAMPLER: z.string().min(1).default('Euler'),
  FORGE_SCHEDULER: z.string().min(1).default('Simple'),
  FORGE_STEPS: z.coerce.number().int().min(1).max(100).default(32),
  // Optional public base URL for generating absolute links (e.g., http://127.0.0.1:3001)
  PUBLIC_BASE_URL: z.string().url().optional(),
  // BullMQ feature flag and settings
  USE_BULLMQ: z.string().transform(v => String(v).toLowerCase() === 'true').optional(),
  BULLMQ_PREFIX: z.string().default('proser'),
  WIZARD_QUEUE_CONCURRENCY: z.string().optional(),
  // RAG Orchestrator feature flags (Priority A - Phase 1)
  RAG_ORCHESTRATOR_ENABLED: z.string().transform(v => String(v).toLowerCase() === 'true').optional(),
  RAG_SEMANTIC_ENABLED: z.string().transform(v => String(v).toLowerCase() === 'true').optional(),
  RAG_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),
  RAG_EMBEDDING_VERSION: z.string().default('1.0.0'),
  RAG_SIMILARITY_THRESHOLD: z.string().transform(Number).prefault('0.3'),
  RAG_MAX_CHUNKS: z.string().transform(Number).prefault('240'),
  RAG_TOKEN_BUDGET: z.string().transform(Number).prefault('120000'),
  RAG_MMR_LAMBDA: z.string().transform(Number).prefault('0.7'),
  // Narrative Memory Layer feature flags (Priority B - Phase 2)
  RAG_MEMORY_ENABLED: z.string().transform(v => String(v).toLowerCase() === 'true').optional(),
  MEMORY_EXTRACTION_ASYNC: z.string().transform(v => String(v).toLowerCase() !== 'false').prefault('true'),
  MEMORY_EXTRACTION_CONFIDENCE_MIN: z.string().transform(Number).prefault('0.5'),
  // Skills Runtime feature flags (Priority B - Phase 3)
  SKILLS_RUNTIME_ENABLED: z.string().transform(v => String(v).toLowerCase() === 'true').optional(),
  SKILLS_MODE: z.enum(['sync', 'async', 'disabled']).default('async'),
  SKILLS_CONFIDENCE_THRESHOLD: z.string().transform(Number).prefault('0.6'),
  // TLS / HTTPS
  TLS_ENABLED: z.string().transform(v => String(v).toLowerCase() === 'true').optional(),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  TLS_CA_FILE: z.string().optional(),
}).superRefine((config, ctx) => {
  if (config.NODE_ENV !== 'production') return;
  for (const key of ['INTERNAL_API_SECRET', 'FACTORY_AUTH_SECRET', 'HERMES_AGENT_AUTH_SECRET', 'METRICS_TOKEN']) {
    if (/^(?:change-me(?:-|$)|replace-with-)/i.test(process.env[key]?.trim() ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Replace the example credential with an independently generated secret' });
    }
  }
  const inferenceUrl = config.INFERENCE_HOST || config.OLLAMA_BASE_URL || config.VLLM_BASE_URL;
  if (!isLoopbackUrl(inferenceUrl) && !config.INFERENCE_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['INFERENCE_API_KEY'],
      message: 'INFERENCE_API_KEY is required for a non-loopback production inference backend',
    });
  }
});

export type AppConfig = z.infer<typeof Schema>;

export const CONFIG: AppConfig = Schema.parse(process.env);
