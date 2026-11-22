import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { databaseService } from '@/lib/database';
import type { DocumentManifest } from '@/documents/service';
import { projectDocument } from '@/documents/model';
import { validateDocument } from '@/documents/validation';
import { compatibilityOperationId } from '@/documents/operationIdentity';
import { documentAuthorityEnabled, documentService, DocumentError } from '@/documents/service';
import { assertWorkflowLease, currentWorkflowExecution, withWorkflowLease } from '@/services/workflowExecutionContext';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const countWords = (text?: string | null) => text?.trim().split(/\s+/).filter(Boolean).length ?? 0;

export type SceneSnapshot = {
  id: number;
  chapterId: number;
  sceneNumber: number;
  prose: string;
  summary: string | null;
  outline: string | null;
};

class ManuscriptRevisionService {
  private get db() { return databaseService.client; }

  private async owner(bookId: number) {
    const book = await this.db.book.findFirst({ where: { id: bookId, deletedAt: null }, select: { userId: true } });
    if (!book) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Book not found.', 404);
    return book.userId;
  }
  private async mappedRevision(bookId: number, revisionId: string, requireComplete = false) {
    const mapping = await this.db.documentLegacyRevisionMapping.findFirst({ where: { legacyRevisionId: revisionId, bookId } });
    if (!mapping) throw new DocumentError('DOCUMENT_LEGACY_MAPPING_REQUIRED', 'Historical revision conversion must be completed before using this source.', 409);
    if (requireComplete && (mapping.fidelity as { completeDocument?: boolean }).completeDocument === false) throw new DocumentError('DOCUMENT_LEGACY_RESTORE_INCOMPLETE', 'This historical snapshot did not record complete document state. Automatic restoration is blocked; inspect its preserved conversion report.', 409);
    return mapping.documentRevisionId;
  }
  async snapshotRevision(bookId: number, revisionId: string): Promise<{ scenes: SceneSnapshot[]; codex: unknown[]; wordCount: number; contentHash: string }> {
    if (documentAuthorityEnabled()) {
      const mapping = await this.db.documentLegacyRevisionMapping.findFirst({ where: { legacyRevisionId: revisionId, bookId } });
      if (!mapping) throw new DocumentError('DOCUMENT_LEGACY_MAPPING_REQUIRED', 'Historical revision conversion must be completed before using this source.', 409);
      return documentService.revisionProjection(await this.owner(bookId), bookId, mapping.documentRevisionId);
    }
    const revision = await this.db.manuscriptRevision.findFirst({ where: { id: revisionId, bookId } });
    if (!revision) throw new Error('Manuscript revision not found');
    const snapshot = revision.snapshot as unknown as { scenes: SceneSnapshot[]; codex: unknown[] };
    return { ...snapshot, wordCount: revision.wordCount, contentHash: revision.contentHash };
  }
  async snapshot(bookId: number): Promise<{ scenes: SceneSnapshot[]; codex: unknown[]; wordCount: number; contentHash: string }> {
    if (documentAuthorityEnabled()) {
      const userId = await this.owner(bookId); const manifest = await documentService.manifest(userId, bookId);
      return documentService.revisionProjection(userId, bookId, manifest.revisionId);
    }
    const scenes = await this.db.scene.findMany({
      where: { chapter: { act: { bookId } }, deletedAt: null },
      orderBy: [{ chapterId: 'asc' }, { sceneNumber: 'asc' }],
      select: { id: true, chapterId: true, sceneNumber: true, prose: true, summary: true, outline: true },
    });
    const codex = await this.db.codexEntry.findMany({
      where: { bookId, deletedAt: null }, orderBy: { id: 'asc' },
      select: { id: true, entryType: true, entryName: true, entryDescription: true, attributes: true },
    });
    const normalized = scenes.map((scene) => ({ ...scene, prose: scene.prose ?? '' }));
    const payload = { scenes: normalized, codex };
    return { ...payload, wordCount: normalized.reduce((sum, scene) => sum + countWords(scene.prose), 0), contentHash: hash(payload) };
  }

  async capture(bookId: number, workflowRunId?: string, changedScopes: unknown[] = [], force = false, operationSignal?: AbortSignal): Promise<string> {
    operationSignal?.throwIfAborted();
    if (workflowRunId) await assertWorkflowLease(workflowRunId);
    if (documentAuthorityEnabled()) {
      const manifest = await documentService.manifest(await this.owner(bookId), bookId);
      const bridge = await this.db.manuscriptRevision.findFirst({ where: { id: manifest.revisionId, bookId }, select: { contentHash: true } });
      const mapping = await this.db.documentLegacyRevisionMapping.findFirst({ where: { legacyRevisionId: manifest.revisionId, bookId }, select: { documentRevisionId: true } });
      if (!bridge || bridge.contentHash !== manifest.contentHash || mapping?.documentRevisionId !== manifest.revisionId) throw new DocumentError('DOCUMENT_REVISION_BRIDGE_BACKFILL_REQUIRED', 'Explicit revision bridge backfill is required before workflow admission.', 409);
      operationSignal?.throwIfAborted(); return manifest.revisionId;
    }
    const snapshot = await this.snapshot(bookId);
    const existing = force ? null : await this.db.manuscriptRevision.findFirst({ where: { bookId, contentHash: snapshot.contentHash }, orderBy: { createdAt: 'desc' } });
    if (existing) return existing.id;
    const parent = await this.db.manuscriptRevision.findFirst({ where: { bookId }, orderBy: { createdAt: 'desc' } });
    operationSignal?.throwIfAborted();
    const revision = await this.db.manuscriptRevision.create({ data: {
      id: randomUUID(), bookId, parentRevisionId: parent?.id, workflowRunId,
      leaseOwner: currentWorkflowExecution()?.leaseOwner,
      contentHash: snapshot.contentHash, wordCount: snapshot.wordCount,
      changedScopes: changedScopes as Prisma.InputJsonValue,
      snapshot: { scenes: snapshot.scenes, codex: snapshot.codex } as Prisma.InputJsonValue,
    } });
    return revision.id;
  }

  async current(bookId: number, operationSignal?: AbortSignal): Promise<string> {
    return this.capture(bookId, undefined, [], false, operationSignal);
  }

  /**
   * Apply prose patches and capture the resulting immutable revision in one
   * transaction. The expected head and exact source text fence late workers and
   * stale compare cards without leaving partially applied prose behind.
   */
  async applyScenePatches(input: {
    bookId: number;
    userId?: number;
    operationId?: string;
    expectedRevisionId: string;
    workflowRunId?: string;
    patches: Array<{ sceneId: number; expectedProse: string; revisedProse: string }>;
    changedScopes?: unknown[];
  }): Promise<string> {
    if (!input.patches.length) return input.expectedRevisionId;
    if (input.workflowRunId) await assertWorkflowLease(input.workflowRunId);
    if (documentAuthorityEnabled()) {
      if (!input.userId) throw new DocumentError('DOCUMENT_ACTOR_REQUIRED', 'The authenticated editorial actor is required.', 428);
      const userId = input.userId;
      const sourceRevisionId = await this.mappedRevision(input.bookId, input.expectedRevisionId);
      const execution = currentWorkflowExecution();
      if (input.workflowRunId && execution?.runId !== input.workflowRunId) throw new DocumentError('DOCUMENT_WORKFLOW_SCOPE_INVALID', 'The editorial workflow lease is required.', 409);
      const origin = execution ? 'workflow' as const : 'ai' as const;
      const operationId = input.operationId ?? compatibilityOperationId('proser.editorial-apply.v1', { userId, bookId: input.bookId, expectedRevisionId: input.expectedRevisionId, patches: input.patches });
      const receipt = await documentService.mutateCatalog(userId, input.bookId, { operationId, expectedRevisionId: sourceRevisionId, expectedScopes: {}, payload: { command: 'editorial-apply', patches: input.patches, workflowRunId: input.workflowRunId } }, async (tx) => {
        const source = await tx.bookDocumentRevision.findFirstOrThrow({ where: { id: sourceRevisionId, bookId: input.bookId } });
        const manifest = source.manifest as unknown as DocumentManifest; const changedDocuments = [];
        for (const patch of input.patches) {
          const reference = manifest.scenes.find((scene) => scene.sceneId === patch.sceneId && !scene.deletedAt);
          if (!reference) throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND', 'Editorial scene is not in its source manifest.', 409);
          const body = await tx.sceneDocumentRevision.findFirstOrThrow({ where: { id: reference.revisionId, bookId: input.bookId, sceneId: patch.sceneId } });
          if (projectDocument(validateDocument(body.document)).text !== patch.expectedProse) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Editorial source text does not match its document revision.', 412);
          changedDocuments.push({ sceneId: patch.sceneId, expectedRevisionId: reference.revisionId, document: await documentService.replacementDocument(tx, input.bookId, patch.sceneId, reference.revisionId, patch.revisedProse, userId, origin) });
        }
        return { result: { sceneIds: input.patches.map((patch) => patch.sceneId) }, changedDocuments };
      }, origin);
      return receipt.revisionId;
    }
    const duplicate = new Set(input.patches.map((patch) => patch.sceneId));
    if (duplicate.size !== input.patches.length) throw new Error('Duplicate scene patch');
    const revisionId = randomUUID();
    const apply = async (tx: Prisma.TransactionClient) => {
      const head = await tx.manuscriptRevision.findFirst({
        where: { bookId: input.bookId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (head?.id !== input.expectedRevisionId) throw new Error('EDITORIAL_SOURCE_STALE');
      const [scenes, codex] = await Promise.all([
        tx.scene.findMany({
          where: { chapter: { act: { bookId: input.bookId } }, deletedAt: null },
          orderBy: [{ chapterId: 'asc' }, { sceneNumber: 'asc' }],
          select: { id: true, chapterId: true, sceneNumber: true, prose: true, summary: true, outline: true },
        }),
        tx.codexEntry.findMany({
          where: { bookId: input.bookId, deletedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, entryType: true, entryName: true, entryDescription: true, attributes: true },
        }),
      ]);
      const patchByScene = new Map(input.patches.map((patch) => [patch.sceneId, patch]));
      const nextScenes = scenes.map((scene) => {
        const patch = patchByScene.get(scene.id);
        const current = scene.prose ?? '';
        if (!patch) return { ...scene, prose: current };
        if (current !== patch.expectedProse) throw new Error('EDITORIAL_SOURCE_STALE');
        return { ...scene, prose: patch.revisedProse };
      });
      if (input.patches.some((patch) => !scenes.some((scene) => scene.id === patch.sceneId))) throw new Error('EDITORIAL_SCOPE_INVALID');
      const snapshot = { scenes: nextScenes, codex };
      const contentHash = hash(snapshot);
      const wordCount = nextScenes.reduce((sum, scene) => sum + countWords(scene.prose), 0);
      for (const patch of input.patches) {
        await documentService.legacyWriteScene(input.userId ?? await this.owner(input.bookId), input.bookId, patch.sceneId, { prose: patch.revisedProse || null }, tx);
      }
      await tx.manuscriptRevision.create({
        data: {
          id: revisionId,
          bookId: input.bookId,
          parentRevisionId: input.expectedRevisionId,
          workflowRunId: input.workflowRunId,
          leaseOwner: currentWorkflowExecution()?.leaseOwner,
          contentHash,
          wordCount,
          changedScopes: (input.changedScopes ?? input.patches.map((patch) => ({ type: 'scene', id: patch.sceneId }))) as Prisma.InputJsonValue,
          snapshot: snapshot as Prisma.InputJsonValue,
        },
      });
      return revisionId;
    };
    return input.workflowRunId
      ? withWorkflowLease(input.workflowRunId, apply)
      : this.db.$transaction(apply);
  }

  /** Read the persisted revision head and its ancestry without snapshotting manuscript content. */
  async currentAncestry(bookId: number): Promise<{ current: string | null; ancestors: Set<string> }> {
    if (documentAuthorityEnabled()) {
      const manifest = await documentService.manifest(await this.owner(bookId), bookId);
      const graph = await this.db.bookDocumentRevision.findMany({ where: { bookId }, select: { id: true, parentRevisionId: true } });
      const parents = new Map(graph.map((revision) => [revision.id, revision.parentRevisionId])); const ancestors = new Set<string>(); let cursor: string | null = manifest.revisionId;
      while (cursor && !ancestors.has(cursor)) { ancestors.add(cursor); cursor = parents.get(cursor) ?? null; }
      return { current: manifest.revisionId, ancestors };
    }
    const [head, graph] = await Promise.all([
      this.db.manuscriptRevision.findFirst({ where: { bookId }, orderBy: { createdAt: 'desc' }, select: { id: true } }),
      this.db.manuscriptRevision.findMany({ where: { bookId }, select: { id: true, parentRevisionId: true } }),
    ]);
    const parents = new Map(graph.map((revision) => [revision.id, revision.parentRevisionId]));
    const ancestors = new Set<string>();
    let cursor = head?.id ?? null;
    while (cursor && !ancestors.has(cursor)) {
      ancestors.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    return { current: head?.id ?? null, ancestors };
  }

  async restore(bookId: number, revisionId: string, operationSignal?: AbortSignal, preconditions?: { userId: number; expectedRevisionId: string; operationId: string }): Promise<string> {
    operationSignal?.throwIfAborted();
    if (documentAuthorityEnabled()) {
      if (!preconditions?.userId || !preconditions.expectedRevisionId || !preconditions.operationId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Restore requires an authenticated actor, expected head and operation ID.', 428);
      const target = await this.mappedRevision(bookId, revisionId, true);
      const expected = await this.mappedRevision(bookId, preconditions.expectedRevisionId);
      const receipt = await documentService.restore(preconditions.userId, bookId, target, expected, preconditions.operationId);
      return receipt.revisionId;
    }
    const revision = await this.db.manuscriptRevision.findFirst({ where: { id: revisionId, bookId } });
    if (!revision) throw new Error('Manuscript revision not found');
    const snapshot = revision.snapshot as unknown as { scenes: SceneSnapshot[]; codex: Array<{ id: number; entryType: string; entryName: string; entryDescription: string | null; attributes: string | null }> };
    const currentScenes = await this.db.scene.findMany({ where: { chapter: { act: { bookId } }, deletedAt: null }, select: { id: true } });
    const currentCodex = await this.db.codexEntry.findMany({ where: { bookId, deletedAt: null }, select: { id: true } });
    const sameIds = (left: number[], right: number[]) => JSON.stringify([...left].sort((a, b) => a - b)) === JSON.stringify([...right].sort((a, b) => a - b));
    if (!sameIds(currentScenes.map((scene) => scene.id), snapshot.scenes.map((scene) => scene.id))) throw new Error('Structural scene changes require a dedicated structural rollback');
    if (!sameIds(currentCodex.map((entry) => entry.id), snapshot.codex.map((entry) => entry.id))) throw new Error('Codex membership changes require a dedicated canon rollback');
    operationSignal?.throwIfAborted();
    const resultRevisionId = randomUUID();
    await this.db.$transaction(async (tx) => {
      const parent = await tx.manuscriptRevision.findFirst({ where: { bookId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      for (const scene of snapshot.scenes) {
        operationSignal?.throwIfAborted();
        await documentService.legacyWriteScene(preconditions?.userId ?? await this.owner(bookId), bookId, scene.id, { prose: scene.prose || null, summary: scene.summary, outline: scene.outline }, tx);
      }
      for (const entry of snapshot.codex) {
        operationSignal?.throwIfAborted();
        await tx.codexEntry.update({ where: { id: entry.id }, data: { entryType: entry.entryType, entryName: entry.entryName, entryDescription: entry.entryDescription, attributes: entry.attributes } });
      }
      operationSignal?.throwIfAborted();
      await tx.manuscriptRevision.create({ data: {
        id: resultRevisionId,
        bookId,
        parentRevisionId: parent?.id,
        contentHash: revision.contentHash,
        wordCount: snapshot.scenes.reduce((sum, scene) => sum + countWords(scene.prose), 0),
        changedScopes: [{ type: 'rollback', revisionId }] as Prisma.InputJsonValue,
        snapshot: snapshot as Prisma.InputJsonValue,
      } });
      operationSignal?.throwIfAborted();
    });
    operationSignal?.throwIfAborted();
    return resultRevisionId;
  }

  /**
   * Restore only while the editorial result is still the manuscript head. A
   * concurrent descendant is preserved and returns null for supersession.
   */
  async restoreIfCurrent(input: {
    bookId: number;
    revisionId: string;
    expectedCurrentRevisionId: string;
    workflowRunId: string;
  }): Promise<string | null> {
    if (documentAuthorityEnabled()) {
      const run = await this.db.workflowRun.findUniqueOrThrow({ where: { id: input.workflowRunId }, select: { userId: true, bookId: true } });
      if (run.bookId !== input.bookId || currentWorkflowExecution()?.runId !== input.workflowRunId) throw new DocumentError('DOCUMENT_WORKFLOW_SCOPE_INVALID', 'Rollback requires this book workflow lease.', 409);
      const target = await this.mappedRevision(input.bookId, input.revisionId, true); const expected = await this.mappedRevision(input.bookId, input.expectedCurrentRevisionId);
      try {
        const receipt = await documentService.restore(run.userId, input.bookId, target, expected, compatibilityOperationId('proser.editorial-rollback.v1', input));
        return receipt.revisionId;
      } catch (error) { if (error instanceof DocumentError && error.status === 412) return null; throw error; }
    }
    const revision = await this.db.manuscriptRevision.findFirst({
      where: { id: input.revisionId, bookId: input.bookId },
    });
    if (!revision) throw new Error('Manuscript revision not found');
    const snapshot = revision.snapshot as unknown as {
      scenes: SceneSnapshot[];
      codex: Array<{
        id: number;
        entryType: string;
        entryName: string;
        entryDescription: string | null;
        attributes: string | null;
      }>;
    };
    return withWorkflowLease(input.workflowRunId, async (tx, leaseOwner) => {
      const head = await tx.manuscriptRevision.findFirst({
        where: { bookId: input.bookId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (head?.id !== input.expectedCurrentRevisionId) return null;
      const [currentScenes, currentCodex] = await Promise.all([
        tx.scene.findMany({
          where: { chapter: { act: { bookId: input.bookId } }, deletedAt: null },
          select: { id: true },
        }),
        tx.codexEntry.findMany({
          where: { bookId: input.bookId, deletedAt: null },
          select: { id: true },
        }),
      ]);
      const sameIds = (left: number[], right: number[]) =>
        JSON.stringify([...left].sort((a, b) => a - b)) === JSON.stringify([...right].sort((a, b) => a - b));
      if (!sameIds(currentScenes.map((scene) => scene.id), snapshot.scenes.map((scene) => scene.id))) {
        throw new Error('Structural scene changes require a dedicated structural rollback');
      }
      if (!sameIds(currentCodex.map((entry) => entry.id), snapshot.codex.map((entry) => entry.id))) {
        throw new Error('Codex membership changes require a dedicated canon rollback');
      }
      for (const scene of snapshot.scenes) await documentService.legacyWriteScene(await this.owner(input.bookId), input.bookId, scene.id, { prose: scene.prose || null, summary: scene.summary, outline: scene.outline }, tx);
      for (const entry of snapshot.codex) await tx.codexEntry.update({
        where: { id: entry.id },
        data: {
          entryType: entry.entryType,
          entryName: entry.entryName,
          entryDescription: entry.entryDescription,
          attributes: entry.attributes,
        },
      });
      const resultRevisionId = randomUUID();
      await tx.manuscriptRevision.create({
        data: {
          id: resultRevisionId,
          bookId: input.bookId,
          parentRevisionId: input.expectedCurrentRevisionId,
          workflowRunId: input.workflowRunId,
          leaseOwner,
          contentHash: revision.contentHash,
          wordCount: revision.wordCount,
          changedScopes: [{ type: 'rollback', revisionId: input.revisionId }] as Prisma.InputJsonValue,
          snapshot: revision.snapshot as Prisma.InputJsonValue,
        },
      });
      return resultRevisionId;
    });
  }

  async isAncestor(ancestorId: string, revisionId: string): Promise<boolean> {
    let cursor: string | null = revisionId;
    while (cursor) {
      if (cursor === ancestorId) return true;
      const row: { parentRevisionId: string | null } | null = await this.db.manuscriptRevision.findUnique({ where: { id: cursor }, select: { parentRevisionId: true } });
      cursor = row?.parentRevisionId ?? null;
    }
    return false;
  }
}

export const manuscriptRevisionService = new ManuscriptRevisionService();

function normalizedSequenceDiff(originalWords: string[], revisedWords: string[]): number {
  if (!originalWords.length || !revisedWords.length) return 1;
  const left = originalWords.map((word) => word.toLocaleLowerCase('en-US'));
  const right = revisedWords.map((word) => word.toLocaleLowerCase('en-US'));
  const previous = new Uint32Array(right.length + 1);
  const current = new Uint32Array(right.length + 1);
  for (const word of left) {
    for (let index = 1; index <= right.length; index += 1) current[index] = word === right[index - 1] ? previous[index - 1] + 1 : Math.max(previous[index], current[index - 1]);
    previous.set(current); current.fill(0);
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

export function safeRevision(original: string, revised: string): { safe: boolean; reasons: string[]; diffRatio: number } {
  const reasons: string[] = [];
  const originalWords = original.trim().split(/\s+/).filter(Boolean);
  const revisedWords = revised.trim().split(/\s+/).filter(Boolean);
  const lengthRatio = originalWords.length ? revisedWords.length / originalWords.length : 0;
  if (!revised.trim() || revisedWords.length < 50) reasons.push('truncated_or_empty');
  if (lengthRatio < 0.9 || lengthRatio > 1.1) reasons.push('word_count_outside_safe_band');
  const diffRatio = normalizedSequenceDiff(originalWords, revisedWords);
  if (diffRatio > 0.2) reasons.push('change_exceeds_twenty_percent');
  const named = (text: string) => [...text.matchAll(/\b[A-Z][a-z]{2,}\b/g)].map((match) => match[0]).sort();
  if (JSON.stringify(named(original)) !== JSON.stringify(named(revised))) reasons.push('named_entities_changed');
  const numbers = (text: string) => text.match(/\b\d+(?:[.,]\d+)?\b/g)?.sort() ?? [];
  if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(revised))) reasons.push('numbers_changed');
  if (/\b(?:placeholder|insert (?:the )?scene|as an ai|here is the revised|(?:chapter|scene|story) outline)\b/i.test(revised)) reasons.push('meta_or_placeholder_text');
  return { safe: reasons.length === 0, reasons, diffRatio };
}
