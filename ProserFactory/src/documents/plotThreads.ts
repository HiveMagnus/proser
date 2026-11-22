import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, PlotThreadReview } from '@prisma/client';
import { z } from 'zod';
import { databaseService } from '@/lib/database';
import { SceneProseService } from '@/services/sceneProseService';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { assertNewReleaseAdmission, runReleaseProviderEffect, providerWasNotStarted } from '@/operations/releaseAdmission';
import { documentService } from './service';
import { assertStoryBookOwner, storyDigest } from './storyProposalSources';
import { readPassageOwnedContext } from './passageSource';
import { readScope } from './scopes';
import { frozenTarget } from './targets';
import { validateDocument } from './validation';
import { DocumentError } from './errors';
import { plotThreadReviewPrompt } from './plotThreadPrompt';
import { visibleRun, minimalTextEdit, type DocumentManifest } from './model';
import type { DocumentDiscussionSnapshot } from './proposal-model';
import type { PlotThreadRecord, PlotThreadSummary, PlotThreadSource, PlotThreadEvidenceRecord, PlotThreadReviewRecord, PlotThreadReviewSnapshot, PlotThreadCritique } from './plot-thread-model';

type Client = PrismaClient | Prisma.TransactionClient;
const db = () => databaseService.client;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
import { plotThreadMutationSchema, plotThreadEvidenceSchema, plotThreadOperationSchema, plotThreadReviewSchema, plotThreadAssessmentSchema, plotThreadCritiqueSchema } from './plotThreadValidation';
export { plotThreadMutationSchema, plotThreadEvidenceSchema, plotThreadOperationSchema, plotThreadReviewSchema, plotThreadAssessmentSchema } from './plotThreadValidation';

async function head(tx: Client, bookId: number) {
  const current = await tx.bookDocumentHead.findUnique({ where: { bookId } });
  if (!current) throw new DocumentError('DOCUMENT_NOT_MIGRATED', 'Saved document authority is required.', 503);
  const revision = await tx.bookDocumentRevision.findFirst({ where: { bookId, id: current.revisionId } });
  if (!revision || storyDigest(revision.manifest) !== revision.contentHash)
    throw new DocumentError('DOCUMENT_MANIFEST_INVALID', 'Saved manuscript revision is unavailable or corrupt.', 409);
  return { revisionId: revision.id, manifest: revision.manifest as unknown as DocumentManifest };
}
async function thread(tx: Client, bookId: number, threadId: number, expectedVersion?: number) {
  const row = await tx.plotThread.findFirst({ where: { bookId, id: threadId } });
  if (!row) throw new DocumentError('PLOT_THREAD_NOT_FOUND', 'Plot thread not found.', 404);
  if (expectedVersion !== undefined && row.version !== expectedVersion)
    throw new DocumentError('PLOT_THREAD_VERSION_CONFLICT', 'This thread changed. Reload it before saving.', 409);
  return row;
}
async function captureSource(tx: Client, bookId: number, input: z.infer<typeof plotThreadEvidenceSchema>): Promise<PlotThreadSource> {
  const current = await head(tx, bookId);
  const reference = current.manifest.scenes.find(item => item.sceneId === input.sceneId && !item.deletedAt);
  if (current.revisionId !== input.expectedRevisionId || !reference || reference.revisionId !== input.expectedSceneRevisionId || reference.contentHash !== input.expectedContentHash)
    throw new DocumentError('DOCUMENT_SOURCE_STALE', 'The saved excerpt changed. Select it again.', 412);
  const context = await readPassageOwnedContext(tx, bookId, current.revisionId, current.manifest, reference);
  const revision = await tx.sceneDocumentRevision.findFirst({ where: { bookId, sceneId: input.sceneId, id: reference.revisionId } });
  if (!revision || storyDigest(revision.document) !== reference.contentHash)
    throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Saved scene evidence is unavailable or corrupt.', 409);
  const document = validateDocument(revision.document);
  const targets = input.targets.map(target => frozenTarget(document, target));
  if (targets.some(target => !target.editable || !target.sourceText.trim()))
    throw new DocumentError('DOCUMENT_REVIEW_CONFLICT', 'Choose saved text without pending review changes or embedded objects.', 409);
  const structure = await readScope(tx, bookId, 'structure', current.manifest.scopes!.structure);
  const scene = structure.scenes.find(item => item.id === input.sceneId)!;
  const chapter = structure.chapters.find(item => item.id === context.sourceFrame.chapterId)!;
  const act = structure.acts.find(item => item.id === context.sourceFrame.actId)!;
  const paragraphs = document.blocks.flatMap(block => block.type === 'paragraph' ? [block] : block.type === 'table' ? block.rows.flatMap(row => row.cells.flatMap(cell => cell.paragraphs)) : []);
  const positions = targets.map(target => paragraphs.findIndex(p => p.id === target.blockId));
  if (targets.some((target, i) => i > 0 && (positions[i] < positions[i - 1] || (positions[i] === positions[i - 1] && target.from < targets[i - 1].to))))
    throw new DocumentError('PLOT_THREAD_SELECTION_INVALID', 'Excerpt targets must be ordered and non-overlapping.', 422);
  const text = targets.map(target => target.sourceText).join('\n');
  if (Buffer.byteLength(text) > 20000) throw new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'Choose an excerpt of at most 20000 UTF-8 bytes.', 413);
  const anchors = targets.flatMap(target => {
    const paragraph = paragraphs.find(p => p.id === target.blockId)!;
    let offset = 0;
    return paragraph.runs.filter(run => visibleRun(run, document.changes, 'final')).flatMap(run => {
      const start = offset; offset += run.inlineImage ? 1 : run.text.length;
      const from = Math.max(target.from, start), to = Math.min(target.to, offset);
      return to > from ? [{ blockId: paragraph.id, runId: run.id, start: from - start, end: to - start, sourceText: run.text.slice(from - start, to - start) }] : [];
    });
  });
  const source: PlotThreadSource = { frame: context.sourceFrame, targets: targets.map(({ paragraphText: _paragraphText, ...proof }) => proof), anchors, text,
    label: `Act ${act.actNumber} · Chapter ${chapter.chapterNumber} · Scene ${scene.sceneNumber}${chapter.title ? ': ' + chapter.title : ''}`,
    position: [act.actNumber, act.id, chapter.chapterNumber, chapter.id, scene.sceneNumber, scene.id, positions[0], targets[0].from] };
  if (Buffer.byteLength(JSON.stringify(source)) > 64000) throw new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'This excerpt exceeds the supported saved-source size. Choose a shorter saved passage.', 413);
  return source;
}
async function sourceStale(tx: Client, bookId: number, source: PlotThreadSource, current: Awaited<ReturnType<typeof head>>) {
  const reference = current.manifest.scenes.find(item => item.sceneId === source.frame.sceneId && !item.deletedAt);
  if (!reference || reference.revisionId !== source.frame.sceneRevisionId || reference.contentHash !== source.frame.sceneContentHash) return true;
  try {
    const context = await readPassageOwnedContext(tx, bookId, current.revisionId, current.manifest, reference);
    return context.sourceFrame.qualifiedMembershipHash !== source.frame.qualifiedMembershipHash || context.sourceFrame.effectiveStyleLayoutHash !== source.frame.effectiveStyleLayoutHash;
  } catch (error) { if (error instanceof DocumentError) return true; throw error; }
}
export function plotThreadChecks(evidence: PlotThreadEvidenceRecord[]): string[] {
  const live = evidence.filter(item => !item.removedAt);
  const checks = (['setup', 'escalation', 'payoff'] as const).filter(stage => !live.some(item => item.stage === stage)).map(stage => `No ${stage} linked.`);
  if (live.some(item => item.stale)) checks.push('Some linked excerpts changed; select replacement evidence before reviewing.');
  const compare = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const diff = (a[i] ?? 0) - (b[i] ?? 0); if (diff) return diff; } return 0; };
  for (const [earlier, later] of [['setup', 'escalation'], ['escalation', 'payoff'], ['setup', 'payoff']])
    if (live.some(a => a.stage === earlier && live.some(b => b.stage === later && compare(a.source.position, b.source.position) >= 0)))
      checks.push(`Linked ${later} occurs at or before linked ${earlier}; inspect narrative order.`);
  return checks;
}
export function verifyPlotThreadCritique(snapshot: PlotThreadReviewSnapshot, raw: unknown): PlotThreadCritique {
  const output = plotThreadCritiqueSchema.parse(raw);
  for (const finding of output.findings) for (const citation of finding.citations) {
    const evidence = snapshot.evidence.find(item => item.id === citation.evidenceId);
    const text = evidence?.source.text ?? '';
    const boundaries = new Set([text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.index)]);
    let match = text.indexOf(citation.quote), supported = false;
    while (match >= 0) {
      if (boundaries.has(match) && boundaries.has(match + citation.quote.length)) { supported = true; break; }
      match = text.indexOf(citation.quote, match + 1);
    }
    if (!evidence || !supported)
      throw new DocumentError('PLOT_THREAD_CITATION_INVALID', 'Review cites unsupported evidence or changed quotation.', 422);
  }
  if (output.assessment === 'earned' && ['setup', 'escalation', 'payoff'].some(stage => !snapshot.evidence.some(item => item.stage === stage)))
    throw new DocumentError('PLOT_THREAD_REVIEW_INVALID', 'An earned assessment requires linked setup, escalation and payoff.', 422);
  return output;
}
async function evidenceRecords(tx: Client, bookId: number, threadId: number, current: Awaited<ReturnType<typeof head>>) {
  const rows = await tx.plotThreadEvidence.findMany({ where: { bookId, threadId, removedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return Promise.all(rows.map(async row => ({ id: row.id, stage: row.stage as PlotThreadEvidenceRecord['stage'], source: row.source as unknown as PlotThreadSource,
    createdAt: row.createdAt.toISOString(), removedAt: null, stale: await sourceStale(tx, bookId, row.source as unknown as PlotThreadSource, current) })));
}
const active = new Map<string, AbortController>();
async function reviewRecord(tx: PrismaClient, row: PlotThreadReview, threadVersion: number, revisionId: string): Promise<PlotThreadReviewRecord> {
  // The provider result is saved before validation. A crash in that interval
  // must recover the retained bytes, never make another provider request.
  const retained = row.result as unknown as { raw?: string } | null;
  if (['running', 'unknown', 'cancelled'].includes(row.status) && row.startedAt && typeof retained?.raw === 'string') {
    let completed: Prisma.PlotThreadReviewUpdateManyMutationInput;
    try {
      const output = verifyPlotThreadCritique(row.snapshot as unknown as PlotThreadReviewSnapshot, JSON.parse(retained.raw));
      if (Buffer.byteLength(JSON.stringify(output)) > 64000) throw new DocumentError('PLOT_THREAD_RESULT_TOO_LARGE', 'Validated critique exceeds 64000 bytes.', 413);
      completed = { status: 'ready', result: json({ ...retained, output }), errorCode: null, completedAt: new Date() };
    } catch (error) {
      completed = { status: 'failed', errorCode: error instanceof DocumentError ? error.code : 'PLOT_THREAD_REVIEW_INVALID', completedAt: new Date() };
    }
    await tx.$transaction(async record => {
      const changed = await record.plotThreadReview.updateMany({ where: { id: row.id, status: { in: ['running', 'unknown', 'cancelled'] } }, data: completed });
      if (changed.count) await record.auditLog.create({ data: { userId: row.userId, entityType: 'book', entityId: row.bookId, action: 'update', metadata: json({ action: 'recover-plot-thread-review-result', reviewId: row.id, priorStatus: row.status, priorErrorCode: row.errorCode, retainedResultHash: storyDigest(retained), status: completed.status }) } });
    });
    row = await tx.plotThreadReview.findUniqueOrThrow({ where: { id: row.id } });
  }
  // Legacy cancellation after dispatch did not prove that the provider stopped.
  if (row.status === 'cancelled' && row.startedAt) {
    await tx.$transaction(async record => {
      const changed = await record.plotThreadReview.updateMany({ where: { id: row.id, status: 'cancelled' }, data: { status: 'unknown', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' } });
      if (changed.count) await record.auditLog.create({ data: { userId: row.userId, entityType: 'book', entityId: row.bookId, action: 'update', metadata: json({ action: 'plot-thread-dispatched-cancellation-uncertain', reviewId: row.id, priorStatus: row.status, priorErrorCode: row.errorCode, priorCompletedAt: row.completedAt }) } });
    });
    row = await tx.plotThreadReview.findUniqueOrThrow({ where: { id: row.id } });
  }
  // A process loss or expired call is uncertain, never permission to call again.
  if (row.status === 'running' && row.startedAt && Date.now() - row.startedAt.getTime() > 180000 && !active.has(row.id)) {
    await tx.plotThreadReview.updateMany({ where: { id: row.id, status: 'running' }, data: { status: 'unknown', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' } });
    row = await tx.plotThreadReview.findUniqueOrThrow({ where: { id: row.id } });
  }
  const snapshot = row.snapshot as unknown as PlotThreadReviewSnapshot;
  const result = row.result as PlotThreadReviewRecord['result'];
  return { id: row.id, status: row.status as PlotThreadReviewRecord['status'], snapshot, result: result ? { provenance: result.provenance, output: result.output } : null,
    errorCode: row.errorCode, assessment: row.assessment as PlotThreadReviewRecord['assessment'], notes: row.notes, createdAt: row.createdAt.toISOString(),
    stale: snapshot.threadVersion !== threadVersion || snapshot.bookRevisionId !== revisionId };
}
export async function readPlotThread(userId: number, bookId: number, threadId: number): Promise<PlotThreadRecord> {
  await assertStoryBookOwner(db(), userId, bookId);
  const row = await thread(db(), bookId, threadId), current = await head(db(), bookId);
  const evidence = await evidenceRecords(db(), bookId, threadId, current);
  const reviews = await db().plotThreadReview.findMany({ where: { bookId, threadId, userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 });
  return { id: row.id, bookId, threadKey: row.threadKey, question: row.question, description: row.description, notes: row.notes,
    status: row.status as PlotThreadRecord['status'], version: row.version, authorManaged: row.authorManaged, archivedAt: row.archivedAt?.toISOString() ?? null,
    evidence, checks: plotThreadChecks(evidence), reviews: await Promise.all(reviews.map(review => reviewRecord(db(), review, row.version, current.revisionId))) };
}
export async function listPlotThreads(userId: number, bookId: number, archived: boolean, after?: number) {
  await assertStoryBookOwner(db(), userId, bookId);
  const rows = await db().plotThread.findMany({ where: { bookId, archivedAt: archived ? { not: null } : null, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 51 });
  const current = await head(db(), bookId);
  const threads = await Promise.all(rows.slice(0, 50).map(async row => {
    const evidence = await evidenceRecords(db(), bookId, row.id, current);
    return { id: row.id, bookId, threadKey: row.threadKey, question: row.question, description: row.description, notes: row.notes,
      status: row.status as PlotThreadRecord['status'], version: row.version, authorManaged: row.authorManaged, archivedAt: row.archivedAt?.toISOString() ?? null,
      checks: plotThreadChecks(evidence), coverage: { setup: evidence.filter(e => e.stage === 'setup').length, escalation: evidence.filter(e => e.stage === 'escalation').length, payoff: evidence.filter(e => e.stage === 'payoff').length } } satisfies PlotThreadSummary;
  }));
  return { threads, next: rows.length > 50 ? rows[49].id : null };
}
export async function readPlotThreadMutation(userId: number, bookId: number, operationId: string) {
  await assertStoryBookOwner(db(), userId, bookId);
  const row = await db().plotThreadMutation.findFirst({ where: { id: operationId, bookId, userId } });
  if (!row) throw new DocumentError('PLOT_THREAD_OPERATION_NOT_FOUND', 'No saved receipt for this operation.', 404);
  return row.receipt;
}
async function mutate(userId: number, bookId: number, operationId: string, payload: unknown, action: (tx: Prisma.TransactionClient) => Promise<Record<string, unknown>>) {
  const requestHash = storyDigest({ userId, bookId, payload });
  return documentService.sideRecord(userId, bookId, async tx => {
    const prior = await tx.plotThreadMutation.findUnique({ where: { id: operationId } });
    if (prior) {
      if (prior.userId !== userId || prior.bookId !== bookId || prior.requestHash !== requestHash)
        throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Operation ID belongs to a different request.', 409);
      return prior.receipt;
    }
    const receipt = { operationId, ...await action(tx) };
    await tx.plotThreadMutation.create({ data: { id: operationId, bookId, userId, requestHash, receipt: json(receipt) } });
    await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: json({ action: 'plot-thread-mutation', requestHash, receipt }) } });
    return receipt;
  });
}
export async function savePlotThread(userId: number, bookId: number, threadId: number | undefined, raw: unknown) {
  const input = plotThreadMutationSchema.parse(raw);
  return mutate(userId, bookId, input.operationId, { threadId, input }, async tx => {
    if (threadId === undefined && (!input.question || input.expectedVersion !== 0)) throw new DocumentError('PLOT_THREAD_QUESTION_REQUIRED', 'A new thread requires a story question and version zero.', 422);
    const current = threadId !== undefined ? await thread(tx, bookId, threadId, input.expectedVersion) : undefined;
    const fields = { question: input.question, description: input.description, notes: input.notes, status: input.status,
      authorManaged: true, ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}) };
    const changed = current && (!current.authorManaged || (input.question !== undefined && input.question !== current.question) || (input.description !== undefined && input.description !== current.description) || (input.notes !== undefined && input.notes !== current.notes) || (input.status !== undefined && input.status !== current.status) || (input.archived !== undefined && input.archived !== Boolean(current.archivedAt)));
    const row = threadId === undefined ? await tx.plotThread.create({ data: { ...fields, bookId, threadKey: `author-${randomUUID()}`, version: 1 } }) : changed ? await tx.plotThread.update({ where: { id: threadId }, data: { ...fields, version: { increment: 1 } } }) : current!;
    return { threadId: row.id, version: row.version };
  });
}
export async function addPlotThreadEvidence(userId: number, bookId: number, threadId: number, raw: unknown) {
  const input = plotThreadEvidenceSchema.parse(raw);
  return mutate(userId, bookId, input.operationId, { threadId, input }, async tx => {
    const row = await thread(tx, bookId, threadId, input.expectedVersion);
    if (row.archivedAt) throw new DocumentError('PLOT_THREAD_ARCHIVED', 'Restore this thread before adding evidence.', 409);
    if (await tx.plotThreadEvidence.count({ where: { bookId, threadId, removedAt: null } }) >= 24 && !input.replacesEvidenceId) throw new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'A thread supports 24 active excerpts. Replace or remove an excerpt first.', 413);
    const source = await captureSource(tx, bookId, input);
    if (input.replacesEvidenceId) {
      const removed = await tx.plotThreadEvidence.updateMany({ where: { id: input.replacesEvidenceId, bookId, threadId, removedAt: null }, data: { removedAt: new Date() } });
      if (!removed.count) throw new DocumentError('PLOT_THREAD_EVIDENCE_NOT_FOUND', 'Replacement evidence not found.', 404);
    }
    const evidence = await tx.plotThreadEvidence.create({ data: { id: randomUUID(), bookId, threadId, stage: input.stage, source: json(source) } });
    const updated = await tx.plotThread.update({ where: { id: threadId }, data: { authorManaged: true, version: { increment: 1 } } });
    return { threadId, version: updated.version, evidenceId: evidence.id };
  });
}
export async function removePlotThreadEvidence(userId: number, bookId: number, threadId: number, evidenceId: string, raw: unknown) {
  const input = plotThreadOperationSchema.parse(raw);
  return mutate(userId, bookId, input.operationId, { threadId, evidenceId, input }, async tx => {
    await thread(tx, bookId, threadId, input.expectedVersion);
    const removed = await tx.plotThreadEvidence.updateMany({ where: { id: evidenceId, bookId, threadId, removedAt: null }, data: { removedAt: new Date() } });
    if (!removed.count) throw new DocumentError('PLOT_THREAD_EVIDENCE_NOT_FOUND', 'Evidence not found.', 404);
    const updated = await tx.plotThread.update({ where: { id: threadId }, data: { authorManaged: true, version: { increment: 1 } } });
    return { threadId, version: updated.version, evidenceId };
  });
}
export async function readPlotThreadReview(userId: number, bookId: number, threadId: number, reviewId: string) {
  await assertStoryBookOwner(db(), userId, bookId);
  const t = await thread(db(), bookId, threadId), current = await head(db(), bookId);
  const row = await db().plotThreadReview.findFirst({ where: { id: reviewId, bookId, threadId, userId } });
  if (!row) throw new DocumentError('PLOT_THREAD_REVIEW_NOT_FOUND', 'Review not found.', 404);
  return reviewRecord(db(), row, t.version, current.revisionId);
}
export async function requestPlotThreadReview(userId: number, bookId: number, threadId: number, raw: unknown) {
  const input = plotThreadReviewSchema.parse(raw), requestHash = storyDigest({ userId, bookId, threadId, input });
  const row = await documentService.sideRecord(userId, bookId, async tx => {
    const prior = await tx.plotThreadReview.findUnique({ where: { id: input.operationId } });
    if (prior) {
      if (prior.userId !== userId || prior.bookId !== bookId || prior.threadId !== threadId || prior.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Review operation ID was reused.', 409);
      return prior;
    }
    const t = await thread(tx, bookId, threadId, input.expectedVersion), current = await head(tx, bookId);
    if (t.archivedAt || current.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Thread or manuscript changed before review.', 412);
    const evidence = await evidenceRecords(tx, bookId, threadId, current);
    if (!evidence.length || evidence.some(item => item.stale)) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Link current saved excerpts before reviewing.', 412);
    const snapshot: PlotThreadReviewSnapshot = { schemaVersion: 1, bookRevisionId: current.revisionId, threadId, threadVersion: t.version,
      question: t.question ?? t.description ?? t.threadKey, description: t.description, notes: t.notes, evidence, checks: plotThreadChecks(evidence) };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 64000) throw new DocumentError('DOCUMENT_CONTEXT_TOO_LARGE', 'Complete review context exceeds the configured byte budget. Link smaller excerpts.', 413);
    plotThreadReviewPrompt(snapshot);
    const unresolved = await tx.plotThreadReview.findMany({ where: { bookId, threadId, userId, OR: [{ status: { in: ['pending','running','unknown'] } }, { status: 'cancelled', startedAt: { not: null } }] } });
    if (unresolved.some(item => storyDigest(item.snapshot) === storyDigest(snapshot))) throw new DocumentError('PLOT_THREAD_REVIEW_UNRESOLVED', 'Recover the original review before requesting this source again.', 409);
    return tx.plotThreadReview.create({ data: { id: input.operationId, userId, bookId, threadId, requestHash, request: json(input), snapshot: json(snapshot) } });
  });
  if (row.status !== 'pending') return readPlotThreadReview(userId, bookId, threadId, row.id);
  let claimed: { count: number };
  try { claimed = await documentService.sideRecord(userId, bookId, async tx => {
    await assertNewReleaseAdmission(tx);
    const t = await thread(tx, bookId, threadId, input.expectedVersion), current = await head(tx, bookId);
    if (t.archivedAt || current.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Review source changed before dispatch.', 412);
    return tx.plotThreadReview.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'running', startedAt: new Date() } });
  }); } catch (error) {
    // Failed admission/source checks occur before dispatch. Retain a terminal
    // receipt so a saved pending request can be recovered after source changes.
    await db().$transaction(async record => {
      const changed = await record.plotThreadReview.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'failed', errorCode: error instanceof DocumentError ? error.code : 'PROVIDER_NOT_STARTED', completedAt: new Date() } });
      if (changed.count) await record.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: json({ action: 'plot-thread-review-not-dispatched', reviewId: row.id, requestHash, errorCode: error instanceof DocumentError ? error.code : 'PROVIDER_NOT_STARTED' }) } });
    });
    return readPlotThreadReview(userId, bookId, threadId, row.id);
  }
  if (!claimed.count) return readPlotThreadReview(userId, bookId, threadId, row.id);
  const controller = new AbortController(); active.set(row.id, controller);
  const callerSignal = currentDocumentMutationContext()?.signal();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let acknowledged = false;
  try {
    const result = await runReleaseProviderEffect(() => SceneProseService.getInstance().reviewPlotThread(row.snapshot as unknown as PlotThreadReviewSnapshot, { selectedModel: input.selectedModel, signal }),
      { kind: 'plot-thread-review', id: row.id, bookId, revisionId: input.expectedRevisionId, hash: storyDigest(row.snapshot) });
    acknowledged = true;
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new DocumentError('PLOT_THREAD_RESULT_TOO_LARGE', 'Review result exceeds 1 MiB.', 413);
    await db().plotThreadReview.update({ where: { id: row.id }, data: { result: json(result) } });
    const output = verifyPlotThreadCritique(row.snapshot as unknown as PlotThreadReviewSnapshot, JSON.parse(result.raw));
    if (Buffer.byteLength(JSON.stringify(output)) > 64000) throw new DocumentError('PLOT_THREAD_RESULT_TOO_LARGE', 'Validated critique exceeds 64000 bytes.', 413);
    await db().plotThreadReview.updateMany({ where: { id: row.id, status: { in: ['running', 'unknown'] } }, data: { status: 'ready', result: json({ ...result, output }), errorCode: null, completedAt: new Date() } });
  } catch (error) {
    const invalidResult = acknowledged && (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof DocumentError);
    await db().plotThreadReview.updateMany({ where: { id: row.id, status: { in: ['running', 'unknown'] } }, data: { status: invalidResult || providerWasNotStarted(error) ? 'failed' : 'unknown',
      errorCode: error instanceof DocumentError ? error.code : invalidResult ? 'PLOT_THREAD_REVIEW_INVALID' : 'PROVIDER_OUTCOME_UNKNOWN', completedAt: new Date() } });
  } finally { active.delete(row.id); }
  return readPlotThreadReview(userId, bookId, threadId, row.id);
}
export async function cancelPlotThreadReview(userId: number, bookId: number, threadId: number, reviewId: string) {
  await documentService.sideRecord(userId, bookId, async tx => {
    const row = await tx.plotThreadReview.findFirst({ where: { id: reviewId, bookId, userId, threadId } });
    if (!row) throw new DocumentError('PLOT_THREAD_REVIEW_NOT_FOUND', 'Review not found.', 404);
    await tx.plotThreadReview.updateMany({ where: { id: reviewId, status: 'pending' }, data: { status: 'cancelled', completedAt: new Date() } });
    await tx.plotThreadReview.updateMany({ where: { id: reviewId, status: 'running' }, data: { status: 'unknown', errorCode: 'PROVIDER_OUTCOME_UNKNOWN', completedAt: new Date() } });
    if (['pending', 'running'].includes(row.status)) await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: json({ action: 'cancel-plot-thread-review', reviewId, priorStatus: row.status, priorErrorCode: row.errorCode, outcome: row.status === 'pending' ? 'cancelled-before-dispatch' : 'unknown-after-dispatch' }) } });
  });
  active.get(reviewId)?.abort();
  return readPlotThreadReview(userId, bookId, threadId, reviewId);
}
export async function assessPlotThreadReview(userId: number, bookId: number, threadId: number, reviewId: string, raw: unknown) {
  const input = plotThreadAssessmentSchema.parse(raw);
  return mutate(userId, bookId, input.operationId, { threadId, reviewId, input }, async tx => {
    await thread(tx, bookId, threadId, input.expectedVersion);
    const row = await tx.plotThreadReview.findFirst({ where: { id: reviewId, bookId, threadId, userId, status: 'ready' } });
    if (!row) throw new DocumentError('PLOT_THREAD_REVIEW_NOT_FOUND', 'Completed review not found.', 404);
    await tx.plotThreadReview.update({ where: { id: reviewId }, data: { assessment: input.assessment, notes: input.notes } });
    return { threadId, reviewId, version: input.expectedVersion };
  });
}
/** An existing proposal receives only server-verified review context and target identities. */
export async function plotThreadProposalContext(tx: Client, userId: number, bookId: number, reviewId: string, evidenceId: string, sceneId: number, targets: DocumentDiscussionSnapshot['targets']) {
  const row = await tx.plotThreadReview.findFirst({ where: { id: reviewId, bookId, userId, status: 'ready' } });
  if (!row) throw new DocumentError('PLOT_THREAD_REVIEW_NOT_FOUND', 'Completed thread review not found.', 404);
  const snapshot = row.snapshot as unknown as PlotThreadReviewSnapshot;
  const t = await thread(tx, bookId, row.threadId, snapshot.threadVersion), current = await head(tx, bookId);
  if (t.archivedAt || snapshot.bookRevisionId !== current.revisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Refresh the thread review before proposing a revision.', 412);
  const evidence = snapshot.evidence.find(item => item.id === evidenceId);
  if (!evidence || evidence.source.frame.sceneId !== sceneId || targets.length !== evidence.source.targets.length || targets.some((target, index) => {
    const expected = evidence.source.targets[index]; return target.blockId !== expected.blockId || target.from !== expected.from || target.to !== expected.to || target.sourceText !== expected.sourceText;
  })) throw new DocumentError('PLOT_THREAD_EVIDENCE_INVALID', 'Proposal must target the exact cited excerpt.', 422);
  const saved = await tx.sceneDocumentRevision.findFirstOrThrow({ where: { bookId, sceneId, id: evidence.source.frame.sceneRevisionId } });
  const document = validateDocument(saved.document);
  for (const expected of evidence.source.targets) {
    const { paragraphText: _paragraphText, ...proof } = frozenTarget(document, expected, expected.targetId);
    if (storyDigest(proof) !== storyDigest(expected)) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Linked evidence proof changed.', 409);
  }
  return { reviewId, evidenceId, snapshot, critique: (row.result as unknown as { output: PlotThreadCritique }).output };
}
export async function assertPlotThreadProposalCurrent(userId: number, bookId: number, context: NonNullable<DocumentDiscussionSnapshot['plotThread']>) {
  const current = await head(db(), bookId);
  const t = await thread(db(), bookId, context.snapshot.threadId);
  if (t.archivedAt || t.version !== context.snapshot.threadVersion || current.revisionId !== context.snapshot.bookRevisionId)
    throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Thread review changed. Prepare a new review and proposal.', 412);
}

export function verifyPlotThreadProposalOutput(snapshot: DocumentDiscussionSnapshot, output: import('./proposal-model').DocumentProposalOutput) {
  if (!snapshot.plotThread) return;
  let changed = 0;
  for (const edit of output.edits) {
    const diff = minimalTextEdit(edit.sourceText, edit.replacement);
    if (diff.end === diff.start && !diff.replacement.length)
      throw new DocumentError('PLOT_THREAD_PROPOSAL_NO_CHANGE', 'The proposed edit leaves the passage unchanged. Request another small revision.', 422);
    changed += diff.end - diff.start + diff.replacement.length;
  }
  if (!output.edits.length || changed > 600) throw new DocumentError('PLOT_THREAD_PROPOSAL_TOO_LARGE', 'A thread proposal requires a small edit of at most 600 changed characters in total.', 422);
}
