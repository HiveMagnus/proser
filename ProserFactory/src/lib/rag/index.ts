/**
 * RAG pipeline barrel export.
 *
 * @module rag
 */

// Types
export type {
  RagSourceType,
  RagSource,
  RagQuery,
  RagChunk,
  ChunkMetadata,
  ChunkScores,
  ContextSection,
  ComposedContext,
  RagManifest,
  RagDiagnostics,
  OrchestratorInput,
  OrchestratorResult,
} from './types';

export { DEFAULT_SOURCE_BUDGETS, DEFAULT_SCORING_WEIGHTS } from './types';

// Orchestrator
export { RagOrchestrator, ragOrchestrator } from './orchestrator';

// Composer
export { composeContext, formatPromptSection } from './composer';

// Reranker
export {
  rerank,
  mmrSelect,
  applyWeightedScoring,
  allocateBySourceBudget,
  computeEntityOverlap,
} from './reranker';

// Sources
export { CodexSource } from './sources';

// Indexer
export {
  indexCodexEntry,
  removeCodexEntryIndex,
  backfillBookIndex,
  backfillAllBooks,
} from './indexer';

// Evaluator
export {
  evaluateScenario,
  evaluateBatch,
  buildScenariosFromBook,
  computeRecallAtK,
  computeMRR,
  computeNDCG,
  computeTokenEfficiency,
} from './evaluator';
