import { randomUUID } from 'node:crypto';

import { databaseService } from '@/lib/database';
import {
  applyEditorialPatches,
  EditorialPatchVerificationError,
} from '@/services/editorial/editorialApplicationService';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';
import { textHash } from '@/services/editorial/textAnchors';
import {
  editorialMetricsSnapshot,
  incrementEditorialMetric,
} from '@/services/editorial/metrics';
import {
  renewWorkflowLease,
  runWithWorkflowExecution,
  withWorkflowLease,
} from '@/services/workflowExecutionContext';

const prefix = `jest-editorial-fencing-${Date.now()}`;

describe('editorial workflow fencing', () => {
  let userId: number;
  let bookId: number;
  let sceneId: number;
  let sourceRevisionId: string;

  beforeAll(async () => {
    const user = await databaseService.client.user.create({
      data: { githubId: prefix, username: prefix },
    });
    userId = user.id;
    const book = await databaseService.client.book.create({
      data: { userId, title: 'Editorial fencing fixture' },
    });
    bookId = book.id;
    const act = await databaseService.client.act.create({
      data: { bookId, actNumber: 1, title: 'Act' },
    });
    const chapter = await databaseService.client.chapter.create({
      data: { actId: act.id, chapterNumber: 1, title: 'Chapter' },
    });
    const scene = await databaseService.client.scene.create({
      data: {
        chapterId: chapter.id,
        sceneNumber: 1,
        prose: 'The original revision remains recoverable.',
        wordCount: 6,
      },
    });
    sceneId = scene.id;
    sourceRevisionId = await manuscriptRevisionService.current(bookId);
    await databaseService.client.manuscriptRevision.update({
      where: { id: sourceRevisionId },
      data: { createdAt: new Date(Date.now() - 10_000) },
    });
  });

  afterAll(async () => {
    await databaseService.client.user.deleteMany({ where: { githubId: prefix } });
  });

  async function createRunningWorkflow(leaseOwner: string) {
    const runId = randomUUID();
    await databaseService.client.workflowRun.create({
      data: {
        id: runId,
        workflowType: 'editorial_optimize',
        bookId,
        userId,
        sourceRevisionId,
        status: 'running',
        phase: 'persist_result_revision',
        settings: {},
        idempotencyKey: randomUUID(),
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    return runId;
  }

  it('does not roll back over a newer concurrent revision', async () => {
    const leaseOwner = randomUUID();
    const runId = await createRunningWorkflow(leaseOwner);
    const resultRevisionId = await runWithWorkflowExecution(
      { runId, leaseOwner, signal: new AbortController().signal },
      () => manuscriptRevisionService.applyScenePatches({
        bookId,
        expectedRevisionId: sourceRevisionId,
        workflowRunId: runId,
        patches: [{
          sceneId,
          expectedProse: 'The original revision remains recoverable.',
          revisedProse: 'The editorial revision remains recoverable.',
        }],
      }),
    );
    await databaseService.client.manuscriptRevision.update({
      where: { id: resultRevisionId },
      data: { createdAt: new Date(Date.now() - 5_000) },
    });

    const concurrentRevisionId = await manuscriptRevisionService.applyScenePatches({
      bookId,
      expectedRevisionId: resultRevisionId,
      patches: [{
        sceneId,
        expectedProse: 'The editorial revision remains recoverable.',
        revisedProse: 'The user concurrent revision must survive.',
      }],
    });

    const rollbackRevisionId = await runWithWorkflowExecution(
      { runId, leaseOwner, signal: new AbortController().signal },
      () => manuscriptRevisionService.restoreIfCurrent({
        bookId,
        revisionId: sourceRevisionId,
        expectedCurrentRevisionId: resultRevisionId,
        workflowRunId: runId,
      }),
    );

    expect(rollbackRevisionId).toBeNull();
    expect((await manuscriptRevisionService.currentAncestry(bookId)).current).toBe(concurrentRevisionId);
    expect(await databaseService.client.scene.findUnique({
      where: { id: sceneId },
      select: { prose: true },
    })).toEqual({ prose: 'The user concurrent revision must survive.' });
    expect(await databaseService.client.manuscriptRevision.count({
      where: { id: { in: [sourceRevisionId, resultRevisionId, concurrentRevisionId] } },
    })).toBe(3);
  });

  it('rejects all writes and renewal from a stale lease token', async () => {
    const staleOwner = randomUUID();
    const runId = await createRunningWorkflow(staleOwner);
    await databaseService.client.workflowRun.update({
      where: { id: runId },
      data: {
        leaseOwner: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(runWithWorkflowExecution(
      { runId, leaseOwner: staleOwner, signal: new AbortController().signal },
      () => withWorkflowLease(runId, async (tx) => {
        await tx.workflowEvent.create({
          data: { runId, eventType: 'stale_worker_write' },
        });
      }),
    )).rejects.toThrow(`Workflow lease lost for ${runId}`);
    await expect(runWithWorkflowExecution(
      { runId, leaseOwner: staleOwner, signal: new AbortController().signal },
      () => renewWorkflowLease(runId, 60_000),
    )).rejects.toThrow(`Workflow lease lost for ${runId}`);
    expect(await databaseService.client.workflowEvent.count({
      where: { runId, eventType: 'stale_worker_write' },
    })).toBe(0);
  });

  it('publishes neither verification evidence nor metrics after losing the lease post-apply', async () => {
    const staleOwner = randomUUID();
    const currentRevisionId = (await manuscriptRevisionService.currentAncestry(bookId)).current!;
    const runId = randomUUID();
    await databaseService.client.workflowRun.create({
      data: {
        id: runId,
        workflowType: 'editorial_optimize',
        bookId,
        userId,
        sourceRevisionId: currentRevisionId,
        status: 'running',
        phase: 'persist_result_revision',
        settings: {},
        idempotencyKey: randomUUID(),
        leaseOwner: staleOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const prose = (await databaseService.client.scene.findUniqueOrThrow({
      where: { id: sceneId },
      select: { prose: true },
    })).prose!;
    const applied = await runWithWorkflowExecution(
      { runId, leaseOwner: staleOwner, signal: new AbortController().signal },
      () => applyEditorialPatches({
        userId,
        bookId,
        expectedRevisionId: currentRevisionId,
        workflowRunId: runId,
        patches: [{
          sceneId,
          originalText: prose,
          candidateText: `${prose} Candidate applied.`,
          sourceHash: textHash(prose),
          startOffset: 0,
          endOffset: prose.length,
          maxChangedPercent: 100,
        }],
      }),
    );
    expect(applied.revisionId).toBeDefined();

    await databaseService.client.workflowRun.update({
      where: { id: runId },
      data: {
        leaseOwner: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const metric = `stale_post_apply_${runId}`;
    await expect(runWithWorkflowExecution(
      { runId, leaseOwner: staleOwner, signal: new AbortController().signal },
      () => withWorkflowLease(runId, async (tx) => {
        await tx.workflowArtifact.create({
          data: {
            id: randomUUID(),
            runId,
            artifactType: 'editorial_verification',
            scopeType: 'editorial',
            contentHash: textHash('stale evidence'),
            sourceRevisionId: currentRevisionId,
            resultRevisionId: applied.revisionId,
            payload: { passed: true },
          },
        });
        await incrementEditorialMetric(metric);
      }),
    )).rejects.toThrow(`Workflow lease lost for ${runId}`);

    expect(await databaseService.client.workflowArtifact.count({
      where: { runId, artifactType: 'editorial_verification' },
    })).toBe(0);
    expect((await editorialMetricsSnapshot()).counters).not.toHaveProperty(metric);
  });

  it('returns exact per-patch hashes and failures from the checks performed', async () => {
    const prose = (await databaseService.client.scene.findUniqueOrThrow({
      where: { id: sceneId },
      select: { prose: true },
    })).prose!;
    const currentRevisionId = (await manuscriptRevisionService.currentAncestry(bookId)).current!;
    const applied = await applyEditorialPatches({
      userId,
      bookId,
      expectedRevisionId: currentRevisionId,
      patches: [{
        sceneId,
        originalText: prose,
        candidateText: prose,
        sourceHash: textHash(prose),
        startOffset: 0,
        endOffset: prose.length,
        maxChangedPercent: 100,
      }],
    });
    expect(applied.verification).toEqual([expect.objectContaining({
      patchIndex: 0,
      sceneId,
      result: expect.objectContaining({
        passed: true,
        failures: [],
        sourceHash: textHash(prose),
        candidateHash: textHash(prose),
      }),
    })]);

    await expect(applyEditorialPatches({
      userId,
      bookId,
      expectedRevisionId: applied.revisionId,
      patches: [{
        sceneId,
        originalText: prose,
        candidateText: '',
        sourceHash: textHash(prose),
        startOffset: 0,
        endOffset: prose.length,
        maxChangedPercent: 100,
      }],
    })).rejects.toMatchObject({
      name: EditorialPatchVerificationError.name,
      verification: [expect.objectContaining({
        result: expect.objectContaining({
          passed: false,
          failures: expect.arrayContaining(['empty_candidate']),
        }),
      })],
    });
    expect((await databaseService.client.scene.findUniqueOrThrow({
      where: { id: sceneId },
      select: { prose: true },
    })).prose).toBe(prose);
  });
});
