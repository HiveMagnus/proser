import {assertNewReleaseAdmission,runReleaseProviderEffect,providerWasNotStarted} from '@/operations/releaseAdmission';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { SceneProseService, type SceneProseContext, type SceneProseOptions, type SceneProseResult } from '@/services/sceneProseService';
import { scenesService, type SceneWritePreconditions, type SceneWriteResult } from '@/services/scenesService';
import { currentWorkflowExecution } from '@/services/workflowExecutionContext';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { documentService } from './service';
import { readScope } from './scopes';
import { canonicalDocument, regenerateDocumentText } from './model';
import { DocumentError } from './errors';
import { bindGeneratedTrace } from './traceAnalysis';
import { enqueueLiveProseJudge } from '@/services/liveProseJudgeService';
import type { LiveProseJudgePayload } from '@/queues/liveProseJudgeQueue';
import type { DocumentManifest } from './service';
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const activeInference = new Map<string, AbortController>();
export async function cancelSceneGeneration(userId: number, bookId: number, operationId: string) {
  const receipt = await documentService.cancelInference(userId, bookId, operationId);
  if (receipt.status === 'cancelled') activeInference.get(operationId)?.abort(new Error('Generation cancelled by its owner.'));
  return receipt;
}
export interface SceneGenerationRequest {
  bookId: number; sceneId: number; expected: SceneWritePreconditions;
  context: SceneProseContext; options?: Pick<SceneProseOptions, 'selectedModel' | 'timeoutMs' | 'temperature'>;
}
/** CLI retries recover the originally admitted request instead of rebasing the
 * same operation ID onto a new head. A changed command remains a conflict. */
export async function recoverSceneGeneration(userId: number, bookId: number, sceneId: number, operationId: string, useCodexRAG: boolean) {
  if (!z.string().uuid().safeParse(operationId).success) throw new DocumentError('DOCUMENT_OPERATION_INVALID', 'Generation operation ID must be a UUID.', 400);
  const retained = await readSceneGeneration(userId, bookId, operationId);
  const { input } = retained.request as unknown as { input: SceneGenerationRequest };
  if (retained.sceneId !== sceneId || input.context.useCodexRAG !== useCodexRAG) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Generation operation belongs to a different command.', 409);
  return generateOwnedScene(userId, input);
}
/** Persist an exact inference intent before the provider effect, preserve its
 * result before applying it, and never retry a running/unknown provider effect. */
export async function generateOwnedScene(userId: number, input: SceneGenerationRequest): Promise<{ scene: SceneWriteResult; generation: SceneProseResult; operationId: string; feedback?: { status: string; analysisId?: string; errorCode?: string } }> {
  const db = databaseService.client; const execution = currentWorkflowExecution();
  const caller = currentDocumentMutationContext();
  if (caller && caller.userId !== userId) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
  const signal = execution?.signal ?? caller?.signal();
  signal?.throwIfAborted();
  const expected = input.expected;
  if (!z.string().uuid().safeParse(expected?.operationId).success || !expected?.expectedRevisionId || !expected.expectedSceneRevisionId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Generation requires the saved book/scene revisions and an operation ID.', 428);
  if (input.context.bookId !== input.bookId || input.context.sceneId !== input.sceneId) throw new DocumentError('DOCUMENT_SCOPE_INVALID', 'Generation context belongs to another scope.', 409);
  if (Buffer.byteLength(canonicalDocument(input)) > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_COMMIT_TOO_LARGE', 'Generation request exceeds 8 MiB.', 413);
  const requestHash = createHash('sha256').update(canonicalDocument({ userId, input })).digest('hex');
  let row = await db.documentInferenceOperation.findUnique({ where: { id: expected.operationId } });
  if (row && (row.userId !== userId || row.bookId !== input.bookId || row.sceneId !== input.sceneId || row.requestHash !== requestHash)) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Generation operation ID belongs to a different request.', 409);
  const owned = await db.book.findFirst({ where: { id: input.bookId, userId, deletedAt: row ? {} : null }, select: { id: true } });
  if (!owned) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
  if (!row) {
    const source = await documentService.read(userId, input.bookId, input.sceneId);
    if (source.bookRevisionId !== expected.expectedRevisionId || source.revisionId !== expected.expectedSceneRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Generation source changed before inference.', 412, { currentRevisionId: source.bookRevisionId });
    // Fail unsupported regeneration before spending an inference effect.
    try { regenerateDocumentText(source.document, '', randomUUID, { authorId: userId, authorName: String(userId), createdAt: new Date().toISOString(), status: 'pending', origin: 'ai' }); }
    catch (error) { throw new DocumentError('DOCUMENT_RECONCILIATION_REQUIRED', error instanceof Error ? error.message : 'Regeneration needs reconciliation.', 409); }
    row = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${input.bookId} FOR UPDATE`;
      const prior = await tx.documentInferenceOperation.findUnique({ where: { id: expected.operationId } });
      if (prior) {
        if (prior.userId !== userId || prior.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Generation operation was reused.', 409);
        return prior;
      }
      const head = await tx.bookDocumentHead.findUniqueOrThrow({ where: { bookId: input.bookId } });
      if (head.revisionId !== expected.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed before generation admission.', 412, { currentRevisionId: head.revisionId });
      const manifest = head.manifest as unknown as DocumentManifest;
      if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Canonical scopes are required.', 409);
      const structure = await readScope(tx, input.bookId, 'structure', manifest.scopes.structure); const canon = await readScope(tx, input.bookId, 'canon', manifest.scopes.canon);
      const scene = structure.scenes.find((item) => item.id === input.sceneId)!; const chapter = structure.chapters.find((item) => item.id === scene.chapterId)!; const act = structure.acts.find((item) => item.id === chapter.actId)!;
      const terms = new Set(`${scene.outline ?? ''} ${scene.summary ?? ''} ${input.context.instructions ?? ''}`.toLowerCase().match(/[\p{L}\p{N}]+/gu));
      const ranked = canon.entries.filter((entry) => !entry.deletedAt).map((entry) => ({ entry, score: (entry.entryName.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => terms.has(word)).length })).sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
      const included = []; const omitted: number[] = []; let characters = 0;
      for (const { entry } of ranked) {
        const excerpt = [entry.entryDescription, entry.attributes].filter(Boolean).join('\n'); const size = excerpt.length + entry.entryName.length;
        if (!input.context.useCodexRAG || characters + size > Math.min(50000, (input.context.tokenBudget ?? 12000) * 4)) { omitted.push(entry.id); continue; }
        included.push({ id: entry.id, entry_type: entry.entryType, entry_name: entry.entryName, excerpt }); characters += size;
      }
      const context: SceneProseContext = { ...input.context, title: structure.book.title ?? 'Untitled', genre: structure.book.genre ?? undefined, summary: structure.book.summary ?? undefined, targetAudience: structure.book.targetAudience ?? undefined, chapterId: chapter.id, actNumber: act.actNumber, actTitle: act.title ?? undefined, chapterNumber: chapter.chapterNumber, chapterTitle: chapter.title ?? undefined, sceneNumber: scene.sceneNumber, sceneOutline: scene.outline ?? undefined, sceneSummary: scene.summary ?? undefined, targetWords: input.context.targetWords ?? 900, characters: canon.entries.filter((entry) => !entry.deletedAt && entry.entryType === 'character').map((entry) => entry.entryName) };
      return tx.documentInferenceOperation.create({ data: { id: expected.operationId, bookId: input.bookId, userId, sceneId: input.sceneId, requestHash, request: json({ input, context, codex: included, disclosure: { included: included.map((entry) => entry.id), omitted, sourceBookRevisionId: source.bookRevisionId, sourceContentHash: source.contentHash } }), sourceBookRevision: source.bookRevisionId, sourceSceneRevision: source.revisionId, sourceContentHash: source.contentHash } });
    });
  }
  if (row.status === 'pending') {
    await documentService.assertMutationAuthority(userId, input.bookId, row.sourceBookRevision);
    const claim = await db.$transaction(async tx=>{await assertNewReleaseAdmission(tx);return tx.documentInferenceOperation.updateMany({ where: { id: row!.id, status: 'pending' }, data: { status: 'running', startedAt: new Date() } });});
    if (claim.count !== 1) throw new DocumentError('DOCUMENT_INFERENCE_RUNNING', 'Recover the existing generation operation.', 409, { operationId: row.id });
    const retained = row.request as unknown as { context: SceneProseContext; codex: NonNullable<SceneProseOptions['frozenCodex']> };
    const controller = new AbortController(); activeInference.set(row.id, controller);
    const providerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // Other workers observe the durable cancellation as well. Never continue
    // inference if its operation state cannot be verified.
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return; polling = true;
      void db.documentInferenceOperation.findUnique({ where: { id: expected.operationId }, select: { status: true } }).then((current) => {
        if (!current || current.status !== 'running') controller.abort(new Error('Generation operation is no longer running.'));
      }).catch(() => controller.abort(new Error('Unable to verify generation operation.'))).finally(() => { polling = false; });
    }, 1000); timer.unref();
    let returned: SceneProseResult | undefined;
    try {
      const generation = returned = await runReleaseProviderEffect(()=>SceneProseService.getInstance().generateProse(retained.context, { ...input.options, signal: providerSignal, noTransportReplay: true, frozenContext: true, frozenCodex: retained.codex, autoReviseSkills: false, frozenSource: { bookRevisionId: row!.sourceBookRevision, sceneRevisionId: row!.sourceSceneRevision, contentHash: row!.sourceContentHash } }),{kind:'document-inference',id:row.id,bookId:row.bookId,revisionId:row.sourceSceneRevision,hash:row.sourceContentHash});
      if (Buffer.byteLength(JSON.stringify(generation)) > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_INFERENCE_RESULT_TOO_LARGE', 'Provider result exceeds 8 MiB.', 413);
      // Retain completed provider output even if cancellation/lease loss prevents application.
      await db.documentInferenceOperation.update({ where: { id: row.id }, data: { result: json(generation) } });
      await db.documentInferenceOperation.updateMany({ where: { id: row.id, status: 'running' }, data: { status: 'completed', completedAt: new Date() } });
      row = await db.documentInferenceOperation.findUniqueOrThrow({ where: { id: row.id } });
    } catch (error) {
      if(providerWasNotStarted(error)){await db.documentInferenceOperation.updateMany({where:{id:row.id,status:'running'},data:{status:'pending',startedAt:null,errorCode:'PROVIDER_NOT_STARTED'}});throw error;}
      if (error instanceof DocumentError && error.code === 'DOCUMENT_INFERENCE_RESULT_TOO_LARGE' && returned) {
        await db.documentInferenceOperation.update({ where: { id: row.id }, data: { result: { providerOutcome: 'completed', sha256: createHash('sha256').update(JSON.stringify(returned)).digest('hex'), size: Buffer.byteLength(JSON.stringify(returned)), reason: 'Result exceeded the retained JSON ceiling.' } } });
        await db.documentInferenceOperation.updateMany({ where: { id: row.id, status: 'running' }, data: { status: 'failed', errorCode: error.code, completedAt: new Date() } });
        throw error;
      }
      await db.documentInferenceOperation.updateMany({ where: { id: row.id, status: 'running' }, data: { status: 'unknown', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' } });
      const current = await db.documentInferenceOperation.findUniqueOrThrow({ where: { id: row.id } });
      if (current.status === 'cancelled') throw new DocumentError('DOCUMENT_INFERENCE_CANCELLED', 'Generation cancelled; its provider effect will not be replayed.', 409, { operationId: row.id });
      throw new DocumentError('DOCUMENT_INFERENCE_UNKNOWN', 'Generation outcome is retained as unknown; recover this operation before any new attempt.', 409, { operationId: row.id, cause: error instanceof Error ? error.message : 'Provider effect did not return.' });
    } finally { clearInterval(timer); activeInference.delete(expected.operationId); }
  }
  if (row.status !== 'completed' || !row.result) throw new DocumentError(row.status === 'cancelled' ? 'DOCUMENT_INFERENCE_CANCELLED' : row.status === 'unknown' ? 'DOCUMENT_INFERENCE_UNKNOWN' : 'DOCUMENT_INFERENCE_RUNNING', 'Recover the retained operation; its provider effect must not be replayed.', 409, { operationId: row.id, status: row.status });
  signal?.throwIfAborted();
  const generation = row.result as unknown as SceneProseResult;
  const scene = await scenesService.updateSceneProse(userId, input.sceneId, { prose: generation.prose }, { ...expected, origin: execution ? 'workflow' : 'ai', regeneration: true });
  let feedback: { status: string; analysisId?: string; errorCode?: string } | undefined;
  if (generation.traceId) {
    try {
      const analysis = await bindGeneratedTrace(userId, input.bookId, input.sceneId, generation.traceId, row.id);
      const status = analysis.status === 'pending' ? await enqueueLiveProseJudge(analysis.payload as unknown as LiveProseJudgePayload) : analysis.status;
      feedback = { analysisId: analysis.id, status };
    } catch (error) {
      // The body transaction is already durably acknowledged. Preserve that
      // success and report recoverable feedback failure separately.
      feedback = { status: 'failed', errorCode: error instanceof DocumentError ? error.code : 'DOCUMENT_ANALYSIS_SCHEDULING_FAILED' };
    }
  }
  return { scene, generation, operationId: row.id, feedback };
}
export async function readSceneGeneration(userId: number, bookId: number, operationId: string) {
  const db = databaseService.client;
  if (!await db.book.findFirst({ where: { id: bookId, userId, deletedAt: {} }, select: { id: true } })) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
  let row = await db.documentInferenceOperation.findFirst({ where: { id: operationId, bookId, userId } });
  if (!row) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Generation operation not found.', 404);
  if (row.status === 'running' && row.startedAt) {
    const retained = row.request as unknown as { input: SceneGenerationRequest };
    const maximum = Math.min(600000, Math.max(1000, retained.input.options?.timeoutMs ?? 120000)) + 30000;
    if (Date.now() - row.startedAt.getTime() > maximum) {
      await db.documentInferenceOperation.updateMany({ where: { id: row.id, status: 'running', startedAt: row.startedAt }, data: { status: 'unknown', errorCode: 'PROVIDER_ACKNOWLEDGEMENT_EXPIRED' } });
      row = await db.documentInferenceOperation.findUniqueOrThrow({ where: { id: row.id } });
    }
  }
  const saved = await db.documentOperation.findFirst({ where: { id: operationId, bookId, userId }, select: { receipt: true } });
  return { ...row, providerOutcome: row.result ? 'completed' : row.startedAt ? (row.status === 'running' ? 'pending' : 'unknown') : 'not-started', application: saved ? { status: 'committed', receipt: saved.receipt } : { status: 'unapplied' } };
}
