/**
 * Plot Thread RAG source adapter.
 *
 * Fetches active and escalated plot threads from the thread registry
 * and converts them into RagChunk format so the AI knows which
 * narrative threads need attention.
 *
 * @module rag/sources/threadSource
 */

import logger from '@/lib/logger';
import { retrievePlotThreads } from '@/lib/memory/retrieval';
import type { RagSource, RagQuery, RagChunk } from '@/lib/rag/types';

/** Estimate tokens from text: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ThreadSource implements RagSource {
  readonly name = 'thread';
  readonly sourceType = 'thread' as const;

  async fetch(query: RagQuery): Promise<RagChunk[]> {
    const { bookId } = query;

    try {
      const threads = await retrievePlotThreads({
        bookId,
        includeResolved: false,
        maxThreads: query.k ?? 10,
      });

      return threads.map((thread, i) => {
        const parts = [
          `Thread: "${thread.threadKey}" [${thread.status}]`,
        ];
        if (thread.description) parts.push(`  ${thread.description}`);
        if (thread.actors?.length) parts.push(`  Involving: ${thread.actors.join(', ')}`);
        if (thread.dueHorizon) parts.push(`  Due: ${thread.dueHorizon}`);
        if (thread.notes) parts.push(`  Notes: ${thread.notes}`);

        const text = parts.join('\n');

        // Escalated threads are more urgent
        const statusBoost = thread.status === 'escalated' ? 0.3 : 0;

        return {
          id: `thread:${bookId}:${i}`,
          sourceType: 'thread' as const,
          sourceId: `thread:${bookId}:${thread.threadKey}`,
          text,
          tokenCount: estimateTokens(text),
          metadata: {
            bookId,
            threadKey: thread.threadKey,
            status: thread.status,
            actors: thread.actors,
            dueHorizon: thread.dueHorizon,
          },
          scores: {
            semantic: 0,
            keyword: statusBoost,
            recency: 0.5,
            entityOverlap: 0,
            combined: 0,
          },
        };
      });
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, bookId },
        'ThreadSource fetch failed'
      );
      return [];
    }
  }

  async invalidate(_bookId: number, _sourceId?: string): Promise<void> {
    // Thread data is book-scoped; invalidation handled by memory extractor
  }
}
