import { Queue, type JobsOptions } from 'bullmq';

import { buildQueueBaseOptions } from './connection';

export const WORKFLOW_QUEUE_NAME = 'book-workflow-v1';

export interface WorkflowJobData { runId: string; userId: number }

let queue: Queue<WorkflowJobData> | null = null;

export function getWorkflowQueue(): Queue<WorkflowJobData> {
  queue ??= new Queue<WorkflowJobData>(WORKFLOW_QUEUE_NAME, buildQueueBaseOptions());
  return queue;
}

export const workflowJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 200,
  removeOnFail: 200,
  keepLogs: 50,
};

export async function enqueueWorkflow(runId: string, userId: number): Promise<void> {
  const q = getWorkflowQueue();
  const jobId = `workflow--${runId}`;
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active') return;
    await existing.remove();
  }
  await q.add('workflow-run', { runId, userId }, { ...workflowJobOptions, jobId });
}

export async function shutdownWorkflowQueue(): Promise<void> {
  if (!queue) return;
  await queue.close().catch(() => undefined);
  queue = null;
}
