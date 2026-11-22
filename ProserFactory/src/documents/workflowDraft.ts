import { createHash } from 'node:crypto';
import type { Prisma, WorkflowRun } from '@prisma/client';
import { documentService } from './service';
import { compatibilityOperationId } from './operationIdentity';
import { canonicalDocument, projectDocument } from './model';
import { DocumentError } from './errors';
import { currentWorkflowExecution } from '@/services/workflowExecutionContext';
import { findCharacterMention } from '@/lib/reviews/characterNameMatcher';
import { bindGeneratedTrace } from './traceAnalysis';
import { enqueueLiveProseJudge } from '@/services/liveProseJudgeService';
import type { LiveProseJudgePayload } from '@/queues/liveProseJudgeQueue';
import { databaseService } from '@/lib/database';

const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Source = Awaited<ReturnType<typeof documentService.read>>;

/** The winner, source receipt, task and narrative memory are one transaction.
 * Recovery reuses its original operation, even after later document edits. */
export async function commitWorkflowDraft(run: WorkflowRun, source: Source, winner: { ordinal: number; prose: string; wordCount: number; traceId?: string }, selection: unknown) {
  const execution = currentWorkflowExecution();
  if (!execution || execution.runId !== run.id) throw new DocumentError('DOCUMENT_WORKFLOW_SCOPE_INVALID', 'A live workflow lease is required.', 403);
  const workflowEffectId = compatibilityOperationId('proser.workflow-provider.v1', { runId: run.id, effectKey: `draft:${source.sceneId}:candidate:${winner.ordinal}` });
  const operationId = compatibilityOperationId('proser.workflow-draft.v1', { runId: run.id, sceneId: source.sceneId, source: source.revisionId });
  const receipt = await documentService.mutateCatalog(run.userId, run.bookId, {
    operationId, expectedRevisionId: source.bookRevisionId, expectedScopes: {}, payload: { command: 'workflow-draft-selection', sceneId: source.sceneId, sourceRevisionId: source.revisionId, workflowEffectId, winner, selection },
  }, async (tx) => {
    const effect = await tx.documentWorkflowEffect.findFirst({ where: { id: workflowEffectId, runId: run.id, userId: run.userId, bookId: run.bookId, sceneId: source.sceneId, status: 'completed' } });
    const envelope = effect?.result as unknown as { schemaVersion: number; data: { prose: string; wordCount: number; traceId?: string }; sha256: string } | undefined;
    const frozen = effect?.request as unknown as { source?: { sceneRevisionId: string; bookRevisionId: string; contentHash: string } } | undefined;
    if (!effect || !envelope || envelope.schemaVersion !== 1 || digest(envelope.data) !== envelope.sha256 || digest(effect.request) !== effect.requestHash || frozen?.source?.sceneRevisionId !== source.revisionId || frozen.source.bookRevisionId !== source.bookRevisionId || frozen.source.contentHash !== source.contentHash || envelope.data.prose !== winner.prose || envelope.data.wordCount !== winner.wordCount || envelope.data.traceId !== winner.traceId) throw new DocumentError('DOCUMENT_WORKFLOW_SELECTION_INVALID', 'The winner does not match its retained provider result and complete source.', 409);
    const document = await documentService.replacementDocument(tx, run.bookId, source.sceneId, source.revisionId, winner.prose, run.userId, 'workflow', true);
    if (projectDocument(document).text !== winner.prose) throw new DocumentError('DOCUMENT_WORKFLOW_SELECTION_INVALID', 'The selected projection changed during conversion.', 409);
    return {
      result: { sceneId: source.sceneId, workflowRunId: run.id, workflowEffectId, selectedOrdinal: winner.ordinal, traceId: winner.traceId },
      changedDocuments: [{ sceneId: source.sceneId, expectedRevisionId: source.revisionId, document }],
      recordCommitted: async (transaction, committed) => {
        await transaction.workflowArtifact.create({ data: { id: operationId, runId: run.id, artifactType: 'scene_candidate_selection', scopeType: 'scene', scopeId: String(source.sceneId), contentHash: digest(selection), payload: json({ selection, operationId, workflowEffectId, sourceBookRevisionId: source.bookRevisionId, sourceSceneRevisionId: source.revisionId, outputRevisionId: committed.revisionId }) } });
        await transaction.workflowTask.update({ where: { runId_taskKey: { runId: run.id, taskKey: `draft:scene:${source.sceneId}` } }, data: { status: 'completed', finishedAt: new Date(), outputRevisionId: committed.revisionId, validationResult: json({ winnerWords: winner.wordCount, operationId, workflowEffectId }) } });
        const characters = await transaction.codexEntry.findMany({ where: { bookId: run.bookId, entryType: 'character', deletedAt: null } });
        const actors = characters.filter((actor) => findCharacterMention(actor, characters, winner.prose).matched);
        const exactEnding = winner.prose.trim().split(/\s+/).slice(-120).join(' ');
        await transaction.sceneMemoryEvent.create({ data: { bookId: run.bookId, sceneId: source.sceneId, eventType: 'scene_complete', actors: json(actors.map((actor) => ({ codexId: actor.id, name: actor.entryName }))), summary: winner.prose.trim().split(/(?<=[.!?])\s+/).slice(-3).join(' ').slice(0,2000), payload: json({ exactEnding, wordCount: winner.wordCount, operationId, sourceRevisionId: committed.revisionId }), ordering: source.sceneId } });
        for (const actor of actors) await transaction.characterState.upsert({ where: { bookId_codexId_sceneId_stateKey: { bookId: run.bookId, codexId: actor.id, sceneId: source.sceneId, stateKey: 'appeared' } }, update: { stateValue: 'true', confidence: 1 }, create: { bookId: run.bookId, codexId: actor.id, sceneId: source.sceneId, stateKey: 'appeared', stateValue: 'true', confidence: 1 } });
        const due = await transaction.narrativeLedger.findFirst({ where: { workflowRunId: run.id, dueSceneId: source.sceneId, status: 'open' } });
        if (due) await transaction.narrativeLedger.update({ where: { id: due.id }, data: { status: 'resolved', resolvedSceneId: source.sceneId, payload: json({ ...(due.payload as object), resolutionEvidence: exactEnding, operationId }) } });
        if (winner.traceId) await bindGeneratedTrace(run.userId, run.bookId, source.sceneId, winner.traceId, operationId, workflowEffectId, transaction);
      },
    };
  }, 'workflow');
  // Dispatch is recoverable from the bound pending analysis. Its uncertain
  // outcome never rolls back acknowledged document bytes or repeats inference.
  if (winner.traceId) {
    const analysis = await databaseService.client.documentTraceAnalysis.findUnique({ where: { traceId: winner.traceId } });
    if (analysis?.status === 'pending') await enqueueLiveProseJudge(analysis.payload as unknown as LiveProseJudgePayload).catch(() => undefined);
  }
  return receipt;
}
