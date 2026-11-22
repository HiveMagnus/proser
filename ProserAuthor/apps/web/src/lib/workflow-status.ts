import type { WorkflowStatus } from '@/lib/api';

export const LEGACY_TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'publishable_candidate',
  'release_approved',
]);

export const WORKFLOW_POLL_BASE_MS = 2_500;
export const WORKFLOW_POLL_MAX_MS = 60_000;

export function isTerminalWorkflow(workflow: Pick<WorkflowStatus, 'status' | 'terminal'>): boolean {
  return workflow.terminal ?? LEGACY_TERMINAL_WORKFLOW_STATUSES.has(workflow.status);
}

export function workflowPollDelayMs(failureCount: number, random = Math.random): number {
  const exponent = Math.max(0, Math.min(10, failureCount));
  const withoutJitter = Math.min(WORKFLOW_POLL_MAX_MS, WORKFLOW_POLL_BASE_MS * 2 ** exponent);
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(WORKFLOW_POLL_MAX_MS, Math.round(withoutJitter * jitter));
}
