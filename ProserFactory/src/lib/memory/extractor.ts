/**
 * Memory Extraction Service — extracts structured memory from scene prose.
 *
 * Uses the AI provider to analyze generated prose and extract:
 * - Timeline events (who/what/where/when)
 * - Character state changes (injuries, possessions, mood, etc.)
 * - Plot thread updates (new threads, escalations, resolutions)
 *
 * Extracted data is persisted to the database for retrieval during
 * subsequent scene generations, enabling narrative continuity.
 *
 * @module memory/extractor
 */

import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import { defaultModelRouter } from '@/lib/ai/router';
import { withRetry } from '@/lib/resilience';
import { CONFIG } from '@/core/config';
import logger from '@/lib/logger';
import { logRag } from '@/lib/ragLogger';
import { trace } from '@opentelemetry/api';
import * as memoryMetrics from '@/metrics/memory';

import type {
  MemoryEvent,
  MemoryEventType,
  CharacterStateChange,
  StateKey,
  ThreadUpdate,
  ThreadStatus,
  MemoryExtractionResult,
  AIExtractionPayload,
} from '@/lib/memory/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES = new Set<string>([
  'action', 'dialogue', 'revelation', 'arrival', 'departure',
  'conflict', 'resolution', 'decision', 'emotional_shift', 'world_change',
]);

const VALID_STATE_KEYS = new Set<string>([
  'injuries', 'possessions', 'mood', 'relationships', 'secrets',
  'location', 'status', 'knowledge', 'appearance',
]);

const VALID_THREAD_STATUSES = new Set<string>([
  'open', 'escalated', 'resolved', 'abandoned',
]);

function isValidEventType(t: string): t is MemoryEventType {
  return VALID_EVENT_TYPES.has(t);
}
function isValidStateKey(k: string): k is StateKey {
  return VALID_STATE_KEYS.has(k);
}
function isValidThreadStatus(s: string): s is ThreadStatus {
  return VALID_THREAD_STATUSES.has(s);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  prose: string,
  context: {
    title?: string;
    sceneOutline?: string;
    previousSummary?: string;
    characterNames?: string[];
  }
): string {
  const characterList = context.characterNames?.length
    ? `Known characters: ${context.characterNames.join(', ')}`
    : '';

  return `You are a meticulous fiction analysis assistant. Analyze the following scene prose and extract structured narrative memory.

${context.title ? `Book: "${context.title}"` : ''}
${context.sceneOutline ? `Scene outline: ${context.sceneOutline}` : ''}
${context.previousSummary ? `Previous scene: ${context.previousSummary}` : ''}
${characterList}

## Scene Prose (complete chunk; chunking metadata is included by the caller):
${prose}

## Instructions:
Extract the following from the prose and return ONLY valid JSON (no markdown, no commentary):

1. **events**: Key plot/narrative events in chronological order.
   - event_type: one of [action, dialogue, revelation, arrival, departure, conflict, resolution, decision, emotional_shift, world_change]
   - actors: array of character names involved
   - location: where it happens (if mentioned)
   - summary: one-sentence description
   - confidence: 0.0–1.0 how certain you are

2. **state_changes**: Character state changes that occurred.
   - character_name: the character
   - state_key: one of [injuries, possessions, mood, relationships, secrets, location, status, knowledge, appearance]
   - state_value: the new state (concise)
   - confidence: 0.0–1.0

3. **thread_updates**: Narrative threads that were introduced, advanced, or resolved.
   - thread_key: short kebab-case identifier (e.g., "stolen-amulet", "forbidden-romance")
   - status: one of [open, escalated, resolved, abandoned]
   - description: what changed
   - actors: character names involved
   - due_horizon: when it should resolve (e.g., "act-2", "climax", "next-chapter") — optional
   - confidence: 0.0–1.0

Also place relationship deltas, character knowledge/beliefs/suspicions, emotional state, promises/payoffs, motifs, spatial facts, elapsed time, unresolved questions, lies, exposed secrets, and irreversible decisions in the nearest event's payload object. Never omit an ending-state change.

Return this exact JSON shape:
{
  "events": [...],
  "state_changes": [...],
  "thread_updates": [...]
}`;
}

// ---------------------------------------------------------------------------
// JSON parsing and validation
// ---------------------------------------------------------------------------

function parseExtractionResponse(response: string): AIExtractionPayload | null {
  try {
    // Extract JSON from response (handle markdown wrapping, extra text)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Basic structure validation
    if (!parsed || typeof parsed !== 'object') return null;

    const events = Array.isArray(parsed.events) ? parsed.events : [];
    const stateChanges = Array.isArray(parsed.state_changes) ? parsed.state_changes : [];
    const threadUpdates = Array.isArray(parsed.thread_updates) ? parsed.thread_updates : [];

    return {
      events: events.filter(
        (e: Record<string, unknown>) =>
          typeof e?.event_type === 'string' &&
          Array.isArray(e?.actors) &&
          typeof e?.summary === 'string'
      ),
      state_changes: stateChanges.filter(
        (s: Record<string, unknown>) =>
          typeof s?.character_name === 'string' &&
          typeof s?.state_key === 'string' &&
          typeof s?.state_value === 'string'
      ),
      thread_updates: threadUpdates.filter(
        (t: Record<string, unknown>) =>
          typeof t?.thread_key === 'string' &&
          typeof t?.status === 'string'
      ),
    };
  } catch {
    return null;
  }
}

function normalizeExtraction(
  raw: AIExtractionPayload,
  minConfidence: number
): {
  events: MemoryEvent[];
  stateChanges: CharacterStateChange[];
  threadUpdates: ThreadUpdate[];
} {
  const events: MemoryEvent[] = raw.events
    .map((e, i) => ({
      eventType: isValidEventType(e.event_type) ? e.event_type : ('action' as MemoryEventType),
      actors: e.actors.filter((a: unknown) => typeof a === 'string'),
      location: typeof e.location === 'string' ? e.location : undefined,
      summary: e.summary,
      payload: e.payload,
      confidence: typeof e.confidence === 'number' ? Math.min(1, Math.max(0, e.confidence)) : 0.7,
      ordering: i,
    }))
    .filter((e) => e.confidence >= minConfidence && e.actors.length > 0);

  const stateChanges: CharacterStateChange[] = raw.state_changes
    .map((s) => ({
      characterName: s.character_name,
      stateKey: isValidStateKey(s.state_key) ? s.state_key : ('status' as StateKey),
      stateValue: s.state_value,
      confidence: typeof s.confidence === 'number' ? Math.min(1, Math.max(0, s.confidence)) : 0.7,
    }))
    .filter((s) => s.confidence >= minConfidence);

  const threadUpdates: ThreadUpdate[] = raw.thread_updates
    .map((t) => ({
      threadKey: t.thread_key.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 128),
      status: isValidThreadStatus(t.status) ? t.status : ('open' as ThreadStatus),
      description: t.description,
      actors: t.actors?.filter((a: unknown) => typeof a === 'string'),
      dueHorizon: t.due_horizon,
      notes: t.notes,
      confidence: typeof t.confidence === 'number' ? Math.min(1, Math.max(0, t.confidence)) : 0.7,
    }))
    .filter((t) => t.confidence >= minConfidence);

  return { events, stateChanges, threadUpdates };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistEvents(
  bookId: number,
  sceneId: number,
  events: MemoryEvent[]
): Promise<void> {
  if (events.length === 0) return;

  const prisma = databaseService.client;

  // Delete existing events for this scene (re-extraction replaces)
  await prisma.sceneMemoryEvent.deleteMany({ where: { sceneId } });

  // Insert new events
  await prisma.sceneMemoryEvent.createMany({
    data: events.map((e) => ({
      bookId,
      sceneId,
      eventType: e.eventType,
      actors: e.actors,
      location: e.location ?? null,
      summary: e.summary,
      payload: e.payload as Prisma.InputJsonValue | undefined,
      confidence: e.confidence,
      ordering: e.ordering,
    })),
  });
}

async function persistStateChanges(
  bookId: number,
  sceneId: number,
  changes: CharacterStateChange[]
): Promise<void> {
  if (changes.length === 0) return;

  const prisma = databaseService.client;

  // Resolve codex IDs for character names
  const codexEntries = await prisma.codexEntry.findMany({
    where: {
      bookId,
      entryType: 'character',
    },
    select: { id: true, entryName: true },
  });
  const nameToId = new Map(
    codexEntries.map((e) => [e.entryName.toLowerCase(), e.id])
  );

  for (const change of changes) {
    const codexId = nameToId.get(change.characterName.toLowerCase());
    if (!codexId) continue; // Skip unknown characters

    // Upsert: unique on (bookId, codexId, sceneId, stateKey)
    const existing = await prisma.characterState.findFirst({
      where: { bookId, codexId, sceneId, stateKey: change.stateKey },
    });

    if (existing) {
      await prisma.characterState.update({
        where: { id: existing.id },
        data: {
          stateValue: change.stateValue,
          confidence: change.confidence,
        },
      });
    } else {
      await prisma.characterState.create({
        data: {
          bookId,
          codexId,
          sceneId,
          stateKey: change.stateKey,
          stateValue: change.stateValue,
          confidence: change.confidence,
        },
      });
    }
  }
}

async function persistThreadUpdates(
  bookId: number,
  sceneId: number,
  updates: ThreadUpdate[]
): Promise<void> {
  if (updates.length === 0) return;

  const prisma = databaseService.client;

  for (const update of updates) {
    const existing = await prisma.plotThread.findFirst({
      where: { bookId, threadKey: update.threadKey },
    });

    if (existing?.authorManaged || existing?.archivedAt) continue;
    if (existing) {
      await prisma.plotThread.updateMany({
        where: { id: existing.id, authorManaged: false, archivedAt: null },
        data: {
          version: { increment: 1 },
          status: update.status,
          description: update.description ?? existing.description,
          lastSceneId: sceneId,
          actors: (update.actors ?? existing.actors) as Prisma.InputJsonValue,
          dueHorizon: update.dueHorizon ?? existing.dueHorizon,
          notes: update.notes ?? existing.notes,
          confidence: update.confidence,
        },
      });
    } else {
      await prisma.plotThread.create({
        data: {
          bookId,
          threadKey: update.threadKey,
          status: update.status,
          description: update.description,
          firstSceneId: sceneId,
          lastSceneId: sceneId,
          actors: update.actors ?? undefined,
          dueHorizon: update.dueHorizon,
          notes: update.notes,
          confidence: update.confidence,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract narrative memory from scene prose.
 *
 * Uses the AI provider to analyze prose and extract structured data
 * (events, state changes, thread updates). Results are persisted to
 * the database for retrieval during subsequent scene generations.
 *
 * Gracefully degrades: never throws, always returns a result.
 */
export async function extractMemory(params: {
  bookId: number;
  sceneId: number;
  prose: string;
  title?: string;
  sceneOutline?: string;
  previousSummary?: string;
  characterNames?: string[];
}): Promise<MemoryExtractionResult> {
  const tracer = trace.getTracer('memory-extractor');

  return await tracer.startActiveSpan('memory.extract', async (span) => {
    const t0 = performance.now();
    const { bookId, sceneId, prose } = params;

    span.setAttributes({ bookId, sceneId });

    const emptyResult: MemoryExtractionResult = {
      bookId,
      sceneId,
      events: [],
      stateChanges: [],
      threadUpdates: [],
      overallConfidence: 0,
      latencyMs: 0,
    };

    if (!CONFIG.RAG_MEMORY_ENABLED) {
      return emptyResult;
    }

    // Skip very short prose (< 50 words)
    if (!prose || prose.split(/\s+/).length < 50) {
      return emptyResult;
    }

    logRag({
      type: 'memory.extract.start',
      bookId,
      sceneId,
    });

    try {
      memoryMetrics.incExtractionAttempts({ book_id: bookId });

      // Process the complete scene in overlapping chunks. The last chunk is
      // always included explicitly because it contains the turn and end state.
      const chunkChars = 6000;
      const overlap = 600;
      const chunks: string[] = [];
      for (let start = 0; start < prose.length; start += chunkChars - overlap) {
        chunks.push(prose.slice(start, start + chunkChars));
        if (start + chunkChars >= prose.length) break;
      }
      const provider = defaultModelRouter.choose('generic');
      const timeoutMs = Number(process.env.AI_TIMEOUT_MEMORY_MS ?? '45000') || 45000;
      const payloads: AIExtractionPayload[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const prompt = buildExtractionPrompt(`CHUNK ${index + 1}/${chunks.length}${index === chunks.length - 1 ? ' (FINAL SECTION)' : ''}\n${chunk}`, {
          title: params.title, sceneOutline: params.sceneOutline,
          previousSummary: params.previousSummary, characterNames: params.characterNames,
        });
        const response = await withRetry(
          (signal) => provider.generateText({ prompt, signal, params: { glmThinking: true, glmPreserveThinking: false } }),
          2,
          (attempt, err) => logger.warn({ attempt, chunk: index + 1, error: (err as Error).message, bookId, sceneId }, 'Memory extraction retry'),
          { timeoutMs, jitter: true },
        );
        const parsed = parseExtractionResponse(response);
        if (parsed) payloads.push(parsed);
      }
      if (payloads.length === 0) {
        logger.warn({ bookId, sceneId }, 'Memory extraction: failed to parse AI response');
        memoryMetrics.incExtractionFailures({ book_id: bookId, reason: 'parse_failure' });
        return { ...emptyResult, latencyMs: performance.now() - t0 };
      }
      const rawPayload: AIExtractionPayload = {
        events: payloads.flatMap((item) => item.events),
        state_changes: payloads.flatMap((item) => item.state_changes),
        thread_updates: payloads.flatMap((item) => item.thread_updates),
      };

      // Normalize and filter by confidence
      const minConfidence = CONFIG.MEMORY_EXTRACTION_CONFIDENCE_MIN;
      const { events, stateChanges, threadUpdates } = normalizeExtraction(rawPayload, minConfidence);

      // Persist to database
      await Promise.all([
        persistEvents(bookId, sceneId, events),
        persistStateChanges(bookId, sceneId, stateChanges),
        persistThreadUpdates(bookId, sceneId, threadUpdates),
      ]);

      const latencyMs = performance.now() - t0;

      // Compute overall confidence
      const allConfidences = [
        ...events.map((e) => e.confidence),
        ...stateChanges.map((s) => s.confidence),
        ...threadUpdates.map((t) => t.confidence),
      ];
      const overallConfidence =
        allConfidences.length > 0
          ? allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length
          : 0;

      // Metrics
      memoryMetrics.recordExtractionTime(latencyMs, { book_id: bookId });
      memoryMetrics.recordEventsExtracted(events.length, { book_id: bookId });
      memoryMetrics.recordStateChanges(stateChanges.length, { book_id: bookId });
      memoryMetrics.recordThreadUpdates(threadUpdates.length, { book_id: bookId });
      memoryMetrics.recordExtractionConfidence(overallConfidence, { book_id: bookId });

      span.setAttributes({
        events: events.length,
        stateChanges: stateChanges.length,
        threadUpdates: threadUpdates.length,
        confidence: overallConfidence,
        latencyMs: Math.round(latencyMs),
      });

      logRag({
        type: 'memory.extract.result',
        bookId,
        sceneId,
        events: events.length,
        stateChanges: stateChanges.length,
        threadUpdates: threadUpdates.length,
        latencyMs: Math.round(latencyMs),
      });

      logger.info(
        {
          bookId,
          sceneId,
          events: events.length,
          stateChanges: stateChanges.length,
          threadUpdates: threadUpdates.length,
          confidence: overallConfidence,
          latencyMs: Math.round(latencyMs),
        },
        'Memory extraction complete'
      );

      return {
        bookId,
        sceneId,
        events,
        stateChanges,
        threadUpdates,
        overallConfidence,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = performance.now() - t0;
      span.recordException(error as Error);
      span.setStatus({ code: 2, message: (error as Error).message });

      memoryMetrics.incExtractionFailures({ book_id: bookId, reason: 'error' });

      logRag({
        type: 'memory.extract.error',
        bookId,
        sceneId,
        message: (error as Error).message,
      });

      logger.error(
        { error: (error as Error).message, bookId, sceneId },
        'Memory extraction failed — non-blocking'
      );

      return { ...emptyResult, latencyMs };
    } finally {
      span.end();
    }
  });
}

/**
 * Remove all memory data for a specific scene (used when scene is deleted or re-generated).
 */
export async function clearSceneMemory(bookId: number, sceneId: number): Promise<void> {
  try {
    const prisma = databaseService.client;
    await Promise.all([
      prisma.sceneMemoryEvent.deleteMany({ where: { sceneId } }),
      prisma.characterState.deleteMany({ where: { sceneId } }),
    ]);
    logger.debug({ bookId, sceneId }, 'Scene memory cleared');
  } catch (error) {
    logger.warn({ error: (error as Error).message, bookId, sceneId }, 'Failed to clear scene memory');
  }
}
