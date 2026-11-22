/**
 * Narrative Memory Layer type definitions.
 *
 * Types for the timeline ledger, character state ledger, open threads
 * registry, memory extraction, and consistency validation.
 *
 * @module memory/types
 */

// ---------------------------------------------------------------------------
// Memory event types (timeline ledger)
// ---------------------------------------------------------------------------

/** Canonical event types that can occur in a scene */
export type MemoryEventType =
  | 'action'
  | 'dialogue'
  | 'revelation'
  | 'arrival'
  | 'departure'
  | 'conflict'
  | 'resolution'
  | 'decision'
  | 'emotional_shift'
  | 'world_change';

/** A single extracted event from a scene */
export interface MemoryEvent {
  eventType: MemoryEventType;
  actors: string[];
  location?: string;
  summary: string;
  payload?: Record<string, unknown>;
  confidence: number;
  ordering: number;
}

// ---------------------------------------------------------------------------
// Character state types
// ---------------------------------------------------------------------------

/** Categories for character state tracking */
export type StateKey =
  | 'injuries'
  | 'possessions'
  | 'mood'
  | 'relationships'
  | 'secrets'
  | 'location'
  | 'status'
  | 'knowledge'
  | 'appearance';

/** A character state change extracted from a scene */
export interface CharacterStateChange {
  characterName: string;
  codexId?: number;
  stateKey: StateKey;
  stateValue: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Plot thread types
// ---------------------------------------------------------------------------

/** Thread lifecycle status */
export type ThreadStatus = 'open' | 'escalated' | 'resolved' | 'abandoned';

/** A plot thread operation extracted from a scene */
export interface ThreadUpdate {
  threadKey: string;
  status: ThreadStatus;
  description?: string;
  actors?: string[];
  dueHorizon?: string;
  notes?: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Extraction output
// ---------------------------------------------------------------------------

/** Complete extraction result from a single scene */
export interface MemoryExtractionResult {
  bookId: number;
  sceneId: number;
  events: MemoryEvent[];
  stateChanges: CharacterStateChange[];
  threadUpdates: ThreadUpdate[];
  /** Average extraction confidence */
  overallConfidence: number;
  /** Extraction latency in ms */
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Consistency validation
// ---------------------------------------------------------------------------

/** Severity of a consistency finding */
export type ConsistencySeverity = 'error' | 'warning' | 'info';

/** A single consistency finding */
export interface ConsistencyFinding {
  type: 'contradiction' | 'timeline_gap' | 'unresolved_thread' | 'state_mismatch' | 'character_absence';
  severity: ConsistencySeverity;
  message: string;
  /** Reference to the conflicting memory record */
  reference?: {
    eventId?: number;
    stateId?: number;
    threadId?: number;
    sceneId?: number;
  };
  confidence: number;
}

/** Result of consistency validation for a scene */
export interface ConsistencyResult {
  bookId: number;
  sceneId: number;
  findings: ConsistencyFinding[];
  checkedAt: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Memory retrieval for RAG
// ---------------------------------------------------------------------------

/** Options for memory retrieval */
export interface MemoryRetrievalOptions {
  bookId: number;
  sceneId?: number;
  chapterId?: number;
  actNumber?: number;
  characterNames?: string[];
  /** Maximum events to retrieve */
  maxEvents?: number;
  /** Maximum state entries to retrieve */
  maxStates?: number;
  /** Maximum threads to retrieve */
  maxThreads?: number;
  /** Include resolved threads? Default false */
  includeResolved?: boolean;
}

/** Combined memory context for prompt injection */
export interface MemoryContext {
  /** Recent canonical events relevant to the scene */
  events: MemoryEvent[];
  /** Current character states for actors in the scene */
  characterStates: Map<string, CharacterStateChange[]>;
  /** Active plot threads */
  activeThreads: ThreadUpdate[];
  /** Total token estimate */
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// AI extraction schemas (for JSON parsing)
// ---------------------------------------------------------------------------

/** Schema that the AI extractor is prompted to produce */
export interface AIExtractionPayload {
  events: Array<{
    event_type: string;
    actors: string[];
    location?: string;
    summary: string;
    payload?: Record<string, unknown>;
    confidence: number;
  }>;
  state_changes: Array<{
    character_name: string;
    state_key: string;
    state_value: string;
    confidence: number;
  }>;
  thread_updates: Array<{
    thread_key: string;
    status: string;
    description?: string;
    actors?: string[];
    due_horizon?: string;
    notes?: string;
    confidence: number;
  }>;
}
