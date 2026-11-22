import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('proser.codex');

// Histograms for distribution-type metrics
const retrieveTime = meter.createHistogram('kb.codex.retrieve.time_ms', { description: 'Total time to retrieve relevant codex (ms)', unit: 'ms' });
const candidatesCount = meter.createHistogram('kb.codex.candidates.count', { description: 'Number of candidates fetched before scoring', unit: '1' });
const selectedCount = meter.createHistogram('kb.codex.selected.count', { description: 'Number of entries selected after scoring/budget', unit: '1' });
const promptTokens = meter.createHistogram('kb.codex.prompt.tokens', { description: 'Estimated tokens contributed by Codex Context section', unit: '1' });

// Counters
const cacheHits = meter.createCounter('kb.codex.cache.events_total', { description: 'Cache events for RAG codex retrieval (hit/miss)' });

type Attrs = { book_id?: number; scene_id?: number; cache?: 'hit' | 'miss' };

export function recordRetrieveTime(ms: number, attrs: Attrs = {}): void {
  retrieveTime.record(ms, attrs);
}

export function recordCandidatesCount(n: number, attrs: Attrs = {}): void {
  candidatesCount.record(n, attrs);
}

export function recordSelectedCount(n: number, attrs: Attrs = {}): void {
  selectedCount.record(n, attrs);
}

export function recordPromptTokens(n: number, attrs: Attrs = {}): void {
  promptTokens.record(n, attrs);
}

export function incCache(event: 'hit' | 'miss', attrs: Omit<Attrs, 'cache'> = {}): void {
  cacheHits.add(1, { cache: event, ...attrs });
}
