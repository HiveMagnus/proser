/**
 * RAG pipeline OTel metrics.
 *
 * Extends the existing `proser.codex` meter with unified orchestrator
 * metrics for retrieval, reranking, composition, and evaluation.
 *
 * @module metrics/rag
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('proser.rag');

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

const retrievalTime = meter.createHistogram('rag.retrieval.time_ms', {
  description: 'Total unified retrieval time (ms)',
  unit: 'ms',
});

const compositionTime = meter.createHistogram('rag.composition.time_ms', {
  description: 'Context composition time (ms)',
  unit: 'ms',
});

const candidateCount = meter.createHistogram('rag.candidates.count', {
  description: 'Total candidate chunks before reranking',
  unit: '1',
});

const selectedCount = meter.createHistogram('rag.selected.count', {
  description: 'Total chunks selected after reranking + budget',
  unit: '1',
});

const tokenBudgetUsed = meter.createHistogram('rag.token_budget.used', {
  description: 'Token budget consumed by composed context',
  unit: '1',
});

const tokenBudgetTotal = meter.createHistogram('rag.token_budget.total', {
  description: 'Token budget available',
  unit: '1',
});

const embeddingTime = meter.createHistogram('rag.embedding.time_ms', {
  description: 'Time to generate query embedding (ms)',
  unit: 'ms',
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const orchestratorCalls = meter.createCounter('rag.orchestrator.calls_total', {
  description: 'Total orchestrator invocations',
});

const fallbackEvents = meter.createCounter('rag.fallback.events_total', {
  description: 'Fallback events (semantic unavailable, etc.)',
});

const indexingEvents = meter.createCounter('rag.indexing.events_total', {
  description: 'Chunk indexing events (create, update, delete)',
});

const evalRuns = meter.createCounter('rag.eval.runs_total', {
  description: 'Evaluation harness runs',
});

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | undefined>;

export function recordRetrievalTime(ms: number, attrs: Attrs = {}): void {
  retrievalTime.record(ms, attrs);
}

export function recordCompositionTime(ms: number, attrs: Attrs = {}): void {
  compositionTime.record(ms, attrs);
}

export function recordCandidateCount(n: number, attrs: Attrs = {}): void {
  candidateCount.record(n, attrs);
}

export function recordSelectedCount(n: number, attrs: Attrs = {}): void {
  selectedCount.record(n, attrs);
}

export function recordTokenBudget(
  used: number,
  total: number,
  attrs: Attrs = {}
): void {
  tokenBudgetUsed.record(used, attrs);
  tokenBudgetTotal.record(total, attrs);
}

export function recordEmbeddingTime(ms: number, attrs: Attrs = {}): void {
  embeddingTime.record(ms, attrs);
}

export function incOrchestratorCalls(attrs: Attrs = {}): void {
  orchestratorCalls.add(1, attrs);
}

export function incFallback(reason: string, attrs: Attrs = {}): void {
  fallbackEvents.add(1, { reason, ...attrs });
}

export function incIndexing(
  event: 'create' | 'update' | 'delete',
  attrs: Attrs = {}
): void {
  indexingEvents.add(1, { event, ...attrs });
}

export function incEvalRun(evalType: string, attrs: Attrs = {}): void {
  evalRuns.add(1, { eval_type: evalType, ...attrs });
}
