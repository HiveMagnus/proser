/**
 * Source barrel export — central registry of all RAG source adapters.
 *
 * @module rag/sources
 */

export { CodexSource } from './codexSource';

// Memory source adapters (Priority B - Phase 2)
export { TimelineSource } from './timelineSource';
export { CharacterStateSource } from './characterStateSource';
export { ThreadSource } from './threadSource';
export { NarrativeArtifactSource } from './narrativeArtifactSource';
