import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

import { databaseService } from '@/lib/database';
import { assertSharedResourceOperationCurrent } from '@/services/sharedResourceService';

export interface WorkflowExecutionContext {
  runId: string;
  leaseOwner: string;
  signal: AbortSignal;
  sharedResourceOperationId?: string;
}

const storage = new AsyncLocalStorage<WorkflowExecutionContext>();

export function runWithWorkflowExecution<T>(context: WorkflowExecutionContext, action: () => Promise<T>): Promise<T> {
  return storage.run(context, action);
}

export function currentWorkflowExecution(): WorkflowExecutionContext | undefined {
  return storage.getStore();
}

export function currentWorkflowSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

export function currentWorkflowLease(): Pick<WorkflowExecutionContext, 'runId' | 'leaseOwner'> | undefined {
  const context = storage.getStore();
  return context ? { runId: context.runId, leaseOwner: context.leaseOwner } : undefined;
}

async function assertOwnedLease(
  client: Pick<Prisma.TransactionClient, 'workflowRun' | 'sharedResourceOperation' | 'sharedResourceFence'>,
  context: WorkflowExecutionContext,
): Promise<void> {
  const owned = await client.workflowRun.count({
    where: {
      id: context.runId,
      leaseOwner: context.leaseOwner,
      leaseExpiresAt: { gt: new Date() },
      status: 'running',
      cancelRequested: false,
    },
  });
  if (owned !== 1) throw new Error(`Workflow lease lost for ${context.runId}`);
  if (context.sharedResourceOperationId) {
    await assertSharedResourceOperationCurrent(context.sharedResourceOperationId, client, true);
  }
}

/**
 * Refuse a workflow mutation after its lease has been lost. This is deliberately
 * called at manuscript and revision boundaries in addition to conditional run
 * updates, so an expired worker cannot keep writing after a recovery claim.
 */
export async function assertWorkflowLease(expectedRunId?: string): Promise<void> {
  const context = storage.getStore();
  if (!context) return;
  if (expectedRunId && context.runId !== expectedRunId) {
    throw new Error(`Workflow lease context mismatch for ${expectedRunId}`);
  }
  await assertOwnedLease(databaseService.client, context);
}

/** Execute related writes in the same database transaction as the lease check. */
export async function withWorkflowLease<T>(
  expectedRunId: string,
  action: (tx: Prisma.TransactionClient, leaseOwner: string) => Promise<T>,
): Promise<T> {
  const context = storage.getStore();
  if (!context || context.runId !== expectedRunId) {
    throw new Error(`Workflow lease context mismatch for ${expectedRunId}`);
  }
  return databaseService.client.$transaction(async (tx) => {
    await assertOwnedLease(tx, context);
    return action(tx, context.leaseOwner);
  });
}

/**
 * Renew only a lease that is still live. An expired worker may never revive its
 * own token while a recovery worker is deciding whether to reclaim the run.
 */
export async function renewWorkflowLease(expectedRunId: string, leaseMs: number): Promise<void> {
  const context = storage.getStore();
  if (!context || context.runId !== expectedRunId) {
    throw new Error(`Workflow lease context mismatch for ${expectedRunId}`);
  }
  const now = new Date();
  if (context.sharedResourceOperationId) {
    await assertSharedResourceOperationCurrent(context.sharedResourceOperationId, undefined, true);
  }
  const renewed = await databaseService.client.workflowRun.updateMany({
    where: {
      id: context.runId,
      status: 'running',
      cancelRequested: false,
      leaseOwner: context.leaseOwner,
      leaseExpiresAt: { gt: now },
    },
    data: {
      lastHeartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
    },
  });
  if (renewed.count !== 1) throw new Error(`Workflow lease lost for ${context.runId}`);
}
