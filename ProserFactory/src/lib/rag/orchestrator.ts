/**
 * Unified RAG Orchestrator — single entry point for all retrieval.
 *
 * Replaces the dual retrieval paths (`CodexRetrievalService.getRelevantCodex`
 * and `applyCodexRAG` in SceneProseService) with one orchestrated, testable
 * pipeline that supports:
 *
 * - Semantic retrieval via Ollama embeddings (when RAG_SEMANTIC_ENABLED)
 * - Keyword-boosted hybrid reranking
 * - MMR diversity selection
 * - Hard token budget enforcement
 * - Structured context composition
 * - Full observability via OTel metrics and structured RAG logs
 * - Graceful degradation to keyword-only or empty context
 *
 * @module rag/orchestrator
 */

import { CONFIG } from '@/core/config';
import { generateEmbedding } from '@/lib/ai/embeddings';
import logger from '@/lib/logger';
import { logRag } from '@/lib/ragLogger';
import { trace } from '@opentelemetry/api';
import * as ragMetrics from '@/metrics/rag';

import type {
  OrchestratorInput,
  OrchestratorResult,
  RagChunk,
} from '@/lib/rag/types';
import { DEFAULT_SOURCE_BUDGETS } from '@/lib/rag/types';
import { CodexSource } from '@/lib/rag/sources';
import { TimelineSource, CharacterStateSource, ThreadSource, NarrativeArtifactSource } from '@/lib/rag/sources';
import { rerank, allocateBySourceBudget } from '@/lib/rag/reranker';
import { composeContext, formatPromptSection } from '@/lib/rag/composer';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RagOrchestrator {
  private sources = [
    new CodexSource(),
    // Memory sources are conditionally fetched based on RAG_MEMORY_ENABLED
  ];

  /** Memory sources loaded when RAG_MEMORY_ENABLED is true */
  private memorySources = [
    new TimelineSource(),
    new CharacterStateSource(),
    new ThreadSource(),
    new NarrativeArtifactSource(),
  ];

  /** Get active sources based on config */
  private getActiveSources() {
    if (CONFIG.RAG_MEMORY_ENABLED) {
      return [...this.sources, ...this.memorySources];
    }
    return this.sources;
  }

  /**
   * Main entry point: retrieve, rerank, compose.
   *
   * When `RAG_ORCHESTRATOR_ENABLED` is false, returns an empty result
   * (callers should fall back to the legacy `applyCodexRAG` path).
   */
  async compose(input: OrchestratorInput): Promise<OrchestratorResult> {
    const tracer = trace.getTracer('rag-orchestrator');

    return await tracer.startActiveSpan('rag.orchestrator.compose', async (span) => {
      const t0 = performance.now();
      const fallbackReasons: string[] = [];

      span.setAttributes({
        bookId: input.bookId,
        sceneId: input.sceneId ?? 0,
        tokenBudget: input.tokenBudget ?? CONFIG.RAG_TOKEN_BUDGET,
      });

      try {
        ragMetrics.incOrchestratorCalls({
          book_id: input.bookId,
          scene_id: input.sceneId,
        });

        const tokenBudget = input.tokenBudget ?? CONFIG.RAG_TOKEN_BUDGET;
        const mmrLambda = input.mmrLambda ?? CONFIG.RAG_MMR_LAMBDA;

        // ---------------------------------------------------------------
        // 1. Generate query embedding (if semantic enabled)
        // ---------------------------------------------------------------
        let queryEmbedding: number[] | undefined;
        let semanticAvailable = false;

        if (CONFIG.RAG_SEMANTIC_ENABLED) {
          const embT0 = performance.now();
          const embResult = await generateEmbedding(input.queryText);
          const embMs = performance.now() - embT0;
          ragMetrics.recordEmbeddingTime(embMs, { book_id: input.bookId });

          if (embResult) {
            queryEmbedding = embResult.embedding;
            semanticAvailable = true;
          } else {
            fallbackReasons.push('embedding_generation_failed');
            ragMetrics.incFallback('embedding_generation_failed', {
              book_id: input.bookId,
            });
          }
        } else {
          fallbackReasons.push('semantic_disabled');
        }

        // ---------------------------------------------------------------
        // 2. Fetch candidates from all sources
        // ---------------------------------------------------------------
        const retrievalT0 = performance.now();
        const allCandidates: RagChunk[] = [];

        const query = {
          text: input.queryText,
          queryEmbedding,
          bookId: input.bookId,
          sceneId: input.sceneId,
          chapterId: input.chapterId,
          actNumber: input.actNumber,
          chapterNumber: input.chapterNumber,
          sourceTypes: input.sourceTypes,
          k: CONFIG.RAG_MAX_CHUNKS,
          tokenBudget,
          mmrLambda,
        };

        for (const source of this.getActiveSources()) {
          try {
            const chunks = await source.fetch(query);
            allCandidates.push(...chunks);
          } catch (err) {
            logger.warn(
              { source: source.name, error: (err as Error).message },
              'RAG source fetch failed'
            );
            fallbackReasons.push(`source_${source.name}_failed`);
          }
        }

        const retrievalMs = performance.now() - retrievalT0;
        ragMetrics.recordRetrievalTime(retrievalMs, {
          book_id: input.bookId,
          semantic: semanticAvailable,
        });
        ragMetrics.recordCandidateCount(allCandidates.length, {
          book_id: input.bookId,
        });

        logRag({
          type: 'retrieval.start',
          bookId: input.bookId,
          sceneId: input.sceneId,
          keywordCount: 0,
        });

        // ---------------------------------------------------------------
        // 3. Rerank: hybrid scoring + MMR diversity
        // ---------------------------------------------------------------
        const reranked = rerank(allCandidates, {
          k: CONFIG.RAG_MAX_CHUNKS,
          mmrLambda,
          characterNames: input.characterNames,
          minScore: CONFIG.RAG_SIMILARITY_THRESHOLD,
        });

        // ---------------------------------------------------------------
        // 4. Allocate per-source token budgets
        // ---------------------------------------------------------------
        const sourceBudgets = {
          ...DEFAULT_SOURCE_BUDGETS,
          ...(input.sourceBudgets || {}),
        };
        const allocated = allocateBySourceBudget(
          reranked,
          tokenBudget,
          sourceBudgets
        );

        ragMetrics.recordSelectedCount(allocated.length, {
          book_id: input.bookId,
        });

        // ---------------------------------------------------------------
        // 5. Compose context sections
        // ---------------------------------------------------------------
        const compT0 = performance.now();
        const composed = composeContext(allocated, { totalBudget: tokenBudget }, {
          semanticAvailable,
          retrievalTimeMs: retrievalMs,
          totalCandidates: allCandidates.length,
          fallbackReasons,
        });
        const compMs = performance.now() - compT0;
        composed.diagnostics.compositionTimeMs = compMs;

        ragMetrics.recordCompositionTime(compMs, { book_id: input.bookId });
        ragMetrics.recordTokenBudget(
          composed.totalTokenCount,
          tokenBudget,
          { book_id: input.bookId }
        );

        // ---------------------------------------------------------------
        // 6. Build backward-compatible codexUsed array
        // ---------------------------------------------------------------
        const codexUsed = allocated
          .filter((c) => c.metadata.codexId)
          .map((c) => ({
            id: c.metadata.codexId as number,
            entry_type: (c.metadata.entryType as string) || c.sourceType,
            entry_name: (c.metadata.entryName as string) || c.sourceId,
            excerpt: c.text.slice(0, 240),
          }));

        // Structured RAG log
        logRag({
          type: 'retrieval.result',
          bookId: input.bookId,
          sceneId: input.sceneId,
          candidates: allCandidates.length,
          selected: codexUsed.map((c) => ({
            id: c.id,
            entry_type: c.entry_type,
            entry_name: c.entry_name,
          })),
        });

        const totalMs = performance.now() - t0;
        span.setAttributes({
          totalMs,
          candidates: allCandidates.length,
          selected: allocated.length,
          tokenBudgetUsed: composed.totalTokenCount,
          semanticAvailable,
        });

        logger.info(
          {
            bookId: input.bookId,
            sceneId: input.sceneId,
            candidates: allCandidates.length,
            selected: allocated.length,
            tokenBudget,
            tokenBudgetUsed: composed.totalTokenCount,
            semanticAvailable,
            totalMs: Math.round(totalMs),
          },
          'RAG orchestrator compose complete'
        );

        return {
          context: composed,
          promptSection: formatPromptSection(composed),
          codexUsed,
        };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: 2, message: (err as Error).message });
        logger.error(
          { error: (err as Error).message, bookId: input.bookId },
          'RAG orchestrator failed — returning empty context'
        );

        logRag({
          type: 'retrieval.error',
          bookId: input.bookId,
          sceneId: input.sceneId,
          message: (err as Error).message,
        });

        // Return empty context — never block generation
        return {
          context: {
            sections: [],
            totalTokenCount: 0,
            manifest: { sources: [], hash: '' },
            diagnostics: {
              path: 'fallback' as const,
              semanticAvailable: false,
              retrievalTimeMs: performance.now() - t0,
              compositionTimeMs: 0,
              totalCandidates: 0,
              totalSelected: 0,
              tokenBudgetUsed: 0,
              tokenBudgetTotal: input.tokenBudget ?? CONFIG.RAG_TOKEN_BUDGET,
              sourceBreakdown: [],
              fallbackReasons: ['orchestrator_exception'],
            },
          },
          promptSection: '',
          codexUsed: [],
        };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Invalidate cached chunks for a book or specific source.
   */
  async invalidate(bookId: number, sourceId?: string): Promise<void> {
    for (const source of this.getActiveSources()) {
      await source.invalidate(bookId, sourceId);
    }
  }
}

/** Singleton orchestrator instance */
export const ragOrchestrator = new RagOrchestrator();
