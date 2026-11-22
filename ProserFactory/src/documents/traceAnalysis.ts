import {assertNewReleaseAdmission,runReleaseProviderEffect,providerWasNotStarted} from '@/operations/releaseAdmission';
import {verifySceneTargetContext} from './sceneTargetContext';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { verifyCandidate } from '@/services/editorial/editorialVerificationService';
import { textHash } from '@/services/editorial/textAnchors';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import type { LiveProseJudgePayload } from '@/queues/liveProseJudgeQueue';
import type { ProseJudgeResult } from '@/services/proseTraceService';
import { documentService, type CatalogReceipt } from './service';
import { DocumentError } from './errors';
import { canonicalDocument, projectDocument, paragraphsOf, visibleParagraph, minimalTextEdit, replaceDocumentText, type ProserDocument } from './model';
import { validateDocument } from './validation';
import { frozenTarget, paragraphText } from './targets';
import { documentFeedbackSchema, documentCompareRevalidateSchema, documentCompareSchema } from './traceValidation';
import type { FrozenDocumentTarget, DocumentTraceSnapshot, DocumentFeedbackTarget, DocumentFeedbackOutput, DocumentCompareRequest, DocumentTraceReview } from './proposal-model';

const db = () => databaseService.client;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
const active = new Map<string, AbortController>();
async function owned(userId: number, bookId: number) {
  if (currentDocumentMutationContext()?.userId !== undefined && currentDocumentMutationContext()!.userId !== userId || !await db().book.findFirst({ where: { id: bookId, userId, deletedAt: {} }, select: { id: true } })) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
}
/** A trusted generation receipt supplies the immutable saved revision. Never
 * infer source identity from current text, timestamps or matching quotations. */
export async function bindGeneratedTrace(userId: number, bookId: number, sceneId: number, traceId: string, operationId: string, workflowEffectId?: string, transaction?: Prisma.TransactionClient) {
  await owned(userId, bookId);
  const bind = async (tx: Prisma.TransactionClient) => {
    const prior = await tx.documentTraceAnalysis.findUnique({ where: { traceId } });
    if (prior) { if (prior.userId !== userId || prior.bookId !== bookId || prior.sceneId !== sceneId || (prior.snapshot as unknown as DocumentTraceSnapshot).generationOperationId !== operationId) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Trace source belongs to another scope.', 409); return prior; }
    const operation = await tx.documentOperation.findFirst({ where: { id: operationId, userId, bookId } });
    const trace = await tx.proseTrace.findFirst({ where: { traceId, userId, bookId, sceneId }, include: { candidates: { orderBy: { ordinal: 'asc' } } } });
    if (!operation || !trace) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'Committed generation and its trace are required.', 409);
    const receipt = operation.receipt as unknown as CatalogReceipt;
    const reference = receipt.kind === 'catalog' ? receipt.manifest.scenes.find((scene) => scene.sceneId === sceneId) : undefined;
    if (!reference) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'The operation does not reference this saved scene.', 409);
    const revision = await tx.sceneDocumentRevision.findFirst({ where: { id: reference.revisionId, bookId, sceneId } });
    const bookRevision = await tx.bookDocumentRevision.findFirst({ where: { id: receipt.revisionId, bookId } });
    const inference = workflowEffectId ? undefined : await tx.documentInferenceOperation.findFirst({ where: { id: operationId, bookId, userId, sceneId, status: 'completed' } });
    const effect = workflowEffectId ? await tx.documentWorkflowEffect.findFirst({ where: { id: workflowEffectId, bookId, userId, sceneId, status: 'completed' } }) : undefined;
    if (!revision || !bookRevision || (!inference && !effect) || digest(bookRevision.manifest) !== bookRevision.contentHash) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'Immutable generation evidence is unavailable.', 409);
    const document = validateDocument(revision.document);
    const retained = effect?.result as unknown as { schemaVersion: number; data: { traceId?: string; prose?: string }; sha256: string } | undefined;
    if (effect && (!retained || retained.schemaVersion !== 1 || digest(effect.request) !== effect.requestHash || digest(retained.data) !== retained.sha256 || (receipt.result as { workflowRunId?: string; workflowEffectId?: string }).workflowRunId !== effect.runId || (receipt.result as { workflowEffectId?: string }).workflowEffectId !== effect.id)) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'Workflow selection does not bind this immutable provider receipt.', 409);
    const generation = effect ? retained!.data : inference!.result as unknown as { traceId?: string; prose?: string };
    const final = trace.candidates.find((candidate) => candidate.stage === 'final');
    if (generation.traceId !== traceId || revision.contentHash !== reference.contentHash || digest(document) !== reference.contentHash || generation.prose !== projectDocument(document).text || final?.outputText !== generation.prose) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'Generated candidate does not match the committed structured projection.', 409);
    const manifest = receipt.manifest;
    if (!manifest.scopes) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'Saved layout provenance is missing.', 409);
    const capacity = Number(process.env.DOCUMENT_AI_CONTEXT_TOKENS ?? 32768);
    if (!Number.isSafeInteger(capacity) || capacity < 8192 || capacity > 150000) throw new DocumentError('DOCUMENT_CONTEXT_CONFIGURATION_INVALID', 'Configure a supported document inference context limit.', 503);
    const snapshot: DocumentTraceSnapshot = { schemaVersion: 1, projection: 'final', generationOperationId: operationId, bookRevisionId: receipt.revisionId, sceneRevisionId: revision.id, contentHash: revision.contentHash, bookLayoutHash: manifest.scopes.layout.contentHash, maxPromptBytes: Math.min(100000, capacity - 6144), targets: paragraphsOf(document).filter((paragraph) => visibleParagraph(paragraph, document.changes, 'final')).map((paragraph) => { const text = paragraphText(paragraph, document); return frozenTarget(document, { blockId: paragraph.id, from: 0, to: text.length, sourceText: text }); }) };
    const context = trace.promptContextJson ? JSON.parse(trace.promptContextJson) as Record<string, unknown> : {};
    const payload: LiveProseJudgePayload = { traceId, externalRef: `document:${receipt.revisionId}:scene:${sceneId}`, taskFamily: 'prose', traceType: 'scene-prose', bookId, sceneId, chapterId: trace.chapterId ?? undefined, genreKey: trace.genreKey as LiveProseJudgePayload['genreKey'], recipeVersion: trace.recipeVersion ?? '1.0.0', model: trace.modelUsed ?? undefined, promptContext: { ...context, savedDocument: { bookRevisionId: receipt.revisionId, sceneRevisionId: revision.id, contentHash: revision.contentHash } }, candidates: trace.candidates.map((candidate) => ({ ordinal: candidate.ordinal, stage: candidate.stage as 'draft' | 'final', candidateType: candidate.candidateType as LiveProseJudgePayload['candidates'][number]['candidateType'], outputText: candidate.outputText, wordCount: candidate.wordCount })) };
    return tx.documentTraceAnalysis.create({ data: { id: randomUUID(), traceId, userId, bookId, sceneId, sourceBookRevision: receipt.revisionId, sourceSceneRevision: revision.id, sourceContentHash: revision.contentHash, snapshot: json(snapshot), payload: json(payload) } });
  };
  return transaction ? bind(transaction) : documentService.sideRecord(userId, bookId, bind);
}
function targetFromOutput(document: ProserDocument, snapshot: DocumentTraceSnapshot, input?: DocumentFeedbackTarget) {
  if (!input) return { reason: 'NO_TARGET_SUPPLIED' };
  const supplied = snapshot.targets.find((target) => target.targetId === input.targetId);
  if (!supplied) return { reason: 'TARGET_ID_NOT_SUPPLIED' };
  try { return { target: frozenTarget(document, { blockId: supplied.blockId, from: input.from, to: input.to, sourceText: input.sourceText }, supplied.targetId) }; }
  catch { return { reason: 'SOURCE_SPAN_OR_GRAPHEME_MISMATCH' }; }
}
function currentTarget(document: ProserDocument, target: FrozenDocumentTarget) {
  const current = frozenTarget(document, target, target.targetId);
  // Resolving a prior insertion is a separate human action. Explicit revalidation
  // may allow that eligibility change only when every text/style/object identity matches.
  const proof = (value: FrozenDocumentTarget) => { const { editable: _editable, ...rest } = value; return rest; };
  if (canonicalDocument(proof(current)) !== canonicalDocument(proof(target))) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Text, formatting, protected objects or container identity changed.', 409);
  return current;
}
export async function analyzeBoundTrace(traceId: string, judge: ProseJudgeResult) {
  const row = await db().documentTraceAnalysis.findUnique({ where: { traceId } });
  if (!row) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'The trace has no saved structured source.', 409);
  if (row.status === 'completed') return;
  if (row.status !== 'pending') throw new DocumentError('DOCUMENT_ANALYSIS_UNAVAILABLE', 'Recover the retained analysis; its provider effect cannot be repeated.', 409, { operationId: row.id, status: row.status });
  await owned(row.userId, row.bookId);
  if (!await db().book.findFirst({ where: { id: row.bookId, userId: row.userId, deletedAt: null } })) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book is archived.', 404);
  const claimed = await db().$transaction(async tx=>{await assertNewReleaseAdmission(tx);return tx.documentTraceAnalysis.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'running', startedAt: new Date() } });});
  if (!claimed.count) throw new DocumentError('DOCUMENT_ANALYSIS_UNAVAILABLE', 'Analysis is already claimed.', 409);
  const controller = new AbortController(); active.set(row.id, controller);
  let polling = false;
  const timer = setInterval(() => { if (polling) return; polling = true; void db().documentTraceAnalysis.findUnique({ where: { id: row!.id }, select: { status: true } }).then((value) => { if (value?.status !== 'running') controller.abort(); }).catch(() => controller.abort()).finally(() => { polling = false; }); }, 1000); timer.unref();
  let acknowledged = false;
  try {
    // Keep inference initialization out of legacy trace reads and break the
    // SceneProseService → ProseTraceService → analysis import cycle.
    const { SceneProseService } = await import('@/services/sceneProseService');
    const snapshot = row.snapshot as unknown as DocumentTraceSnapshot;
    const response = await runReleaseProviderEffect(()=>SceneProseService.getInstance().analyzeDocument(snapshot, judge, { signal: controller.signal, selectedModel: (row.payload as unknown as LiveProseJudgePayload).model, retries: 1 }),{kind:'document-analysis',id:row.id,bookId:row.bookId,revisionId:row.sourceSceneRevision,hash:row.sourceContentHash});
    acknowledged = true;
    const responseBytes = JSON.stringify(response);
    if (Buffer.byteLength(responseBytes) > 2 * 1024 * 1024) {
      await db().documentTraceAnalysis.update({ where: { id: row.id }, data: { result: json({ providerOutcome: 'completed', sha256: createHash('sha256').update(responseBytes).digest('hex'), size: Buffer.byteLength(responseBytes), retainedRawOutput: false, provenance: response.provenance }) } });
      throw new DocumentError('DOCUMENT_ANALYSIS_TOO_LARGE', 'Analysis result exceeds 2 MiB.', 413);
    }
    await db().documentTraceAnalysis.update({ where: { id: row.id }, data: { result: json(response) } });
    const output: DocumentFeedbackOutput = documentFeedbackSchema.parse(JSON.parse(response.raw));
    const revision = await db().sceneDocumentRevision.findFirstOrThrow({ where: { id: row.sourceSceneRevision, bookId: row.bookId, sceneId: row.sceneId } });
    const document = validateDocument(revision.document);
    if (digest(document) !== row.sourceContentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Analysis source checksum changed.', 503);
    await documentService.sideRecord(row.userId, row.bookId, async (tx) => {
      const current = await tx.documentTraceAnalysis.findUniqueOrThrow({ where: { id: row!.id } });
      if (current.status !== 'running' || controller.signal.aborted) throw new DocumentError('DOCUMENT_ANALYSIS_UNAVAILABLE', 'Analysis was cancelled or superseded.', 409);
      const trace = await tx.proseTrace.findFirstOrThrow({ where: { traceId, bookId: row!.bookId, userId: row!.userId, sceneId: row!.sceneId } });
      for (const finding of output.findings) {
        const binding = targetFromOutput(document, snapshot, finding.target);
        const item = await tx.proseFinding.create({ data: { proseTraceId: trace.id, source: 'document_analysis', findingType: finding.findingType, severity: finding.severity, title: finding.title, message: finding.message, suggestion: finding.suggestion, rationale: finding.rationale, excerpt: binding.target?.sourceText, metadataJson: JSON.stringify({ analysisId: row!.id }) } });
        await tx.documentTraceTarget.create({ data: { id: randomUUID(), analysisId: row!.id, userId: row!.userId, bookId: row!.bookId, sceneId: row!.sceneId, traceId, findingId: item.id, ...(binding.target ? { target: json(binding.target) } : { reason: binding.reason }) } });
      }
      for (const card of output.compareCards) {
        const binding = targetFromOutput(document, snapshot, card.target);
        const item = await tx.proseCompareCard.create({ data: { proseTraceId: trace.id, title: card.title, message: card.message, optionALabel: card.optionALabel, optionAText: card.optionAText, optionBLabel: card.optionBLabel, optionBText: card.optionBText, recommendedOption: card.recommendedOption, rationale: card.rationale, excerpt: binding.target?.sourceText, metadataJson: JSON.stringify({ analysisId: row!.id }) } });
        await tx.documentTraceTarget.create({ data: { id: randomUUID(), analysisId: row!.id, userId: row!.userId, bookId: row!.bookId, sceneId: row!.sceneId, traceId, compareCardId: item.id, ...(binding.target ? { target: json(binding.target) } : { reason: binding.reason }) } });
      }
      await tx.documentTraceAnalysis.update({ where: { id: row!.id }, data: { status: 'completed', result: json({ ...response, output, judge }), completedAt: new Date() } });
      await tx.proseTrace.update({ where: { id: trace.id }, data: { status: 'ready', judgeStatus: 'completed', judgeSummaryJson: JSON.stringify(output.judgeSummary), errorMessage: null } });
    });
  } catch (error) {
    if(providerWasNotStarted(error)){await db().documentTraceAnalysis.updateMany({where:{id:row.id,status:'running'},data:{status:'pending',startedAt:null,errorCode:'PROVIDER_NOT_STARTED'}});throw error;}
    const known = error instanceof InferenceTerminalError || acknowledged || error instanceof DocumentError && error.code === 'DOCUMENT_CONTEXT_TOO_LARGE';
    await db().documentTraceAnalysis.updateMany({ where: { id: row.id, status: 'running' }, data: { status: known ? 'failed' : 'unknown', errorCode: error instanceof DocumentError ? error.code : known ? 'DOCUMENT_ANALYSIS_INVALID' : 'PROVIDER_OUTCOME_UNKNOWN', completedAt: known ? new Date() : undefined,
      ...(error instanceof InferenceTerminalError ? { result: json({ raw: Buffer.byteLength(error.partialOutput) <= 1024 * 1024 ? error.partialOutput : undefined, partialOutputSha256: createHash('sha256').update(error.partialOutput).digest('hex'), partialOutputBytes: Buffer.byteLength(error.partialOutput), retainedPartialOutput: Buffer.byteLength(error.partialOutput) <= 1024 * 1024, finishReason: error.finishReason }) } : {}) } });
    throw error;
  } finally { clearInterval(timer); active.delete(row.id); }
}
export async function readTraceAnalysis(userId: number, bookId: number, id: string) {
  await owned(userId, bookId);
  let row = await db().documentTraceAnalysis.findFirst({ where: { id, bookId, userId } });
  if (!row) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Analysis not found.', 404);
  if (row.status === 'running' && row.startedAt && Date.now() - row.startedAt.getTime() > 150000) { await db().documentTraceAnalysis.updateMany({ where: { id, status: 'running', startedAt: row.startedAt }, data: { status: 'unknown', errorCode: 'PROVIDER_ACKNOWLEDGEMENT_EXPIRED' } }); row = await db().documentTraceAnalysis.findUniqueOrThrow({ where: { id } }); }
  return row;
}
export async function cancelTraceAnalysis(userId: number, bookId: number, id: string) {
  await readTraceAnalysis(userId, bookId, id);
  const row = await documentService.sideRecord(userId, bookId, async (tx) => {
    await tx.documentTraceAnalysis.updateMany({ where: { id, userId, bookId, status: { in: ['pending','running'] } }, data: { status: 'cancelled', errorCode: 'CANCELLED_BY_OWNER', completedAt: new Date() } });
    return tx.documentTraceAnalysis.findUniqueOrThrow({ where: { id } });
  });
  if (row.status === 'cancelled') active.get(id)?.abort();
  return row;
}

async function boundCard(tx: Prisma.TransactionClient, userId: number, bookId: number, traceId: string, cardId: number, sceneId?: number) {
  const trace = await tx.proseTrace.findFirst({ where: { traceId, userId, bookId, ...(sceneId ? { sceneId } : {}) } });
  const card = trace ? await tx.proseCompareCard.findFirst({ where: { id: cardId, proseTraceId: trace.id } }) : null;
  if (!trace?.sceneId || !card) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Compare target not found.', 404);
  const binding = await tx.documentTraceTarget.findFirst({ where: { compareCardId: cardId, traceId, userId, bookId, sceneId: trace.sceneId! } });
  const analysis = binding ? await tx.documentTraceAnalysis.findFirst({ where: { id: binding.analysisId, traceId, userId, bookId, status: 'completed' } }) : null;
  return { trace, card, binding, analysis };
}
function usableTarget(binding: { target: Prisma.JsonValue | null; reason: string | null } | null, analysis: { snapshot: Prisma.JsonValue } | null) {
  if (!binding?.target || !analysis) throw new DocumentError('DOCUMENT_TRACE_UNBOUND', 'This compare card has no verified saved target. Prepare a new proposal.', 409, { reason: binding?.reason ?? 'NO_SAVED_BINDING' });
  return binding.target as unknown as FrozenDocumentTarget;
}
/** Revalidation is an explicit human action after autosave. It never searches
 * for a quotation or silently relocates an orphaned finding. */
export async function revalidateBoundCompare(userId: number, bookId: number, traceId: string, cardId: number, raw: unknown) {
  await owned(userId, bookId);
  const input = documentCompareRevalidateSchema.parse(raw);
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const { trace, card, binding, analysis } = await boundCard(tx, userId, bookId, traceId, cardId);
    if (card.status !== 'open') throw new DocumentError('DOCUMENT_COMPARE_RESOLVED', 'This choice was already recorded.', 409);
    const target = usableTarget(binding, analysis);
    const source = await documentService.read(userId, bookId, trace.sceneId!);
    if (source.bookRevisionId !== input.expectedRevisionId || source.revisionId !== input.expectedSceneRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Flush edits and use the resulting saved revisions.', 412, { currentRevisionId: source.bookRevisionId, currentSceneRevisionId: source.revisionId });
    const manifest = await documentService.manifest(userId, bookId);
    await verifySceneTargetContext(tx, bookId, trace.sceneId!, analysis!.snapshot as unknown as DocumentTraceSnapshot, manifest);
    if (manifest.scopes?.layout.contentHash !== (analysis!.snapshot as unknown as DocumentTraceSnapshot).bookLayoutHash) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Book layout changed since analysis.', 409);
    const current = currentTarget(source.document, target);
    if (!current.editable) throw new DocumentError('DOCUMENT_REVIEW_CONFLICT', 'Resolve overlapping pending review changes before revalidation.', 409);
    const previous = await tx.documentCompareValidation.findUnique({ where: { id: input.operationId } });
    if (previous) {
      if (previous.userId !== userId || previous.bookId !== bookId || previous.targetId !== binding!.id || previous.bookRevisionId !== source.bookRevisionId || previous.sceneRevisionId !== source.revisionId || previous.contentHash !== source.contentHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Validation ID was reused for another source.', 409);
      return previous;
    }
    return tx.documentCompareValidation.create({ data: { id: input.operationId, targetId: binding!.id, userId, bookId, bookRevisionId: source.bookRevisionId, sceneRevisionId: source.revisionId, contentHash: source.contentHash, target: json(current) } });
  });
}

export async function recordBoundPreference(params: Omit<DocumentCompareRequest, 'operationId' | 'expectedRevisionId' | 'expectedSceneRevisionId'> & { userId: number; bookId: number; sceneId: number; operationId?: string; expectedRevisionId?: string; expectedSceneRevisionId?: string }) {
  const { userId, bookId, sceneId, ...raw } = params;
  await owned(userId, bookId);
  if (!raw.operationId || !raw.expectedRevisionId || !raw.expectedSceneRevisionId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Operation ID and book/scene revision preconditions are required.', 428);
  const input = documentCompareSchema.parse(raw);
  // Receipt recovery happens before examining current card/review eligibility.
  // A lost acknowledgement must recover the original atomic action.
  return documentService.mutateCatalog(userId, bookId, { operationId: input.operationId, expectedRevisionId: input.expectedRevisionId, expectedScopes: {}, payload: { action: 'document-compare-choice', sceneId, input } }, async (tx) => {
    const { trace, card, binding, analysis } = await boundCard(tx, userId, bookId, input.traceId, input.compareCardId, sceneId);
    if (card.status !== 'open') throw new DocumentError('DOCUMENT_COMPARE_RESOLVED', 'This choice was already recorded.', 409);
    const source = await documentService.read(userId, bookId, sceneId);
    if (source.revisionId !== input.expectedSceneRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Scene changed before this choice.', 412, { currentSceneRevisionId: source.revisionId });
    let document = source.document;
    let applied = false;
    let verification: ReturnType<typeof verifyCandidate> | undefined;
    if (input.applyChosen) {
      const target = usableTarget(binding, analysis);
      const validation = input.validationId ? await tx.documentCompareValidation.findFirst({ where: { id: input.validationId, targetId: binding!.id, userId, bookId } }) : null;
      if (!validation) throw new DocumentError('DOCUMENT_COMPARE_REVALIDATION_REQUIRED', 'Explicitly revalidate this saved target before applying.', 409);
      if (validation.bookRevisionId !== input.expectedRevisionId || validation.sceneRevisionId !== source.revisionId || validation.contentHash !== source.contentHash) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'The revalidated source changed.', 412);
      const current = currentTarget(source.document, target);
      if (!current.editable || canonicalDocument(current) !== canonicalDocument(validation.target)) throw new DocumentError('DOCUMENT_REVIEW_CONFLICT', 'The revalidated target is no longer editable.', 409);
      const manifest = await documentService.manifest(userId, bookId);
      await verifySceneTargetContext(tx, bookId, sceneId, analysis!.snapshot as unknown as DocumentTraceSnapshot, manifest);
      if (manifest.scopes?.layout.contentHash !== (analysis!.snapshot as unknown as DocumentTraceSnapshot).bookLayoutHash) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Book layout changed since analysis.', 409);
      const replacement = input.chosen === 'a' ? card.optionAText : card.optionBText;
      if (replacement.includes('\n\n')) throw new DocumentError('DOCUMENT_COMPARE_INCOMPATIBLE', 'Paragraph split/join proposals require structured paragraph operations.', 422);
      // Preserve the existing compare-card policy and verification gates.
      verification = verifyCandidate({ original: target.sourceText, candidate: replacement, expectedSourceHash: textHash(target.sourceText), maxChangedPercent: 50 });
      if (!verification.passed) throw new DocumentError('EDITORIAL_PROPOSAL_NOT_APPLICABLE', 'The choice failed editorial verification.', 409, verification);
      const diff = minimalTextEdit(target.sourceText, replacement);
      if (target.sourceText !== replacement) {
        const span = source.projection.spans.find((item) => item.blockId === target.blockId && item.runId !== undefined);
        if (!span) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Target is no longer editable.', 409);
        try { document = validateDocument(replaceDocumentText(document, span.start + target.from + diff.start, span.start + target.from + diff.end, target.sourceText.slice(diff.start, diff.end), diff.replacement, randomUUID, { authorId: userId, authorName: String(userId), createdAt: new Date().toISOString(), origin: 'ai', status: 'pending' }, { blockId: target.blockId })); }
        catch (error) { throw new DocumentError('DOCUMENT_COMPARE_INCOMPATIBLE', error instanceof Error ? error.message : 'The choice cannot preserve this target.', 409); }
        applied = true;
      }
    }
    await tx.proseCompareCard.update({ where: { id: card.id }, data: { status: input.chosen === 'a' ? 'chosen_a' : 'chosen_b' } });
    const action = await tx.proseAction.create({ data: { proseTraceId: trace.id, userId, bookId, sceneId, proseFindingId: card.proseFindingId, proseCompareCardId: card.id, actionType: input.chosen === 'a' ? 'choose_option_a' : 'choose_option_b', metadataJson: JSON.stringify({ ...input, applied, analysisId: analysis?.id, sourceBookRevisionId: input.expectedRevisionId, sourceSceneRevisionId: source.revisionId, target: binding?.target, verification }) } });
    return { receiptProjection: 'references' as const, result: { traceId: input.traceId, compareCardId: card.id, actionId: action.id, applied, sourceBookRevisionId:input.expectedRevisionId, sourceSceneRevisionId:source.revisionId }, ...(applied ? { changedDocuments: [{ sceneId, expectedRevisionId: source.revisionId, document }] } : {}) };
  }, 'ai');
}

export async function readDocumentTraceReview(userId: number, bookId: number, sceneId: number, traceId?: string): Promise<DocumentTraceReview | null> {
  await owned(userId, bookId);
  const trace = await db().proseTrace.findFirst({ where: { userId, bookId, sceneId, ...(traceId ? { traceId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { findings: true, compareCards: true } });
  if (!trace) return null;
  const analysis = await db().documentTraceAnalysis.findFirst({ where: { traceId: trace.traceId, bookId, userId, sceneId } });
  const bindings = await db().documentTraceTarget.findMany({ where: { traceId: trace.traceId, bookId, userId, sceneId } });
  const source = await documentService.read(userId, bookId, sceneId);
  const manifest = await documentService.manifest(userId, bookId);
  const snapshot = analysis?.snapshot as unknown as DocumentTraceSnapshot | undefined;
  let parentStale = source.bookRevisionId!==manifest.revisionId;
  if (snapshot) { try { await verifySceneTargetContext(db(), bookId, sceneId, snapshot, manifest); } catch { parentStale = true; } }
  const state = (binding?: typeof bindings[number]): Pick<DocumentTraceReview['findings'][number], 'state' | 'reason' | 'target'> => {
    if (!binding?.target || analysis?.status !== 'completed') return { state: 'unbound', reason: binding?.reason ?? 'NO_SAVED_BINDING' };
    const target = binding.target as unknown as FrozenDocumentTarget;
    try {
      if (parentStale) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Owned target parent or effective layout changed.',409);
      if (manifest.scopes?.layout.contentHash !== snapshot?.bookLayoutHash) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Book layout changed.', 409);
      const current = currentTarget(source.document, target);
      const {paragraphText:_paragraphText,...display}=current;
      return { target: display, state: current.editable ? 'bound' : 'review-blocked', ...(!current.editable ? { reason: 'PENDING_REVIEW_CHANGES' } : {}) };
    } catch { return { state: 'stale', reason: 'TARGET_TEXT_FORMAT_OBJECT_OR_IDENTITY_CHANGED' }; }
  };
  const result = analysis?.result as unknown as { output?: DocumentFeedbackOutput } | undefined;
  return { traceId: trace.traceId, sceneId, analysisId: analysis?.id, status: analysis?.status ?? 'unbound', ...(!parentStale?{currentSource:{bookRevisionId:source.bookRevisionId,sceneRevisionId:source.revisionId,contentHash:source.contentHash,bookContentHash:manifest.contentHash,layoutContentHash:manifest.scopes!.layout.contentHash}}:{}), ...(snapshot ? { source: { bookRevisionId: snapshot.bookRevisionId, sceneRevisionId: snapshot.sceneRevisionId, contentHash: snapshot.contentHash } } : {}), summary: result?.output?.judgeSummary,
    findings: trace.findings.map((finding) => ({ id: finding.id, title: finding.title, message: finding.message, severity: finding.severity, suggestion: finding.suggestion, ...state(bindings.find((binding) => binding.findingId === finding.id)) })),
    compareCards: trace.compareCards.map((card) => ({ id: card.id, title: card.title, message: card.message, optionALabel: card.optionALabel, optionAText: card.optionAText, optionBLabel: card.optionBLabel, optionBText: card.optionBText, status: card.status, ...state(bindings.find((binding) => binding.compareCardId === card.id)) })) };
}
