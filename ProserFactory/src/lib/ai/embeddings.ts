/**
 * Embedding service using the OpenAI-compatible /v1/embeddings endpoint.
 *
 * Uses the configured embedding model (default: nomic-embed-text) to
 * generate vector representations of text. This is the foundation of
 * semantic retrieval in the unified RAG pipeline.
 *
 * @module ai/embeddings
 */

import logger from '@/lib/logger';
import { CONFIG } from '@/core/config';
import { withRetry } from '@/lib/resilience';
import {
  combinedInferenceSignal,
  inferenceLimits,
  inferenceRequestHeaders,
  readBoundedBody,
  readBoundedJson,
  retryAfterMs,
} from '@/lib/ai/transport';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

/**
 * Generate an embedding vector for the given text via the active OpenAI-compatible endpoint.
 *
 * Falls back to null (never throws) so callers can degrade to keyword retrieval.
 */
export async function generateEmbedding(
  text: string,
  model?: string
): Promise<EmbeddingResult | null> {
  const embeddingModel = model || CONFIG.RAG_EMBEDDING_MODEL;
  const host = (
    CONFIG.INFERENCE_HOST ||
    CONFIG.OLLAMA_BASE_URL ||
    CONFIG.OLLAMA_HOST ||
    CONFIG.VLLM_BASE_URL
  ).replace(/\/+$/, '');

  try {
    const result = await withRetry(
      async (signal) => {
        const res = await fetch(`${host}/v1/embeddings`, {
          method: 'POST',
          headers: inferenceRequestHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            model: embeddingModel,
            input: text,
          }),
          signal: combinedInferenceSignal(signal),
        });
        if (!res.ok) {
          if (res.status === 429) await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res) ?? 1_000));
          throw new Error(`Embedding HTTP ${res.status}: ${await readBoundedBody(res, inferenceLimits.errorBytes()).catch(() => '')}`);
        }
        const data = await readBoundedJson<{ data?: Array<{ embedding: number[] }> }>(res);
        const embedding = data?.data?.[0]?.embedding;
        if (!embedding || !Array.isArray(embedding)) {
          throw new Error('Invalid embedding response: missing embedding array');
        }
        return { embedding, model: embeddingModel };
      },
      2,
      (attempt, err) =>
        logger.warn({ attempt, error: (err as Error).message }, 'Embedding retry'),
      { timeoutMs: 15000, jitter: true }
    );
    return result;
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, model: embeddingModel },
      'Embedding generation failed — falling back to keyword retrieval'
    );
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in sequence.
 * Returns null entries for any text that fails.
 */
export async function generateEmbeddings(
  texts: string[],
  model?: string
): Promise<Array<EmbeddingResult | null>> {
  const results: Array<EmbeddingResult | null> = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text, model));
  }
  return results;
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 if either vector is empty or they have different dimensions.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
