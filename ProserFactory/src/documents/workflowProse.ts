import { createHash, randomUUID } from 'node:crypto';
import type { SceneProseContext, SceneProseOptions, SceneProseService } from '@/services/sceneProseService';
import { documentService } from './service';
import { runWorkflowEffect, readWorkflowEffect } from './workflowEffects';
import { compatibilityOperationId } from './operationIdentity';
import { readScope } from './scopes';
import { canonicalDocument, projectDocument, regenerateDocumentText } from './model';
import { validateDocument } from './validation';
import { DocumentError } from './errors';

type Source = Awaited<ReturnType<typeof documentService.read>>;
async function verifyRetainedSource(userId: number, bookId: number, runId: string, effectKey: string, current: Source) {
  const row = await readWorkflowEffect(userId, bookId, compatibilityOperationId('proser.workflow-provider.v1', { runId, effectKey }));
  const frozen = (row.request as unknown as { source: { bookRevisionId: string; sceneRevisionId: string; contentHash: string } }).source;
  if (current.bookRevisionId !== frozen.bookRevisionId || current.revisionId !== frozen.sceneRevisionId || current.contentHash !== frozen.contentHash) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Retained inference belongs to an earlier complete document revision; reconcile explicitly before application.', 412, { operationId: row.id, sourceBookRevisionId: frozen.bookRevisionId, sourceSceneRevisionId: frozen.sceneRevisionId, currentRevisionId: current.bookRevisionId });
}

export async function workflowProseCandidate(service: SceneProseService, input: { userId: number; bookId: number; runId: string; sceneId: number; ordinal: number; source: Source; context: SceneProseContext; options: SceneProseOptions }) {
  if (input.source.sceneId !== input.sceneId || input.context.bookId !== input.bookId || input.context.sceneId !== input.sceneId) throw new DocumentError('DOCUMENT_SCOPE_INVALID', 'Candidate context belongs to another document scope.', 409);
  if (input.source.projection.text.trim()) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'This draft target already contains saved prose. Reconcile the workflow before requesting a replacement.', 412);
  try { regenerateDocumentText(input.source.document, '', randomUUID, { authorId: input.userId, authorName: String(input.userId), createdAt: new Date().toISOString(), status: 'pending', origin: 'workflow' }); }
  catch (error) { throw new DocumentError('DOCUMENT_RECONCILIATION_REQUIRED', error instanceof Error ? error.message : 'Reconcile protected objects before generation.', 409); }
  const result = await runWorkflowEffect({ userId: input.userId, bookId: input.bookId, runId: input.runId, sceneId: input.sceneId, effectKey: `draft:${input.sceneId}:candidate:${input.ordinal}`, intent: { ordinal: input.ordinal, targetWords: input.context.targetWords, writingStyle: input.context.writingStyle }, expectedRevisionId: input.source.bookRevisionId, timeoutMs: input.options.timeoutMs ?? 600000 }, async (tx, manifest) => {
    if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Canonical scopes are required for generation.', 409);
    const structure = await readScope(tx, input.bookId, 'structure', manifest.scopes.structure);
    const canon = await readScope(tx, input.bookId, 'canon', manifest.scopes.canon);
    const reference = manifest.scenes.find((scene) => scene.sceneId === input.sceneId);
    if (!reference || reference.revisionId !== input.source.revisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Scene changed before candidate admission.', 412);
    const scene = structure.scenes.find((scene) => scene.id === input.sceneId)!;
    const chapter = structure.chapters.find((chapter) => chapter.id === scene.chapterId)!;
    const act = structure.acts.find((act) => act.id === chapter.actId)!;
    const ordered = manifest.scenes.filter((item) => !item.deletedAt);
    const previous = ordered[ordered.findIndex((item) => item.sceneId === input.sceneId) - 1];
    let previousSceneSummary: string | undefined;
    if (previous) {
      const saved = await tx.sceneDocumentRevision.findFirst({ where: { id: previous.revisionId, bookId: input.bookId, sceneId: previous.sceneId } });
      if (!saved || saved.contentHash !== previous.contentHash || createHash('sha256').update(canonicalDocument(saved.document)).digest('hex') !== previous.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Previous scene context does not match the immutable manifest.', 503);
      const text = projectDocument(validateDocument(saved.document)).text;
      if (!text.trim()) throw new DocumentError('DOCUMENT_WORKFLOW_CONTEXT_INCOMPLETE', 'Draft the preceding scene before requesting this candidate.', 409);
      const previousPlan = structure.scenes.find((item) => item.id === previous.sceneId);
      previousSceneSummary = `Previous scene ${previous.sceneId} contract (planned, not proof of events): ${previousPlan?.outline ?? ''}\nExact committed ending (continuity evidence; do not repeat): ${text.trim().split(/\s+/).slice(-400).join(' ')}`;
    }
    const included: NonNullable<SceneProseOptions['frozenCodex']> = []; const omitted: number[] = []; let size = 0;
    for (const entry of canon.entries.filter((entry) => !entry.deletedAt).sort((a,b) => a.id - b.id)) {
      const excerpt = [entry.entryDescription,entry.attributes].filter(Boolean).join('\n'); const bytes = Buffer.byteLength(entry.entryName + excerpt);
      if (!input.context.useCodexRAG || size + bytes > 32000) { omitted.push(entry.id); continue; }
      included.push({ id: entry.id, entry_type: entry.entryType, entry_name: entry.entryName, excerpt }); size += bytes;
    }
    const context: SceneProseContext = { ...input.context, previousSceneSummary, title: structure.book.title ?? 'Untitled', genre: structure.book.genre ?? undefined, summary: structure.book.summary ?? undefined, targetAudience: structure.book.targetAudience ?? undefined, chapterId: chapter.id, chapterNumber: chapter.chapterNumber, chapterTitle: chapter.title ?? undefined, chapterSummary: chapter.summary ?? undefined, actNumber: act.actNumber, actTitle: act.title ?? undefined, sceneNumber: scene.sceneNumber, sceneOutline: scene.outline ?? undefined, sceneSummary: scene.summary ?? undefined };
    return { context, codex: included, options: { selectedModel: input.options.selectedModel, timeoutMs: input.options.timeoutMs, autoReviseSkills: false }, source: { bookRevisionId: input.source.bookRevisionId, sceneRevisionId: input.source.revisionId, contentHash: input.source.contentHash }, disclosure: { projection: 'final', includedCodexIds: included.map((entry) => entry.id), omittedCodexIds: omitted, sceneIds: previous ? [previous.sceneId, input.sceneId] : [input.sceneId], ...(previous ? { previousScene: { sceneId: previous.sceneId, revisionId: previous.revisionId, contentHash: previous.contentHash } } : {}) } };
  }, (request, signal) => service.generateProse(request.context, { ...request.options, signal, noTransportReplay: true, frozenContext: true, frozenCodex: request.codex, frozenSource: request.source }));
  await verifyRetainedSource(input.userId, input.bookId, input.runId, `draft:${input.sceneId}:candidate:${input.ordinal}`, input.source);
  return result;
}

export async function workflowProseRevision(service: SceneProseService, input: { userId: number; bookId: number; runId: string; sceneId: number; effectKey: string; source: Source; original: string; instruction: Parameters<SceneProseService['reviewProse']>[1]; options: SceneProseOptions }) {
  if (input.source.sceneId !== input.sceneId) throw new DocumentError('DOCUMENT_SCOPE_INVALID', 'Revision source belongs to another scene.', 409);
  if (input.source.projection.text !== input.original) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Review source differs from the saved final projection.', 412);
  const result = await runWorkflowEffect({ userId: input.userId, bookId: input.bookId, runId: input.runId, sceneId: input.sceneId, effectKey: input.effectKey, intent: { instruction: input.instruction, selectedModel: input.options.selectedModel }, expectedRevisionId: input.source.bookRevisionId, timeoutMs: input.options.timeoutMs ?? 300000 }, async () => ({ original: input.original, instruction: input.instruction, options: { selectedModel: input.options.selectedModel, timeoutMs: input.options.timeoutMs }, source: { bookRevisionId: input.source.bookRevisionId, sceneRevisionId: input.source.revisionId, contentHash: input.source.contentHash } }), (request, signal) => service.reviewProse(request.original, request.instruction, { ...request.options, signal, noTransportReplay: true }));
  await verifyRetainedSource(input.userId, input.bookId, input.runId, input.effectKey, input.source);
  return result;
}
