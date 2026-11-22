/**
 * Memory retrieval service — queries narrative memory for RAG composition.
 *
 * Provides functions to retrieve timeline events, character states, and
 * plot threads relevant to the current scene being generated. Used by
 * the RAG source adapters (TimelineSource, CharacterStateSource, ThreadSource).
 *
 * @module memory/retrieval
 */

import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import logger from '@/lib/logger';

import type {
  MemoryEvent,
  MemoryEventType,
  CharacterStateChange,
  StateKey,
  ThreadUpdate,
  ThreadStatus,
  MemoryRetrievalOptions,
  MemoryContext,
} from '@/lib/memory/types';

/** Estimate tokens from text: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Retrieve recent timeline events relevant to the current generation context.
 *
 * Events are fetched from previous scenes in the same book, ordered by
 * recency. Actor names and location are used for relevance filtering.
 */
export async function retrieveTimelineEvents(
  options: MemoryRetrievalOptions
): Promise<MemoryEvent[]> {
  const { bookId, sceneId, characterNames, maxEvents = 15 } = options;

  try {
    const prisma = databaseService.client;

    // Build query: all events for this book, ordered by scene + ordering
    const events = await prisma.sceneMemoryEvent.findMany({
      where: {
        bookId,
        // Only include events from scenes before the current one
        ...(sceneId ? { sceneId: { lt: sceneId } } : {}),
      },
      orderBy: [
        { sceneId: 'desc' },
        { ordering: 'asc' },
      ],
      take: maxEvents * 3, // Fetch more than needed, then filter by relevance
    });

    // Score events by relevance to current context
    const scored = events.map((event) => {
      let relevance = 0;
      const actors = (event.actors as string[]) || [];

      // Actor overlap with requested characters
      if (characterNames?.length) {
        const actorSet = new Set(actors.map((a) => a.toLowerCase()));
        const overlap = characterNames.filter((n) =>
          actorSet.has(n.toLowerCase())
        ).length;
        relevance += (overlap / characterNames.length) * 0.6;
      }

      // Recency boost (more recent scenes score higher)
      if (sceneId) {
        const distance = sceneId - event.sceneId;
        relevance += Math.max(0, 1 - distance / 20) * 0.3;
      }

      // High-importance event types get a boost
      const importantTypes = new Set(['revelation', 'conflict', 'resolution', 'decision']);
      if (importantTypes.has(event.eventType)) {
        relevance += 0.1;
      }

      return {
        event: {
          eventType: event.eventType as MemoryEventType,
          actors,
          location: event.location ?? undefined,
          summary: event.summary,
          payload: event.payload as Record<string, unknown> | undefined,
          confidence: event.confidence,
          ordering: event.ordering,
        },
        relevance,
      };
    });

    // Sort by relevance and take top N
    scored.sort((a, b) => b.relevance - a.relevance);
    return scored.slice(0, maxEvents).map((s) => s.event);
  } catch (error) {
    logger.warn(
      { error: (error as Error).message, bookId },
      'Failed to retrieve timeline events'
    );
    return [];
  }
}

/**
 * Retrieve the latest character states for actors in the scene.
 *
 * Returns the most recent state per (character, stateKey) pair,
 * giving the AI an accurate picture of each character's current condition.
 */
export async function retrieveCharacterStates(
  options: MemoryRetrievalOptions
): Promise<Map<string, CharacterStateChange[]>> {
  const { bookId, sceneId, characterNames, maxStates = 30 } = options;

  try {
    const prisma = databaseService.client;

    // Look up codex entries for the requested characters
    let codexFilter: Prisma.CodexEntryWhereInput = { bookId, entryType: 'character' };
    if (characterNames?.length) {
      codexFilter = {
        ...codexFilter,
        entryName: { in: characterNames },
      };
    }

    const codexEntries = await prisma.codexEntry.findMany({
      where: codexFilter,
      select: { id: true, entryName: true },
    });

    if (codexEntries.length === 0) return new Map();

    const codexIds = codexEntries.map((e) => e.id);
    const idToName = new Map(codexEntries.map((e) => [e.id, e.entryName]));

    // Fetch the most recent state entries for these characters
    const states = await prisma.characterState.findMany({
      where: {
        bookId,
        codexId: { in: codexIds },
        ...(sceneId ? { sceneId: { lte: sceneId } } : {}),
      },
      orderBy: { sceneId: 'desc' },
      take: maxStates * 2,
    });

    // Deduplicate: keep the most recent value per (codexId, stateKey)
    const seen = new Set<string>();
    const result = new Map<string, CharacterStateChange[]>();

    for (const state of states) {
      const dedupeKey = `${state.codexId}:${state.stateKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const charName = idToName.get(state.codexId) ?? `character:${state.codexId}`;
      if (!result.has(charName)) result.set(charName, []);

      result.get(charName)!.push({
        characterName: charName,
        codexId: state.codexId,
        stateKey: state.stateKey as StateKey,
        stateValue: state.stateValue,
        confidence: state.confidence,
      });
    }

    return result;
  } catch (error) {
    logger.warn(
      { error: (error as Error).message, bookId },
      'Failed to retrieve character states'
    );
    return new Map();
  }
}

/**
 * Retrieve active plot threads for the book.
 *
 * Returns open and escalated threads, optionally including resolved ones.
 * Threads are ordered by recency of last update.
 */
export async function retrievePlotThreads(
  options: MemoryRetrievalOptions
): Promise<ThreadUpdate[]> {
  const { bookId, includeResolved = false, maxThreads = 10 } = options;

  try {
    const prisma = databaseService.client;

    const statusFilter = includeResolved
      ? {}
      : { status: { in: ['open', 'escalated'] } };

    const threads = await prisma.plotThread.findMany({
      where: {
        bookId,
        archivedAt: null,
        ...statusFilter,
      },
      orderBy: { updatedAt: 'desc' },
      take: maxThreads,
    });

    return threads.map((t) => ({
      threadKey: t.question ?? t.threadKey,
      status: t.status as ThreadStatus,
      description: t.description ?? undefined,
      actors: (t.actors as string[]) ?? undefined,
      dueHorizon: t.dueHorizon ?? undefined,
      notes: t.notes ?? undefined,
      confidence: t.confidence,
    }));
  } catch (error) {
    logger.warn(
      { error: (error as Error).message, bookId },
      'Failed to retrieve plot threads'
    );
    return [];
  }
}

/**
 * Retrieve complete narrative memory context for a scene.
 *
 * Combines timeline events, character states, and plot threads into
 * a single MemoryContext suitable for RAG composition.
 */
export async function retrieveMemoryContext(
  options: MemoryRetrievalOptions
): Promise<MemoryContext> {
  const [events, characterStates, activeThreads] = await Promise.all([
    retrieveTimelineEvents(options),
    retrieveCharacterStates(options),
    retrievePlotThreads(options),
  ]);

  // Estimate total token count
  let tokenCount = 0;
  for (const event of events) {
    tokenCount += estimateTokens(
      `${event.summary} (${event.actors.join(', ')})`
    );
  }
  for (const [, states] of characterStates) {
    for (const state of states) {
      tokenCount += estimateTokens(
        `${state.characterName} ${state.stateKey}: ${state.stateValue}`
      );
    }
  }
  for (const thread of activeThreads) {
    tokenCount += estimateTokens(
      `${thread.threadKey}: ${thread.description ?? thread.status}`
    );
  }

  return {
    events,
    characterStates,
    activeThreads,
    tokenCount,
  };
}
