/**
 * Timeline RAG source adapter.
 *
 * Fetches recent scene memory events and converts them into RagChunk
 * format for the unified retrieval pipeline.
 *
 * @module rag/sources/timelineSource
 */

import logger from '@/lib/logger';
import { retrieveTimelineEvents } from '@/lib/memory/retrieval';
import type { RagSource, RagQuery, RagChunk } from '@/lib/rag/types';

/** Estimate tokens from text: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class TimelineSource implements RagSource {
  readonly name = 'timeline';
  readonly sourceType = 'timeline' as const;

  async fetch(query: RagQuery): Promise<RagChunk[]> {
    const { bookId, sceneId } = query;

    try {
      const events = await retrieveTimelineEvents({
        bookId,
        sceneId,
        maxEvents: query.k ?? 15,
      });

      return events.map((event, i) => {
        const actorStr = event.actors.join(', ');
        const locationStr = event.location ? ` at ${event.location}` : '';
        const text = `[${event.eventType}] ${actorStr}${locationStr}: ${event.summary}`;

        return {
          id: `timeline:${bookId}:${i}`,
          sourceType: 'timeline' as const,
          sourceId: `timeline:${bookId}:${i}`,
          text,
          tokenCount: estimateTokens(text),
          metadata: {
            bookId,
            eventType: event.eventType,
            actors: event.actors,
            location: event.location,
          },
          scores: {
            semantic: 0,
            keyword: 0,
            recency: Math.max(0, 1 - i / events.length),
            entityOverlap: 0,
            combined: 0,
          },
        };
      });
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, bookId },
        'TimelineSource fetch failed'
      );
      return [];
    }
  }

  async invalidate(_bookId: number, _sourceId?: string): Promise<void> {
    // Timeline events are scene-bound; invalidation handled by memory extractor
  }
}
