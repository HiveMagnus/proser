import { describe, expect, it } from 'vitest';

import {
  isTerminalWorkflow,
  workflowPollDelayMs,
  WORKFLOW_POLL_MAX_MS,
} from '@/lib/workflow-status';

describe('workflow status contract', () => {
  it('uses the Factory terminal flag and recognizes publishable candidates during rollout', () => {
    expect(isTerminalWorkflow({ status: 'running', terminal: true })).toBe(true);
    expect(isTerminalWorkflow({ status: 'publishable_candidate' })).toBe(true);
    expect(isTerminalWorkflow({ status: 'running', terminal: false })).toBe(false);
  });

  it('applies capped jittered exponential polling backoff', () => {
    expect(workflowPollDelayMs(0, () => 0.5)).toBe(2_500);
    expect(workflowPollDelayMs(1, () => 0.5)).toBe(5_000);
    expect(workflowPollDelayMs(2, () => 0.5)).toBe(10_000);
    expect(workflowPollDelayMs(20, () => 1)).toBe(WORKFLOW_POLL_MAX_MS);
  });
});
