import {releaseAdmissionsOpen} from '@/operations/releaseAdmission';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { databaseService } from '@/lib/database';
import logger from '@/lib/logger';
import { enqueueWorkflow } from '@/queues/workflowQueue';

type Db = Prisma.TransactionClient;

export async function createWorkflowEnqueue(
  db: Db,
  runId: string,
  userId: number,
  reason: string,
  dedupeKey: string,
): Promise<void> {
  await db.workflowEnqueueOutbox.create({
    data: { id: randomUUID(), runId, userId, reason, dedupeKey },
  });
}

export async function dispatchWorkflowOutbox(runIds?: string[]): Promise<number> {
  if(!await releaseAdmissionsOpen())return 0;
  const owner = randomUUID();
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 30_000);
  const candidates = await databaseService.client.workflowEnqueueOutbox.findMany({
    where: {
      status: 'pending',
      availableAt: { lte: now },
      ...(runIds?.length ? { runId: { in: runIds } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true },
  });
  let dispatched = 0;
  for (const candidate of candidates) {
    const claim = await databaseService.client.workflowEnqueueOutbox.updateMany({
      where: {
        id: candidate.id,
        status: 'pending',
        OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseOwner: owner, leaseExpiresAt, attemptCount: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    const entry = await databaseService.client.workflowEnqueueOutbox.findUniqueOrThrow({ where: { id: candidate.id } });
    try {
      await enqueueWorkflow(entry.runId, entry.userId);
      await databaseService.client.workflowEnqueueOutbox.updateMany({
        where: { id: entry.id, leaseOwner: owner, status: 'pending' },
        data: { status: 'processed', processedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null },
      });
      dispatched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await databaseService.client.workflowEnqueueOutbox.updateMany({
        where: { id: entry.id, leaseOwner: owner, status: 'pending' },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: message.slice(0, 500),
          availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(entry.attemptCount, 6))),
        },
      });
      logger.warn({ outboxId: entry.id, runId: entry.runId, error: message }, 'Workflow enqueue outbox delivery failed');
    }
  }
  return dispatched;
}
