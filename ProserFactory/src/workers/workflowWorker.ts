import {DocumentError} from '@/documents/errors';
import {releaseAdmissionsOpen} from '@/operations/releaseAdmission';
import {DelayedError} from 'bullmq';
import { Job, Worker } from 'bullmq';

import { buildWorkerOptions } from '@/queues/connection';
import { WORKFLOW_QUEUE_NAME, type WorkflowJobData } from '@/queues/workflowQueue';
import { enqueueWorkflow, getWorkflowQueue } from '@/queues/workflowQueue';
import { databaseService } from '@/lib/database';
import { workflowService } from '@/services/workflowService';
import logger from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import { createWorkflowEnqueue } from '@/queues/workflowOutbox';
import { acquireSharedResourceAuthorityLock, finalizeSharedResourceExecution, SharedResourceError, sharedResourceExecutionOperation } from '@/services/sharedResourceService';

export async function processWorkflowJob(job: Job<WorkflowJobData>, token?:string): Promise<void> {
  if(!await releaseAdmissionsOpen()){await job.moveToDelayed(Date.now()+1000,token);throw new DelayedError();}
  await job.log(`Processing ${job.data.runId}`);
  await job.updateProgress({ startedAt: new Date().toISOString() });
  const binding = await sharedResourceExecutionOperation('workflow', job.data.runId);
  const releaseAuthority = binding ? await acquireSharedResourceAuthorityLock() : null;
  try {
    try {
      await workflowService.process(job.data.runId);
    } catch (error) {
      if(error instanceof DocumentError&&error.code==='DOCUMENT_ADMISSIONS_FENCED'){await job.moveToDelayed(Date.now()+1000,token);throw new DelayedError();}
      if (binding && error instanceof SharedResourceError && error.code === 'SHARED_RESOURCE_FENCE_LOST') {
        const finishedAt = new Date();
        await databaseService.client.workflowRun.updateMany({ where: {
          id: job.data.runId, status: { in: ['queued', 'running', 'failed'] },
        }, data: {
          status: 'cancelled', cancelRequested: true, failureClass: 'validation',
          failureReason: 'The shared resource operation was superseded before worker publication.',
          finishedAt, leaseOwner: null, leaseExpiresAt: null,
        } });
        await finalizeSharedResourceExecution('workflow', job.data.runId, 'failed', 409, { success: false, error: {
          code: 'SHARED_RESOURCE_FENCE_LOST', message: 'The workflow was cancelled before publication because its shared resource fence was superseded.',
        } });
        return;
      }
      throw error;
    }
    if (binding) {
      const run = await databaseService.client.workflowRun.findUnique({ where: { id: job.data.runId }, select: { status: true, bookId: true, resultRevisionId: true, sourceRevisionId: true, finishedAt: true } });
      if (run && ['completed', 'release_approved'].includes(run.status)) {
        await finalizeSharedResourceExecution('workflow', job.data.runId, 'succeeded', 200, { success: true, data: {
          runId: job.data.runId, bookId: run.bookId, status: run.status, resultRevisionId: run.resultRevisionId ?? run.sourceRevisionId,
        } });
      } else if (run && (run.status === 'cancelled' || run.status === 'failed' && run.finishedAt)) {
        await finalizeSharedResourceExecution('workflow', job.data.runId, 'failed', 409, { success: false, error: {
          code: run.status === 'cancelled' ? 'WORKFLOW_CANCELLED' : 'WORKFLOW_FAILED', message: `Workflow ${job.data.runId} ended in ${run.status}.`,
        } });
      }
    }
  } finally {
    await releaseAuthority?.();
  }
}

export function startWorkflowWorker() {
  const worker = new Worker<WorkflowJobData>(WORKFLOW_QUEUE_NAME, processWorkflowJob, buildWorkerOptions(1));
  worker.on('completed', (job) => logger.info({ jobId: job.id, runId: job.data.runId }, 'Workflow job completed'));
  worker.on('failed', (job, error) => logger.error({ jobId: job?.id, runId: job?.data?.runId, error: error.message }, 'Workflow job failed'));
  return worker;
}

type RecoveryQueue = Pick<ReturnType<typeof getWorkflowQueue>, 'getJob'>;

/** Re-enqueue DB-active workflows whose BullMQ job vanished or became terminal. */
export async function recoverOrphanedWorkflowRuns(
  queue: RecoveryQueue = getWorkflowQueue(),
  enqueue: typeof enqueueWorkflow = enqueueWorkflow,
  runIds?: string[],
): Promise<number> {
  if(!await releaseAdmissionsOpen())return 0;
  const now = new Date();
  const candidates = await databaseService.client.workflowRun.findMany({
    where: {
      cancelRequested: false,
      AND: [
        { OR: [{ status: { in: ['queued', 'running'] } }, { status: 'failed', failureClass: 'infrastructure' }] },
        { OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }] },
      ],
      ...(runIds ? { id: { in: runIds } } : {}),
    },
    orderBy: [{ parentRunId: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, userId: true, status: true, workflowType: true, parentRunId: true, attemptCount: true, deliveryAttemptCount: true, maxAttempts: true, recoveryCount: true },
  });
  let recovered = 0;
  // Explicit two-pass ordering prevents a child from being considered before
  // its top-level orchestrator in the same locked recovery set.
  const ordered = [...candidates.filter((run) => !run.parentRunId), ...candidates.filter((run) => run.parentRunId)];
  for (const run of ordered) {
    if (run.parentRunId) {
      const activeParent = await databaseService.client.workflowRun.count({
        where: { id: run.parentRunId, status: { notIn: ['completed', 'cancelled', 'release_approved'] } },
      });
      if (activeParent) continue;
    }
    const recoveryOwner = randomUUID();
    const recoveryClaim = await databaseService.client.workflowRun.updateMany({
      where: {
        id: run.id,
        cancelRequested: false,
        AND: [
          { OR: [{ status: { in: ['queued', 'running'] } }, { status: 'failed', failureClass: 'infrastructure' }] },
          { OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }] },
          { OR: [{ recoveryLeaseOwner: null }, { recoveryLeaseExpiresAt: { lt: now } }] },
        ],
      },
      data: { recoveryLeaseOwner: recoveryOwner, recoveryLeaseExpiresAt: new Date(now.getTime() + 30_000) },
    });
    if (recoveryClaim.count !== 1) continue;
    const job = await queue.getJob(`workflow--${run.id}`);
    const state = job ? await job.getState() : 'missing';
    if (['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
      await databaseService.client.workflowRun.updateMany({ where: { id: run.id, recoveryLeaseOwner: recoveryOwner }, data: { recoveryLeaseOwner: null, recoveryLeaseExpiresAt: null } });
      continue;
    }
    const priorRecoveries = run.recoveryCount;
    if (run.deliveryAttemptCount >= run.maxAttempts || priorRecoveries >= 10) {
      const terminalized = await databaseService.client.$transaction(async (tx) => {
        const checkedAt = new Date();
        const updated = await tx.workflowRun.updateMany({
          where: {
            id: run.id, recoveryLeaseOwner: recoveryOwner, cancelRequested: false,
            AND: [
              { OR: [{ status: { in: ['queued', 'running'] } }, { status: 'failed', failureClass: 'infrastructure' }] },
              { OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: checkedAt } }] },
            ],
          },
          data: {
            status: run.workflowType === 'editorial_optimize' ? 'failed' : 'paused',
            finishedAt: run.workflowType === 'editorial_optimize' ? checkedAt : null,
            failureReason: run.deliveryAttemptCount >= run.maxAttempts ? 'Workflow exhausted its delivery attempt budget.' : 'Workflow exceeded the bounded infrastructure recovery budget.',
            failureClass: 'infrastructure', recoveryLeaseOwner: null, recoveryLeaseExpiresAt: null,
          },
        });
        if (updated.count !== 1) return false;
        await tx.workflowEvent.create({ data: { runId: run.id, eventType: 'recovery_exhausted', data: { priorState: state, recoveries: priorRecoveries, executions: run.attemptCount, currentDeliveryAttempts: run.deliveryAttemptCount, maximumDeliveryAttempts: run.maxAttempts } } });
        return true;
      });
      if (!terminalized) await databaseService.client.workflowRun.updateMany({ where: { id: run.id, recoveryLeaseOwner: recoveryOwner }, data: { recoveryLeaseOwner: null, recoveryLeaseExpiresAt: null } });
      continue;
    }
    const outboxKey = `recovery:${run.id}:${priorRecoveries + 1}`;
    const reset = await databaseService.client.$transaction(async (tx) => {
      const checkedAt = new Date();
      const updated = await tx.workflowRun.updateMany({
        where: {
          id: run.id,
          recoveryLeaseOwner: recoveryOwner,
          cancelRequested: false,
          AND: [
            { OR: [{ status: { in: ['queued', 'running'] } }, { status: 'failed', failureClass: 'infrastructure' }] },
            { OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: checkedAt } }] },
          ],
        },
        data: { status: 'queued', recoveryCount: { increment: 1 }, failureReason: null, failureClass: null, lastHeartbeatAt: checkedAt, leaseOwner: null, leaseExpiresAt: null, recoveryLeaseOwner: null, recoveryLeaseExpiresAt: null, executionParentRunId: null },
      });
      if (updated.count !== 1) return false;
      await tx.workflowEvent.create({ data: { runId: run.id, eventType: 'orphan_recovered', data: { priorRunStatus: run.status, priorJobState: state, recovery: priorRecoveries + 1 } } });
      await createWorkflowEnqueue(tx, run.id, run.userId, 'orphan_recovery', outboxKey);
      return true;
    });
    if (!reset) {
      await databaseService.client.workflowRun.updateMany({ where: { id: run.id, recoveryLeaseOwner: recoveryOwner }, data: { recoveryLeaseOwner: null, recoveryLeaseExpiresAt: null } });
      continue;
    }
    try {
      await enqueue(run.id, run.userId);
      await databaseService.client.workflowEnqueueOutbox.update({ where: { dedupeKey: outboxKey }, data: { status: 'processed', processedAt: new Date() } });
    } catch (error) {
      logger.warn({ runId: run.id, error: error instanceof Error ? error.message : String(error) }, 'Recovered workflow remains pending in enqueue outbox');
    }
    recovered += 1;
  }
  if (recovered) logger.warn({ recovered }, 'Recovered orphaned durable workflow jobs');
  return recovered;
}
