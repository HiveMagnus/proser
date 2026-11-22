/**
 * Hybrid retrieval reranker with MMR diversity.
 *
 * Combines semantic, keyword, recency, and entity overlap signals into
 * a single score. Applies Maximal Marginal Relevance (MMR) to ensure
 * context diversity — avoids all slots going to one character when
 * the scene needs five.
 *
 * @module rag/reranker
 */

import { cosineSimilarity } from '@/lib/ai/embeddings';
import type { RagChunk, RagSourceType } from '@/lib/rag/types';
import { DEFAULT_SCORING_WEIGHTS } from '@/lib/rag/types';

// ---------------------------------------------------------------------------
// Weighted scoring
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  semantic: number;
  keyword: number;
  recency: number;
  entityOverlap: number;
}

/**
 * Compute entity overlap score for a chunk against character names in the scene.
 */
export function computeEntityOverlap(
  chunkText: string,
  characterNames: string[]
): number {
  if (!characterNames.length) return 0;
  const lower = chunkText.toLowerCase();
  let hits = 0;
  for (const name of characterNames) {
    if (lower.includes(name.toLowerCase())) hits++;
  }
  return hits / characterNames.length;
}

/**
 * Apply weighted scoring to all chunks and set their `scores.combined` value.
 */
export function applyWeightedScoring(
  chunks: RagChunk[],
  characterNames: string[] = [],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): RagChunk[] {
  for (const chunk of chunks) {
    if (!chunk.scores) {
      chunk.scores = {
        semantic: 0,
        keyword: 0,
        recency: 0,
        entityOverlap: 0,
        combined: 0,
      };
    }

    // Compute entity overlap if not already set
    if (chunk.scores.entityOverlap === 0 && characterNames.length > 0) {
      chunk.scores.entityOverlap = computeEntityOverlap(
        chunk.text,
        characterNames
      );
    }

    chunk.scores.combined =
      weights.semantic * chunk.scores.semantic +
      weights.keyword * chunk.scores.keyword +
      weights.recency * chunk.scores.recency +
      weights.entityOverlap * chunk.scores.entityOverlap;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// MMR diversity selection
// ---------------------------------------------------------------------------

/**
 * Maximal Marginal Relevance selection.
 *
 * Selects up to `k` chunks that balance relevance (combined score) with
 * diversity (low similarity to already-selected chunks).
 *
 * @param lambda 0.0 = max diversity, 1.0 = max relevance. Default 0.7.
 */
export function mmrSelect(
  chunks: RagChunk[],
  k: number,
  lambda: number = 0.7
): RagChunk[] {
  if (chunks.length <= k) return chunks;

  // Sort by combined score descending
  const sorted = [...chunks].sort(
    (a, b) => (b.scores?.combined ?? 0) - (a.scores?.combined ?? 0)
  );

  const selected: RagChunk[] = [sorted[0]];
  const remaining = new Set(sorted.slice(1));

  while (selected.length < k && remaining.size > 0) {
    let bestChunk: RagChunk | null = null;
    let bestMmrScore = -Infinity;

    for (const candidate of remaining) {
      const relevance = candidate.scores?.combined ?? 0;

      // Max similarity to any already-selected chunk
      let maxSim = 0;
      for (const sel of selected) {
        const sim = chunkSimilarity(candidate, sel);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestChunk = candidate;
      }
    }

    if (bestChunk) {
      selected.push(bestChunk);
      remaining.delete(bestChunk);
    } else {
      break;
    }
  }

  return selected;
}

/**
 * Compute similarity between two chunks.
 * Prefers embedding cosine similarity; falls back to source-type overlap.
 */
function chunkSimilarity(a: RagChunk, b: RagChunk): number {
  // If both have embeddings, use cosine similarity
  if (a.embedding && b.embedding) {
    return cosineSimilarity(a.embedding, b.embedding);
  }
  // Fallback: same source type = somewhat redundant
  if (a.sourceType === b.sourceType) return 0.3;
  return 0;
}

// ---------------------------------------------------------------------------
// Full reranking pipeline
// ---------------------------------------------------------------------------

export interface RerankOptions {
  k: number;
  mmrLambda?: number;
  characterNames?: string[];
  weights?: ScoringWeights;
  /** Minimum combined score to qualify */
  minScore?: number;
}

/**
 * Full hybrid reranking pipeline:
 * 1. Apply weighted scoring (semantic + keyword + recency + entity overlap)
 * 2. Filter by minimum score threshold
 * 3. Apply MMR diversity selection
 */
export function rerank(chunks: RagChunk[], options: RerankOptions): RagChunk[] {
  const {
    k,
    mmrLambda = 0.7,
    characterNames = [],
    weights = DEFAULT_SCORING_WEIGHTS,
    minScore = 0.05,
  } = options;

  // 1. Score all chunks
  applyWeightedScoring(chunks, characterNames, weights);

  // 2. Filter by minimum score
  const qualified = chunks.filter(
    (c) => (c.scores?.combined ?? 0) >= minScore
  );

  // 3. MMR selection
  return mmrSelect(qualified, k, mmrLambda);
}

// ---------------------------------------------------------------------------
// Per-source budget allocation
// ---------------------------------------------------------------------------

/**
 * Allocate chunks per source type within token budgets.
 *
 * Takes the globally reranked list and distributes slots to ensure
 * diversity across source types.
 */
export function allocateBySourceBudget(
  chunks: RagChunk[],
  totalBudget: number,
  sourceBudgets: Partial<Record<RagSourceType, number>> = {}
): RagChunk[] {
  // Group by source type
  const groups = new Map<RagSourceType, RagChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.sourceType) || [];
    group.push(chunk);
    groups.set(chunk.sourceType, group);
  }

  const result: RagChunk[] = [];
  let tokensUsed = 0;

  // First pass: allocate per-source budgets
  for (const [sourceType, group] of groups) {
    const budgetFraction = sourceBudgets[sourceType] ?? 0.15;
    const sourceBudget = Math.floor(totalBudget * budgetFraction);
    let sourceTokens = 0;

    // Sort group by combined score
    group.sort((a, b) => (b.scores?.combined ?? 0) - (a.scores?.combined ?? 0));

    for (const chunk of group) {
      if (sourceTokens + chunk.tokenCount > sourceBudget) continue;
      if (tokensUsed + chunk.tokenCount > totalBudget) continue;
      result.push(chunk);
      sourceTokens += chunk.tokenCount;
      tokensUsed += chunk.tokenCount;
    }
  }

  // Second pass: fill remaining budget with highest-scored unselected chunks
  const selectedIds = new Set(result.map((c) => c.id));
  const remaining = chunks
    .filter((c) => !selectedIds.has(c.id))
    .sort((a, b) => (b.scores?.combined ?? 0) - (a.scores?.combined ?? 0));

  for (const chunk of remaining) {
    if (tokensUsed + chunk.tokenCount > totalBudget) continue;
    result.push(chunk);
    tokensUsed += chunk.tokenCount;
  }

  return result;
}
