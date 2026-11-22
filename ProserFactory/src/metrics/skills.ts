/**
 * Skills Runtime OTel metrics.
 *
 * Counters and histograms for individual skill executions
 * and the aggregate skill runner pipeline.
 *
 * @module metrics/skills
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('proser.skills');

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

const skillRunTime = meter.createHistogram('skills.run.time_ms', {
  description: 'Skill execution time (ms)',
  unit: 'ms',
});

const findingsCount = meter.createHistogram('skills.findings.count', {
  description: 'Number of findings produced per skill run',
  unit: '1',
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const skillRuns = meter.createCounter('skills.run.total', {
  description: 'Total skill runs (by name and status)',
});

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | undefined>;

export function recordSkillRunTime(ms: number, attrs: Attrs = {}): void {
  skillRunTime.record(ms, attrs);
}

export function recordFindingsCount(n: number, attrs: Attrs = {}): void {
  findingsCount.record(n, attrs);
}

export function incSkillRuns(attrs: Attrs = {}): void {
  skillRuns.add(1, attrs);
}
