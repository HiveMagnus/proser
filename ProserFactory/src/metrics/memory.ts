/**
 * Narrative Memory OTel metrics.
 *
 * Counters and histograms for the memory extraction, retrieval,
 * and consistency validation pipeline.
 *
 * @module metrics/memory
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('proser.memory');

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

const extractionTime = meter.createHistogram('memory.extraction.time_ms', {
  description: 'Total time to extract memory from scene prose (ms)',
  unit: 'ms',
});

const eventsExtracted = meter.createHistogram('memory.extraction.events_count', {
  description: 'Number of events extracted per scene',
  unit: '1',
});

const stateChanges = meter.createHistogram('memory.extraction.state_changes_count', {
  description: 'Number of character state changes extracted per scene',
  unit: '1',
});

const threadUpdates = meter.createHistogram('memory.extraction.thread_updates_count', {
  description: 'Number of plot thread updates extracted per scene',
  unit: '1',
});

const extractionConfidence = meter.createHistogram('memory.extraction.confidence', {
  description: 'Average extraction confidence score',
  unit: '1',
});

const validationTime = meter.createHistogram('memory.validation.time_ms', {
  description: 'Consistency validation time (ms)',
  unit: 'ms',
});

const contradictions = meter.createHistogram('memory.validation.contradictions_count', {
  description: 'Number of contradictions found per validation run',
  unit: '1',
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const extractionAttempts = meter.createCounter('memory.extraction.attempts_total', {
  description: 'Total extraction attempts',
});

const extractionFailures = meter.createCounter('memory.extraction.failures_total', {
  description: 'Total extraction failures',
});

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | undefined>;

export function recordExtractionTime(ms: number, attrs: Attrs = {}): void {
  extractionTime.record(ms, attrs);
}

export function recordEventsExtracted(n: number, attrs: Attrs = {}): void {
  eventsExtracted.record(n, attrs);
}

export function recordStateChanges(n: number, attrs: Attrs = {}): void {
  stateChanges.record(n, attrs);
}

export function recordThreadUpdates(n: number, attrs: Attrs = {}): void {
  threadUpdates.record(n, attrs);
}

export function recordExtractionConfidence(score: number, attrs: Attrs = {}): void {
  extractionConfidence.record(score, attrs);
}

export function recordValidationTime(ms: number, attrs: Attrs = {}): void {
  validationTime.record(ms, attrs);
}

export function recordContradictions(n: number, attrs: Attrs = {}): void {
  contradictions.record(n, attrs);
}

export function incExtractionAttempts(attrs: Attrs = {}): void {
  extractionAttempts.add(1, attrs);
}

export function incExtractionFailures(attrs: Attrs = {}): void {
  extractionFailures.add(1, attrs);
}
