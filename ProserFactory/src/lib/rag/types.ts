/**
 * RAG pipeline type definitions.
 *
 * Canonical types for the unified RAG orchestrator, sources, retrieval,
 * reranking, and context composition.
 *
 * @module rag/types
 */

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

/** Allowed RAG source categories */
export type RagSourceType =
  | 'character'
  | 'location'
  | 'item'
  | 'faction'
  | 'event'
  | 'rule'
  | 'culture'
  | 'relationship'
  | 'world'
  | 'timeline'
  | 'thread'
  | 'style';

/** A source adapter that can fetch and invalidate chunks */
export interface RagSource {
  readonly name: string;
  readonly sourceType: RagSourceType;
  fetch(query: RagQuery): Promise<RagChunk[]>;
  invalidate(bookId: number, sourceId?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface RagQuery {
  /** The query text (scene outline + beats) */
  text: string;
  /** Embedding vector for semantic search (pre-computed by orchestrator) */
  queryEmbedding?: number[];
  bookId: number;
  sceneId?: number;
  chapterId?: number;
  actNumber?: number;
  chapterNumber?: number;
  /** Which source types to include (all if empty) */
  sourceTypes?: RagSourceType[];
  /** Maximum chunks to return per source */
  k?: number;
  /** Total token budget across all sources */
  tokenBudget?: number;
  /** MMR lambda: 0.0 = max diversity, 1.0 = max relevance */
  mmrLambda?: number;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

export interface RagChunk {
  id: string;
  sourceType: RagSourceType;
  sourceId: string;
  text: string;
  embedding?: number[];
  tokenCount: number;
  metadata: ChunkMetadata;
  /** Retrieval scores (populated during retrieval) */
  scores?: ChunkScores;
}

export interface ChunkMetadata {
  bookId: number;
  entryName?: string;
  entryType?: string;
  codexId?: number;
  sceneId?: number;
  chapterNumber?: number;
  actNumber?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ChunkScores {
  /** Raw semantic (cosine) similarity [0, 1] */
  semantic: number;
  /** Keyword overlap score [0, 1] */
  keyword: number;
  /** Recency boost [0, 1] — more recent = higher */
  recency: number;
  /** Entity mention overlap boost [0, 1] */
  entityOverlap: number;
  /** Final combined score after weighting */
  combined: number;
}

// ---------------------------------------------------------------------------
// Context composition
// ---------------------------------------------------------------------------

export interface ContextSection {
  /** Header label, e.g., "[Character Context]" */
  header: string;
  /** Formatted text content for prompt injection */
  content: string;
  /** Token cost of this section */
  tokenCount: number;
  /** Source type that produced this section */
  sourceType: RagSourceType;
  /** Contributing chunks (for provenance) */
  chunks: RagChunk[];
}

export interface ComposedContext {
  /** Ordered context sections for prompt injection */
  sections: ContextSection[];
  /** Total token count across all sections */
  totalTokenCount: number;
  /** Deterministic manifest for cache keying and provenance */
  manifest: RagManifest;
  /** Diagnostics for observability */
  diagnostics: RagDiagnostics;
}

export interface RagManifest {
  sources: Array<{
    type: RagSourceType;
    ids: string[];
    k: number;
  }>;
  /** Deterministic hash of manifest content for cache keys */
  hash: string;
}

export interface RagDiagnostics {
  /** Which retrieval path was used */
  path: 'unified' | 'legacy' | 'fallback';
  /** Whether semantic retrieval was available */
  semanticAvailable: boolean;
  /** Total retrieval time (ms) */
  retrievalTimeMs: number;
  /** Total composition time (ms) */
  compositionTimeMs: number;
  /** Total candidates before reranking */
  totalCandidates: number;
  /** Total selected after reranking + budget */
  totalSelected: number;
  /** Token budget used vs available */
  tokenBudgetUsed: number;
  tokenBudgetTotal: number;
  /** Per-source breakdown */
  sourceBreakdown: Array<{
    sourceType: RagSourceType;
    candidates: number;
    selected: number;
    tokensUsed: number;
  }>;
  /** Fallback reasons (if any) */
  fallbackReasons: string[];
}

// ---------------------------------------------------------------------------
// Orchestrator input/output
// ---------------------------------------------------------------------------

export interface OrchestratorInput {
  bookId: number;
  sceneId?: number;
  chapterId?: number;
  actNumber?: number;
  chapterNumber?: number;
  /** Scene outline + beats text used as the retrieval query */
  queryText: string;
  /** Character names expected in the scene */
  characterNames?: string[];
  /** Source types to include (all if empty) */
  sourceTypes?: RagSourceType[];
  /** Total token budget for composed context */
  tokenBudget?: number;
  /** Per-source token budget overrides */
  sourceBudgets?: Partial<Record<RagSourceType, number>>;
  /** MMR lambda override */
  mmrLambda?: number;
}

export interface OrchestratorResult {
  /** Composed context ready for prompt injection */
  context: ComposedContext;
  /** Formatted prompt section (complete text block) */
  promptSection: string;
  /** Codex entries used (for backward-compatible provenance) */
  codexUsed: Array<{
    id: number;
    entry_type: string;
    entry_name: string;
    excerpt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Token budget allocation
// ---------------------------------------------------------------------------

/** Default token budget allocation percentages per source type */
export const DEFAULT_SOURCE_BUDGETS: Record<RagSourceType, number> = {
  character: 0.30,
  location: 0.12,
  item: 0.08,
  faction: 0.06,
  event: 0.05,
  rule: 0.04,
  culture: 0.05,
  world: 0.06,
  timeline: 0.08,
  thread: 0.04,
  style: 0.04,
  relationship: 0.08,
};

/** Scoring weights for hybrid reranking */
export const DEFAULT_SCORING_WEIGHTS = {
  semantic: 0.45,
  keyword: 0.30,
  recency: 0.15,
  entityOverlap: 0.10,
};
