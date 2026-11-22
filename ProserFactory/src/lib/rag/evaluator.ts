/**
 * RAG evaluation harness — measures retrieval quality offline.
 *
 * Provides scenario replay, IR metrics computation (Recall@K, MRR, nDCG),
 * and token efficiency analysis. Results are stored in the `RagEvalResult`
 * table and exposed via OTel metrics.
 *
 * @module rag/evaluator
 */

import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import logger from '@/lib/logger';
import * as ragMetrics from '@/metrics/rag';
import { ragOrchestrator } from '@/lib/rag/orchestrator';
import type { OrchestratorInput, OrchestratorResult, RagSourceType } from '@/lib/rag/types';

// ---------------------------------------------------------------------------
// Evaluation types
// ---------------------------------------------------------------------------

export interface EvalScenario {
  /** Unique label for this scenario */
  name: string;
  /** Orchestrator input */
  input: OrchestratorInput;
  /** Expected codex entry IDs that should appear in results */
  expectedIds: number[];
  /** Expected source types that should appear */
  expectedSourceTypes?: RagSourceType[];
}

export interface EvalMetrics {
  /** Recall@K: fraction of expected IDs that were retrieved */
  recallAtK: number;
  /** Mean Reciprocal Rank: 1/rank of first expected hit */
  mrr: number;
  /** Normalized Discounted Cumulative Gain */
  ndcg: number;
  /** Token efficiency: useful tokens / total tokens */
  tokenEfficiency: number;
  /** Total retrieval+composition time (ms) */
  latencyMs: number;
  /** Number of candidates */
  candidates: number;
  /** Number of selected chunks */
  selected: number;
  /** Semantic retrieval available */
  semanticAvailable: boolean;
}

export interface EvalResult {
  scenario: string;
  metrics: EvalMetrics;
  orchestrator: 'unified' | 'legacy';
  timestamp: string;
}

// ---------------------------------------------------------------------------
// IR metric computations
// ---------------------------------------------------------------------------

/**
 * Recall@K: what fraction of expected items appeared in the top-K results?
 */
export function computeRecallAtK(
  retrievedIds: number[],
  expectedIds: number[]
): number {
  if (expectedIds.length === 0) return 1;
  const retrieved = new Set(retrievedIds);
  const hits = expectedIds.filter((id) => retrieved.has(id));
  return hits.length / expectedIds.length;
}

/**
 * Mean Reciprocal Rank: 1 / position of first relevant result.
 */
export function computeMRR(
  retrievedIds: number[],
  expectedIds: number[]
): number {
  const expectedSet = new Set(expectedIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (expectedSet.has(retrievedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Normalized Discounted Cumulative Gain.
 * Binary relevance: 1 if in expected set, 0 otherwise.
 */
export function computeNDCG(
  retrievedIds: number[],
  expectedIds: number[]
): number {
  const expectedSet = new Set(expectedIds);

  // DCG of actual results
  let dcg = 0;
  for (let i = 0; i < retrievedIds.length; i++) {
    if (expectedSet.has(retrievedIds[i])) {
      dcg += 1 / Math.log2(i + 2); // i+2 because log2(1)=0
    }
  }

  // Ideal DCG: all expected items at top
  let idcg = 0;
  for (let i = 0; i < expectedIds.length; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Token efficiency: fraction of tokens that belong to "useful" chunks
 * (those whose codex IDs are in the expected set).
 */
export function computeTokenEfficiency(
  result: OrchestratorResult,
  expectedIds: number[]
): number {
  const expectedSet = new Set(expectedIds);
  let usefulTokens = 0;
  let totalTokens = 0;

  for (const section of result.context.sections) {
    for (const chunk of section.chunks) {
      totalTokens += chunk.tokenCount;
      if (chunk.metadata.codexId && expectedSet.has(chunk.metadata.codexId as number)) {
        usefulTokens += chunk.tokenCount;
      }
    }
  }

  return totalTokens === 0 ? 0 : usefulTokens / totalTokens;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Run a single evaluation scenario against the unified orchestrator.
 */
export async function evaluateScenario(
  scenario: EvalScenario
): Promise<EvalResult> {
  const t0 = performance.now();
  const result = await ragOrchestrator.compose(scenario.input);
  const latencyMs = performance.now() - t0;

  const retrievedIds = result.codexUsed.map((c) => c.id);

  const evalMetrics: EvalMetrics = {
    recallAtK: computeRecallAtK(retrievedIds, scenario.expectedIds),
    mrr: computeMRR(retrievedIds, scenario.expectedIds),
    ndcg: computeNDCG(retrievedIds, scenario.expectedIds),
    tokenEfficiency: computeTokenEfficiency(result, scenario.expectedIds),
    latencyMs,
    candidates: result.context.diagnostics.totalCandidates,
    selected: result.context.diagnostics.totalSelected,
    semanticAvailable: result.context.diagnostics.semanticAvailable,
  };

  ragMetrics.incEvalRun('retrieval', { book_id: scenario.input.bookId });

  return {
    scenario: scenario.name,
    metrics: evalMetrics,
    orchestrator: 'unified',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run a batch of evaluation scenarios and store results.
 */
export async function evaluateBatch(
  scenarios: EvalScenario[]
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    try {
      const result = await evaluateScenario(scenario);
      results.push(result);

      // Store in database for trend analysis
      try {
        await databaseService.client.ragEvalResult.create({
          data: {
            bookId: scenario.input.bookId,
            sceneId: scenario.input.sceneId,
            evalType: 'retrieval',
            metrics: result.metrics as unknown as Prisma.InputJsonValue,
            orchestrator: result.orchestrator,
          },
        });
      } catch {
        // Table may not exist yet
      }
    } catch (err) {
      logger.warn(
        { scenario: scenario.name, error: (err as Error).message },
        'Evaluation scenario failed'
      );
    }
  }

  // Log summary
  if (results.length > 0) {
    const avgRecall =
      results.reduce((sum, r) => sum + r.metrics.recallAtK, 0) /
      results.length;
    const avgMRR =
      results.reduce((sum, r) => sum + r.metrics.mrr, 0) / results.length;
    const avgNDCG =
      results.reduce((sum, r) => sum + r.metrics.ndcg, 0) / results.length;
    const avgEfficiency =
      results.reduce((sum, r) => sum + r.metrics.tokenEfficiency, 0) /
      results.length;
    const avgLatency =
      results.reduce((sum, r) => sum + r.metrics.latencyMs, 0) /
      results.length;

    logger.info(
      {
        scenarios: results.length,
        avgRecall: avgRecall.toFixed(3),
        avgMRR: avgMRR.toFixed(3),
        avgNDCG: avgNDCG.toFixed(3),
        avgTokenEfficiency: avgEfficiency.toFixed(3),
        avgLatencyMs: Math.round(avgLatency),
      },
      'RAG evaluation batch complete'
    );
  }

  return results;
}

/**
 * Build evaluation scenarios from a book's existing scenes.
 * Uses SceneCodexUsage provenance records as ground truth.
 */
export async function buildScenariosFromBook(
  bookId: number
): Promise<EvalScenario[]> {
  const scenes = await databaseService.client.scene.findMany({
    where: {
      chapter: { act: { bookId } },
      outline: { not: null },
    },
    include: {
      codexUsages: true,
      chapter: {
        include: { act: true },
      },
    },
    orderBy: { id: 'asc' },
    take: 20, // Limit to avoid overwhelming
  });

  const scenarios: EvalScenario[] = [];

  for (const scene of scenes) {
    if (!scene.outline || scene.codexUsages.length === 0) continue;

    scenarios.push({
      name: `book-${bookId}-scene-${scene.id}`,
      input: {
        bookId,
        sceneId: scene.id,
        chapterId: scene.chapterId,
        actNumber: scene.chapter.act.actNumber,
        chapterNumber: scene.chapter.chapterNumber,
        queryText: [scene.outline, scene.summary].filter(Boolean).join(' '),
      },
      expectedIds: scene.codexUsages.map((u) => u.codexId),
    });
  }

  return scenarios;
}
