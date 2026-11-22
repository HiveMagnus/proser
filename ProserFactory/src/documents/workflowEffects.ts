import {assertNewReleaseAdmission,runReleaseProviderEffect,providerWasNotStarted} from '@/operations/releaseAdmission';
import { createHash } from 'node:crypto';
import type { Prisma, DocumentWorkflowEffect } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { currentWorkflowExecution, assertWorkflowLease } from '@/services/workflowExecutionContext';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import { documentService } from './service';
import { canonicalDocument, type DocumentManifest } from './model';
import { compatibilityOperationId } from './operationIdentity';
import { DocumentError } from './errors';

const db = () => databaseService.client;
const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const active = new Map<string, AbortController>();
export interface WorkflowEffectInput {
  userId: number; bookId: number; runId: string; effectKey: string; intent: unknown;
  sceneId?: number; expectedRevisionId?: string; timeoutMs: number;
}
export function workflowEffectNeedsRecovery(error: unknown) {
  return error instanceof DocumentError && ['WORKFLOW_EFFECT_UNKNOWN','WORKFLOW_EFFECT_RUNNING','WORKFLOW_EFFECT_FAILED','WORKFLOW_EFFECT_CANCELLED'].includes(error.code);
}
async function owned(userId: number, bookId: number, runId: string) {
  if (currentDocumentMutationContext()?.userId !== undefined && currentDocumentMutationContext()!.userId !== userId || !await db().workflowRun.findFirst({ where: { id: runId, userId, bookId, book: { userId } }, select: { id: true } })) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Workflow not found.', 404);
}
function unavailable(row: { id: string; status: string; errorCode: string | null }): never {
  throw new DocumentError(`WORKFLOW_EFFECT_${row.status === 'running' ? 'RUNNING' : row.status === 'failed' ? 'FAILED' : row.status === 'cancelled' ? 'CANCELLED' : 'UNKNOWN'}`, 'Recover this retained provider outcome before continuing the workflow.', 409, { operationId: row.id, status: row.status, errorCode: row.errorCode });
}
function retainedFailure(row: { id: string; status: string; errorCode: string | null; result: Prisma.JsonValue | null }): never {
  const terminal = row.result as { providerOutcome?: string; finishReason?: string; code?: InferenceTerminalError['code']; context?: InferenceTerminalError['context']; raw?: string } | null;
  if (row.status === 'failed' && terminal?.providerOutcome === 'completed' && terminal.code && terminal.context && terminal.finishReason) throw new InferenceTerminalError(terminal.code, terminal.finishReason, terminal.context, terminal.raw ?? '');
  unavailable(row);
}
function completedResult<O>(row: { request: Prisma.JsonValue; requestHash: string; result: Prisma.JsonValue | null }): O {
  const result = row.result as { schemaVersion?: number; data?: O; sha256?: string } | null;
  if (digest(row.request) !== row.requestHash || result?.schemaVersion !== 1 || result.data === undefined || result.sha256 !== digest(result.data)) throw new DocumentError('WORKFLOW_EFFECT_INVALID', 'Retained request/result checksum is invalid.', 503);
  return result.data;
}
/** A crash after the acknowledged bytes were stored can leave the status
 * running/unknown. Recover only checksum-verified retained bytes; never dispatch. */
async function recoverAcknowledgedEffect(row: DocumentWorkflowEffect): Promise<DocumentWorkflowEffect> {
  if (!['running','unknown'].includes(row.status) || active.has(row.id) || !row.result || typeof row.result !== 'object' || Array.isArray(row.result) || row.result.schemaVersion !== 1 || row.result.providerOutcome !== 'completed') return row;
  completedResult(row);
  const source = await db().bookDocumentRevision.findFirst({ where: { bookId: row.bookId, id: row.sourceBookRevision } });
  if (!source || source.contentHash !== row.sourceContentHash || digest(source.manifest) !== row.sourceContentHash) throw new DocumentError('WORKFLOW_EFFECT_INVALID', 'Acknowledged effect source checksum is invalid.', 503);
  await documentService.sideRecord(row.userId, row.bookId, async tx => {
    const current = await tx.documentWorkflowEffect.findUniqueOrThrow({ where: { id: row.id } });
    if (!['running','unknown'].includes(current.status) || digest(current.result) !== digest(row.result)) return;
    completedResult(current);
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: row.runId } });
    const status = run.cancelRequested || run.status === 'cancelled' ? 'cancelled' : 'completed';
    const changed = await tx.documentWorkflowEffect.updateMany({ where: { id: row.id, status: current.status }, data: { status, completedAt: new Date(), errorCode: status === 'cancelled' ? 'CANCELLED_BY_OWNER' : null } });
    if (changed.count) await tx.auditLog.create({ data: { userId: row.userId, entityType: 'book', entityId: row.bookId, action: 'update', metadata: { action: 'recover-acknowledged-workflow-effect', operationId: row.id, priorStatus: current.status, resultHash: digest(current.result), status } } });
  });
  return db().documentWorkflowEffect.findUniqueOrThrow({ where: { id: row.id } });
}
/** Recover before preparing another request. Provider effects are single-shot;
 * completed output survives pause/lease loss, while late application is fenced. */
export async function runWorkflowEffect<I, O>(input: WorkflowEffectInput, prepare: (tx: Prisma.TransactionClient, manifest: DocumentManifest) => Promise<I>, invoke: (request: I, signal: AbortSignal) => Promise<O>): Promise<O> {
  const context = currentWorkflowExecution();
  if (!context || context.runId !== input.runId) throw new DocumentError('DOCUMENT_WORKFLOW_SCOPE_INVALID', 'A live owned workflow lease is required.', 403);
  await owned(input.userId, input.bookId, input.runId); await assertWorkflowLease(input.runId); context.signal.throwIfAborted();
  if (!input.effectKey || input.effectKey.length > 1000 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 600000) throw new DocumentError('WORKFLOW_EFFECT_INVALID', 'Invalid effect key or deadline.', 422);
  const id = compatibilityOperationId('proser.workflow-provider.v1', { runId: input.runId, effectKey: input.effectKey });
  const intentHash = digest({ userId: input.userId, bookId: input.bookId, runId: input.runId, sceneId: input.sceneId, effectKey: input.effectKey, intent: input.intent });
  let row = await db().documentWorkflowEffect.findUnique({ where: { id } });
  if (row && (row.userId !== input.userId || row.bookId !== input.bookId || row.runId !== input.runId || row.intentHash !== intentHash)) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Workflow effect identity was reused for another intent.', 409);
  if (row) row = await recoverAcknowledgedEffect(row);
  if (row?.status === 'completed' && row.result !== null) {
    return completedResult<O>(row);
  }
  if (row && row.status !== 'pending') retainedFailure(row);
  // One unknown/running prior effect blocks new provider work for this run.
  // A worker restart cannot evade recovery by selecting a different key.
  const unresolved = await db().documentWorkflowEffect.findFirst({ where: { runId: input.runId, id: { not: id }, OR: [{ status: 'unknown' }, { status: 'running', OR: [{ leaseOwner: { not: context.leaseOwner } }, { leaseOwner: null }] }] }, select: { id: true, status: true, errorCode: true } });
  if (unresolved) unavailable(unresolved);
  if (!row) row = await documentService.sideRecord(input.userId, input.bookId, async (tx) => {
    const prior = await tx.documentWorkflowEffect.findUnique({ where: { id } });
    if (prior) { if (prior.intentHash !== intentHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Effect key was reused.', 409); return prior; }
    const head = await tx.bookDocumentHead.findUniqueOrThrow({ where: { bookId: input.bookId } });
    if (input.expectedRevisionId && head.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Workflow source changed before provider admission.', 412, { currentRevisionId: head.revisionId });
    const source = await tx.bookDocumentRevision.findFirst({ where: { id: head.revisionId, bookId: input.bookId } });
    if (!source || digest(head.manifest) !== source.contentHash) throw new DocumentError('DOCUMENT_MANIFEST_INVALID', 'Effect source manifest checksum is invalid.', 503);
    const request = await prepare(tx, head.manifest as unknown as DocumentManifest);
    if (Buffer.byteLength(canonicalDocument(request)) > 8 * 1024 * 1024) throw new DocumentError('WORKFLOW_EFFECT_TOO_LARGE', 'Complete provider request exceeds 8 MiB. It was not truncated or sent.', 413);
    return tx.documentWorkflowEffect.create({ data: { id, userId: input.userId, bookId: input.bookId, runId: input.runId, effectKey: input.effectKey, sceneId: input.sceneId, sourceBookRevision: head.revisionId, sourceContentHash: source.contentHash, intentHash, request: json(request), requestHash: digest(request), timeoutMs: input.timeoutMs } });
  });
  if (row.status === 'completed' && row.result !== null) return completedResult<O>(row);
  if (row.status !== 'pending') retainedFailure(row);
  await documentService.assertMutationAuthority(input.userId, input.bookId, row.sourceBookRevision);
  const claimed = await db().$transaction(async tx=>{await assertNewReleaseAdmission(tx);return tx.documentWorkflowEffect.updateMany({ where: { id, status: 'pending' }, data: { status: 'running', leaseOwner: context.leaseOwner, startedAt: new Date() } });});
  if (!claimed.count) unavailable(await db().documentWorkflowEffect.findUniqueOrThrow({ where: { id } }));
  const controller = new AbortController(); active.set(id, controller);
  const signal = AbortSignal.any([controller.signal, context.signal, AbortSignal.timeout(row.timeoutMs)]);
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return; polling = true;
    void Promise.all([db().workflowRun.findUnique({ where: { id: input.runId }, select: { status: true, leaseOwner: true, cancelRequested: true, leaseExpiresAt: true } }), db().documentWorkflowEffect.findUnique({ where: { id }, select: { status: true } })]).then(([run,effect]) => {
      if (!run || run.status !== 'running' || run.cancelRequested || run.leaseOwner !== context.leaseOwner || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date() || !effect || ['cancelled','unknown','failed'].includes(effect.status)) controller.abort();
    }).catch(() => controller.abort()).finally(() => { polling = false; });
  }, 1000); timer.unref();
  let acknowledged = false;
  let sent = false;
  try {
    signal.throwIfAborted(); await assertWorkflowLease(input.runId);
    sent = true;
    const result = await runReleaseProviderEffect(()=>invoke(row!.request as unknown as I, signal),{kind:'workflow-effect',id:row.id,bookId:row.bookId,revisionId:row.sourceBookRevision,hash:row.sourceContentHash}); acknowledged = true;
    if (Buffer.byteLength(canonicalDocument(result)) > 8 * 1024 * 1024) {
      await db().documentWorkflowEffect.update({ where: { id }, data: { result: json({ sha256: digest(result), retainedResult: false, resultBytes: Buffer.byteLength(canonicalDocument(result)) }), status: 'failed', errorCode: 'WORKFLOW_EFFECT_TOO_LARGE', completedAt: new Date() } });
      throw new DocumentError('WORKFLOW_EFFECT_TOO_LARGE', 'Provider output exceeds its retained byte ceiling.', 413);
    }
    // Store acknowledgement independently of the now possibly lost lease.
    await db().documentWorkflowEffect.update({ where: { id }, data: { result: json({ schemaVersion: 1, providerOutcome: 'completed', data: result, sha256: digest(result) }) } });
    const control = await db().workflowRun.findUnique({ where: { id: input.runId }, select: { status: true, cancelRequested: true } });
    const cancelled = control?.cancelRequested || control?.status === 'cancelled';
    await db().documentWorkflowEffect.updateMany({ where: { id, leaseOwner: context.leaseOwner, status: { in: ['running','unknown'] } }, data: { status: cancelled ? 'cancelled' : 'completed', completedAt: new Date(), errorCode: cancelled ? 'CANCELLED_BY_OWNER' : null } });
    signal.throwIfAborted(); await assertWorkflowLease(input.runId);
    const completed = await db().documentWorkflowEffect.findUniqueOrThrow({ where: { id } });
    if (completed.status !== 'completed') unavailable(completed);
    return result;
  } catch (error) {
    if (!sent||providerWasNotStarted(error)) {
      await db().documentWorkflowEffect.updateMany({ where: { id, status: 'running', leaseOwner: context.leaseOwner }, data: { status: 'pending', startedAt: null, leaseOwner: null, errorCode: 'PROVIDER_NOT_STARTED' } });
      throw error;
    }
    if (error instanceof InferenceTerminalError) {
      acknowledged = true;
      const size = Buffer.byteLength(error.partialOutput);
      await db().documentWorkflowEffect.update({ where: { id }, data: { result: json({ providerOutcome: 'completed', code: error.code, context: error.context, finishReason: error.finishReason, raw: size <= 1024 * 1024 ? error.partialOutput : undefined, partialOutputSha256: createHash('sha256').update(error.partialOutput).digest('hex'), partialOutputBytes: size, retainedPartialOutput: size <= 1024 * 1024 }) } });
    }
    await db().documentWorkflowEffect.updateMany({ where: { id, leaseOwner: context.leaseOwner, status: acknowledged ? { in: ['running','unknown'] } : 'running' }, data: { status: acknowledged ? 'failed' : 'unknown', errorCode: acknowledged ? 'WORKFLOW_PROVIDER_TERMINAL_INVALID' : 'PROVIDER_OUTCOME_UNKNOWN', completedAt: acknowledged ? new Date() : null } });
    throw error instanceof InferenceTerminalError || acknowledged ? error : new DocumentError('WORKFLOW_EFFECT_UNKNOWN', 'Provider outcome is unknown; the workflow must recover this exact effect.', 409, { operationId: id });
  } finally { clearInterval(timer); active.delete(id); }
}

export async function readWorkflowEffect(userId: number, bookId: number, id: string) {
  let row = await db().documentWorkflowEffect.findFirst({ where: { id, userId, bookId } });
  if (!row) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Workflow effect not found.', 404);
  await owned(userId, bookId, row.runId);
  const source = await db().bookDocumentRevision.findFirst({ where: { id: row.sourceBookRevision, bookId }, select: { manifest: true, contentHash: true } });
  if (!source || source.contentHash !== row.sourceContentHash || digest(source.manifest) !== row.sourceContentHash || digest(row.request) !== row.requestHash) throw new DocumentError('WORKFLOW_EFFECT_INVALID', 'Retained source/request checksum is invalid.', 503);
  row = await recoverAcknowledgedEffect(row);
  if (row.status === 'completed') completedResult(row);
  if (row.status === 'running' && row.startedAt && Date.now() - row.startedAt.getTime() > row.timeoutMs + 30000) {
    await db().documentWorkflowEffect.updateMany({ where: { id, status: 'running', startedAt: row.startedAt }, data: { status: 'unknown', errorCode: 'PROVIDER_ACKNOWLEDGEMENT_EXPIRED' } });
    return db().documentWorkflowEffect.findUniqueOrThrow({ where: { id } });
  }
  return row;
}
export async function cancelWorkflowEffect(userId: number, bookId: number, id: string) {
  await readWorkflowEffect(userId, bookId, id);
  const result = await documentService.sideRecord(userId, bookId, async (tx) => {
    const source = await tx.documentWorkflowEffect.findFirstOrThrow({ where: { id, userId, bookId } });
    await tx.documentWorkflowEffect.updateMany({ where: { id, userId, bookId, status: { in: ['pending','running'] } }, data: { status: 'cancelled', errorCode: source.startedAt ? 'OWNER_CANCELLED_PROVIDER_OUTCOME_UNCONFIRMED' : 'OWNER_CANCELLED_BEFORE_PROVIDER', completedAt: new Date() } });
    const row = await tx.documentWorkflowEffect.findUniqueOrThrow({ where: { id } });
    return { id: row.id, status: row.status, errorCode: row.errorCode };
  });
  if (result.status === 'cancelled') active.get(id)?.abort();
  return result;
}
export async function workflowEffectPage(userId: number, bookId: number, id: string, view: 'status' | 'request' | 'result', offset = 0, limit = 16384) {
  const row = await readWorkflowEffect(userId, bookId, id);
  const status = { id: row.id, runId: row.runId, effectKey: row.effectKey, sceneId: row.sceneId, status: row.status, sourceBookRevisionId: row.sourceBookRevision, sourceContentHash: row.sourceContentHash, requestHash: row.requestHash, errorCode: row.errorCode, startedAt: row.startedAt, completedAt: row.completedAt, retainedResult: row.result !== null };
  if (view === 'status') return status;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1024 || limit > 32768) throw new DocumentError('WORKFLOW_EFFECT_PAGE_INVALID', 'Invalid UTF-16 page offset or limit.', 422);
  const text = canonicalDocument(view === 'request' ? row.request : row.result);
  return { ...status, view, offset, totalUtf16: text.length, nextOffset: Math.min(offset + limit,text.length), hasMore: offset + limit < text.length, sha256: createHash('sha256').update(text).digest('hex'), text: text.slice(offset,offset + limit) };
}
export async function listWorkflowEffects(userId: number, bookId: number, runId: string, cursor?: string, limit = 50) {
  await owned(userId, bookId, runId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DocumentError('WORKFLOW_EFFECT_PAGE_INVALID', 'List page limit must be between 1 and 100.', 422);
  const base = cursor ? await db().documentWorkflowEffect.findFirst({ where: { id: cursor, userId, bookId, runId }, select: { id: true, createdAt: true } }) : undefined;
  if (cursor && !base) throw new DocumentError('WORKFLOW_EFFECT_PAGE_INVALID', 'The cursor does not belong to this owned workflow.', 422);
  const rows = await db().documentWorkflowEffect.findMany({ where: { userId, bookId, runId, ...(base ? { OR: [{ createdAt: { lt: base.createdAt } }, { createdAt: base.createdAt, id: { lt: base.id } }] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: { id: true, effectKey: true, sceneId: true, status: true, sourceBookRevision: true, errorCode: true, createdAt: true } });
  const items = rows.slice(0, limit);
  return { items, hasMore: rows.length > limit, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
