import { metrics } from '@opentelemetry/api';

export type InferenceOutcome =
  | 'provider_failure'
  | 'protocol_failure'
  | 'truncation'
  | 'policy_rejection'
  | 'content_filter';

type Attributes = Record<string, string | number | boolean | undefined>;

const meter = metrics.getMeter('proser.inference');
const outcomeCounter = meter.createCounter('inference.outcomes.total', {
  description: 'Inference failures and valid terminal outcomes by classification',
});
const localCounts: Record<InferenceOutcome, number> = {
  provider_failure: 0,
  protocol_failure: 0,
  truncation: 0,
  policy_rejection: 0,
  content_filter: 0,
};

export function recordInferenceOutcome(outcome: InferenceOutcome, attributes: Attributes = {}): void {
  localCounts[outcome] += 1;
  outcomeCounter.add(1, { outcome, ...attributes });
}

export function getInferenceOutcomeCounts(): Readonly<Record<InferenceOutcome, number>> {
  return { ...localCounts };
}
