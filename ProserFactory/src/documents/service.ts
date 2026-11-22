import {assertReleaseMutation,bindReleaseAdmission,type ReleaseMaintenanceAction} from '@/operations/releaseAdmission';
import {assertOwnedStyleReferences,validateManifestSceneStyles,validateSceneOwnedStyles} from './styleAuthority';
import type {DocumentStyleDefinitions} from './style-model';
import {insertSceneSearchIndex,backfillSceneSearchIndexes} from './searchIndex';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, Book, Scene } from '@prisma/client';
import { documentAuthorityEnabled } from './capabilities';
import { databaseService } from '@/lib/database';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { currentWorkflowExecution, withWorkflowLease } from '@/services/workflowExecutionContext';
import { invalidateExport, invalidateStructure } from '@/lib/redis/contentCache';
import { canonicalDocument, documentFromText, projectDocument, replaceDocumentText, regenerateDocumentText, minimalTextEdit, imagesOf, type ProserDocument, type SceneDocumentReference, type DocumentManifest, type DocumentManifestResponse } from './model';
import { validateDocument } from './validation';
import { DocumentError } from './errors';
import { initializeScopeReferences, readScope, restoreBookScopes, captureBookScopes, captureManifestScopes, writeScopeRevision, scopeHash, scopeDocuments, validateScopeMembership } from './scopes';
import { comparableStructure, validateSelectedAssets } from './selectedAssets';
import type { DocumentScopeKind, BookScopeContents } from './scope-model';
import { orderedSceneReferences } from './scope-model';
import { validateBookLayout } from './scopeValidation';
import { stampDocumentReview } from './reviewAttribution';
import { assertOwnedBoundaryEvidence } from './boundaryHistory';
import { assertSceneRestorationIdentityIsolation } from './restorationIdentity';
import { writeRevisionBridge } from './revisionBridge';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { assertSharedResourceOperationCurrent } from '@/services/sharedResourceService';
import { transferredReviewSources } from './scopeTransfer';
import { validateAnchorLineage } from './lineage';
import { parseCommentCandidateDocument, reconcileDocumentComments, assertOwnedCommentEvidence, type CommentSource, type CommentResolution, type ValidatedCommentLineage } from './commentAnchors';
import type { DocumentAnchorLineage, VerifiedDocumentAnchorLineage } from './model';
import { verifyImportedGraph, type ImportedStoryMapping, type RetainedDocxConversion } from './importGraph';
import { persistDocumentReviewAudits, type DocumentReviewAudit } from './reviewResolution';
export { DocumentError } from './errors';
export type { SceneDocumentReference, DocumentManifest } from './model';
export interface DocumentReceipt {
  kind: 'commit';
  operationId: string;
  revisionId: string;
  contentHash: string;
  scenes: Array<SceneDocumentReference & { text: string; document: ProserDocument; restoredFromRevisionId?: string }>;
  status: 'completed';
  anchorLineage?: VerifiedDocumentAnchorLineage[];
}
export interface CatalogPreconditions {
  operationId: string; expectedRevisionId: string; expectedScopes: Partial<Record<DocumentScopeKind, string>>; payload: unknown;
}
export interface CatalogReceipt<T = unknown> {
  kind: 'catalog'; operationId: string; revisionId: string; contentHash: string; manifest: DocumentManifest; result: T; status: 'completed';
  scenes?: DocumentReceipt['scenes'];
  sceneReferences?: SceneDocumentReference[];
}
export type DocumentOrigin = 'manual' | 'ai' | 'workflow' | 'import';
export interface SceneContentInput { sceneId: number; expectedRevisionId: string; document: ProserDocument; restoreFromRevisionId?: string }
export interface CatalogMutation<T> {
  result: T; newDocuments?: Array<{ sceneId: number; document: ProserDocument }>;
  changedDocuments?: SceneContentInput[]; layout?: BookScopeContents['layout'];
  /** Trusted server side records commit with the revision and receipt. */
  recordCommitted?: (tx: Prisma.TransactionClient, receipt: CatalogReceipt<T>) => Promise<void>;
  /** Trusted operation adapters can acknowledge a bounded projection without
   * duplicating complete scene bodies in an operation receipt or HTTP reply. */
  receiptProjection?: 'references';
  /** Server-derived mappings still require exact source/target validation. */
  anchorLineage?: DocumentAnchorLineage[];
  projectCommitted?: (input: { revisionId: string; contentHash: string; manifest: DocumentManifest; scenes: DocumentReceipt['scenes'] }) => T;
  importSource?: { originalId: string; originalSha256: string; previewId: string; reportHash: string };
  /** Server-derived bindings from retained conversion graphs to owned stories. */
  importStoryMappings?: ImportedStoryMapping[];
  /** Only trusted comment review endpoints may supply this resolution action. */
  commentResolution?: CommentResolution;
  /** Only trusted layout-story review endpoints may supply this action. */
  layoutCommentResolution?: CommentResolution & { storyId: string };
  /** Exact server-verified complete layout restoration, never an inferred rebase. */
  restoreLayoutFromRevisionId?: string;
}

export interface DocumentRestoreReceipt {
  kind: 'restore'; operationId: string; revisionId: string; restoredRevisionId: string;
  contentHash: string; scenes: SceneDocumentReference[]; status: 'completed';
}
export interface DocumentCommit {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  scenes: SceneContentInput[];
  anchorLineage?: DocumentAnchorLineage[];
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
export { documentAuthorityEnabled } from './capabilities';

export interface DocumentBackfillOptions {includeDeleted?:boolean;source?:'operator-backfill'}
function archivedOperatorBackfill(options:DocumentBackfillOptions):boolean {
  if (!options.includeDeleted) return false;
  if (options.source !== 'operator-backfill' || currentDocumentMutationContext() || currentWorkflowExecution()) throw new DocumentError('DOCUMENT_OPERATOR_BACKFILL_REQUIRED', 'Archived backfill is restricted to an explicit local operator context.', 403);
  return true;
}
class DocumentService {
  private get db() { return databaseService.client; }
  /** The temporary compatibility writer is the only location allowed to
   * persist legacy prose. It is unreachable after authority activation. */
  private async legacyAdmission(tx: Prisma.TransactionClient, userId: number, bookId: number) {
    if (documentAuthorityEnabled()) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Legacy writes are disabled; use a revision-guarded document commit.', 428);
    await this.owned(tx, userId, bookId); await this.lock(tx, bookId); await this.owned(tx, userId, bookId);
    await this.mutationFence(tx, bookId);
  }
  async legacyCreateScene(tx: Prisma.TransactionClient, userId: number, bookId: number, input: { chapterId: number; sceneNumber: number; prose?: string | null; summary?: string | null; outline?: string | null; selectedImageId?: number | null }): Promise<Scene> {
    await this.legacyAdmission(tx, userId, bookId);
    if (!await tx.chapter.findFirst({ where: { id: input.chapterId, act: { bookId } }, select: { id: true } })) throw new NotFoundError('Chapter not found');
    const { selectedImageId, ...rest } = input;
    return tx.scene.create({ data: { ...rest, selectedImageId: selectedImageId ?? 0, ...(input.prose !== undefined ? { wordCount: projectDocument(documentFromText(input.prose ?? '', randomUUID)).wordCount } : {}) } });
  }
  async legacyWriteScene(userId: number, bookId: number, sceneId: number, patch: { prose?: string | null; summary?: string | null; outline?: string | null; selectedImageId?: number | null }, transaction?: Prisma.TransactionClient): Promise<Scene> {
    const action = async (tx: Prisma.TransactionClient) => {
      await this.legacyAdmission(tx, userId, bookId);
      if (!await tx.scene.findFirst({ where: { id: sceneId, chapter: { act: { bookId } } }, select: { id: true } })) throw new NotFoundError('Scene not found');
      const { selectedImageId, ...rest } = patch;
      const result = await tx.scene.update({ where: { id: sceneId }, data: { ...rest, ...(selectedImageId !== undefined ? { selectedImageId: selectedImageId ?? 0 } : {}), ...(patch.prose !== undefined ? { wordCount: projectDocument(documentFromText(patch.prose ?? '', randomUUID)).wordCount } : {}) } });
      await this.mutationFence(tx, bookId);
      return result;
    };
    return transaction ? action(transaction) : this.transaction(bookId, action);
  }
  private async owned(tx: Prisma.TransactionClient, userId: number, bookId: number, includeDeleted = false) {
    const context = currentDocumentMutationContext();
    if (context && context.userId !== userId) throw new NotFoundError('Book not found');
    const book = await tx.book.findFirst({ where: { id: bookId, userId, deletedAt: includeDeleted ? {} : null } });
    if (!book) throw new NotFoundError('Book not found');
    return book;
  }
  private async lock(tx: Prisma.TransactionClient, bookId: number) {
    await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId} FOR UPDATE`;
  }
  private async verifiedManifest(tx: Prisma.TransactionClient, bookId: number, head: { revisionId: string; manifest: Prisma.JsonValue }): Promise<DocumentManifest> {
    const revision = await tx.bookDocumentRevision.findFirst({ where: { id: head.revisionId, bookId }, select: { contentHash: true } });
    if (!revision || revision.contentHash !== digest(head.manifest)) throw new DocumentError('DOCUMENT_MANIFEST_INVALID', 'Document head checksum is invalid.', 503);
    return structuredClone(head.manifest as unknown as DocumentManifest);
  }
  private async audit(tx: Prisma.TransactionClient, userId: number, bookId: number, action: 'create' | 'update' | 'restore', metadata: unknown) {
    const reference = metadata && typeof metadata === 'object' && 'revisionId' in metadata ? (metadata as { revisionId: string }).revisionId : undefined;
    if (reference) {
      const execution = currentWorkflowExecution();
      const details = metadata as { sceneIds?: number[]; scopes?: Record<string, unknown>; restoredRevisionId?: string };
      const changedScopes: unknown[] = action === 'restore' ? [{ type: 'rollback', revisionId: details.restoredRevisionId }]
        : [...(details.sceneIds ?? []).map((id) => ({ type: 'scene', id })), ...Object.keys(details.scopes ?? {}).map((type) => ({ type }))];
      await writeRevisionBridge(tx, bookId, reference, execution?.runId, execution?.leaseOwner, changedScopes);
    }
    if(metadata&&typeof metadata==='object'&&'operationId' in metadata&&typeof metadata.operationId==='string')await bindReleaseAdmission(tx,'document-operation',metadata.operationId,{bookId,revisionId:reference});
    // A durable revision must never acknowledge without its audit record.
    await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action, metadata: json({ ...(metadata as Record<string, unknown>), authenticatedActor: currentDocumentMutationContext()?.actorGithubId, workflowRunId: currentWorkflowExecution()?.runId }) } });
  }
  private async mutationFence(tx: Prisma.TransactionClient, bookId: number | null) {
    const request = currentDocumentMutationContext(); const execution = currentWorkflowExecution();
    // Detached workflows retain their own persisted lease/cancellation context.
    // The originating HTTP response is not their lifetime authority.
    (execution?.signal ?? request?.signal())?.throwIfAborted();
    const operationId = execution?.sharedResourceOperationId ?? (!execution ? request?.sharedResourceOperationId : undefined);
    if (!operationId) return;
    const operation = await tx.sharedResourceOperation.findUnique({ where: { operationId } });
    if (!operation) throw new DocumentError('DOCUMENT_RESOURCE_FENCE_LOST', 'Mutation resource receipt is unavailable.', 409);
    const claim = JSON.parse(operation.claimJson) as { resources: Array<{ resourceKey: string }> };
    const expected = bookId === null ? 'provider:new:proser' : `provider:proser:${bookId}`;
    if (!claim.resources.some((resource) => resource.resourceKey === expected)) throw new DocumentError('DOCUMENT_RESOURCE_SCOPE_INVALID', 'Mutation resource authority belongs to another book.', 403);
    // Lock the retained fences through commit. A higher generation cannot
    // supersede authority between its last check and these document writes.
    for (const resource of [...claim.resources].sort((left, right) => left.resourceKey < right.resourceKey ? -1 : left.resourceKey > right.resourceKey ? 1 : 0)) await tx.$queryRaw`SELECT resource_key FROM shared_resource_fences WHERE resource_key = ${resource.resourceKey} FOR SHARE`;
    await assertSharedResourceOperationCurrent(operationId, tx, true);
  }
  private transaction<T>(bookId: number, action: (tx: Prisma.TransactionClient) => Promise<T>, releaseRecovery = false, maintenanceAction?:ReleaseMaintenanceAction): Promise<T> {
    const execution = currentWorkflowExecution();
    execution?.signal.throwIfAborted();
    const guarded = async (tx: Prisma.TransactionClient) => {
      await assertReleaseMutation(tx, `book:${bookId}`, releaseRecovery, maintenanceAction);
      await this.mutationFence(tx, bookId);
      await tx.$queryRaw`SELECT set_config('proser.document_book', ${String(bookId)}, true)`;
      const result = await action(tx); await this.mutationFence(tx, bookId); return result;
    };
    return execution ? withWorkflowLease(execution.runId, async (tx) => {
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: execution.runId }, select: { bookId: true } });
      if (run.bookId !== bookId) throw new DocumentError('DOCUMENT_WORKFLOW_SCOPE_INVALID', 'Workflow cannot mutate another book.', 403);
      return guarded(tx);
    })
      : this.db.$transaction(guarded, { timeout: 30_000 });
  }
  /** A new book has no revision precondition yet. Its stable operation ID and
   * authenticated user lock make creation recoverable without duplicate books. */
  async createBook(userId: number, data: { title?: string | null; genre?: string | null; targetAudience?: string | null; summary?: string | null }, operationId: string): Promise<CatalogReceipt<Book>> {
    return this.db.$transaction((tx) => this.createBookRecord(tx, userId, data, operationId), { timeout: 30_000 });
  }
  async createdBookOperation(userId: number, operationId: string) {
    const row = await this.db.documentOperation.findFirst({ where: { id: operationId, userId } });
    if (!row) throw new NotFoundError('Book creation operation not found');
    await this.owned(this.db, userId, row.bookId, true);
    const receipt = row.receipt as unknown as CatalogReceipt<Book>;
    const revision = await this.db.bookDocumentRevision.findFirst({ where: { id: receipt.revisionId, bookId: row.bookId, operationId, parentRevisionId: null } });
    if (!revision || receipt.kind !== 'catalog' || receipt.result.id !== row.bookId || receipt.result.userId !== userId)
      throw new NotFoundError('Book creation operation not found');
    return { operationId, bookId: row.bookId, title: receipt.result.title, revisionId: receipt.revisionId, status: 'completed' as const };
  }
  /** Trusted composition point: workflow admission creates its book, document
   * authority and workflow/outbox rows in the same caller transaction. */
  async createBookRecord(tx: Prisma.TransactionClient, userId: number, data: { title?: string | null; genre?: string | null; targetAudience?: string | null; summary?: string | null; draftStatus?: string }, operationId: string): Promise<CatalogReceipt<Book>> {
    if (!/^[a-f0-9-]{36}$/.test(operationId ?? '')) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'A creation operation ID is required.', 428);
    if (currentWorkflowExecution()) throw new DocumentError('DOCUMENT_WORKFLOW_SCOPE_INVALID', 'A running book workflow cannot create another book.', 403);
    if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_COMMIT_TOO_LARGE', 'Book creation exceeds 8 MiB.', 413);
    const requestHash = digest({ command: 'create-book', userId, data });
    const request = currentDocumentMutationContext();
    if (request && request.userId !== userId) throw new NotFoundError('User not found');
    await assertReleaseMutation(tx, 'book:new');
    await this.mutationFence(tx, null);
    const rows = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundError('User not found');
    const previous = await tx.documentOperation.findUnique({ where: { id: operationId } });
    if (previous) {
      if (previous.userId !== userId || previous.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Creation operation ID was already used for different content.', 409);
      return previous.receipt as unknown as CatalogReceipt<Book>;
    }
    const book = await tx.book.create({ data: { ...data, userId, draftStatus: data.draftStatus ?? 'draft' } });
    await tx.$queryRaw`SELECT set_config('proser.document_book', ${String(book.id)}, true)`;
    const manifest: DocumentManifest = { schemaVersion: 1, scenes: [], scopes: await initializeScopeReferences(tx, book.id, userId) };
    const revisionId = randomUUID(); const contentHash = digest(manifest);
    await tx.bookDocumentRevision.create({ data: { id: revisionId, bookId: book.id, actorId: userId, operationId, contentHash, manifest: json(manifest) } });
    await tx.bookDocumentHead.create({ data: { bookId: book.id, revisionId, manifest: json(manifest) } });
    const receipt: CatalogReceipt<Book> = { kind: 'catalog', operationId, revisionId, contentHash, manifest, result: book, status: 'completed' };
    await tx.documentOperation.create({ data: { id: operationId, bookId: book.id, userId, requestHash, receipt: json(receipt) } });
    await this.audit(tx, userId, book.id, 'create', { operationId, revisionId, contentHash, origin: 'manual' });
    await this.mutationFence(tx, null);
    return receipt;
  }
  async assertMutationAuthority(userId: number, bookId: number, expectedRevisionId: string) {
    return this.transaction(bookId, async (tx) => {
      await this.owned(tx, userId, bookId); await this.lock(tx, bookId);
      const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
      if (!head || head.revisionId !== expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Source changed before inference admission.', 412, { currentRevisionId: head?.revisionId });
    });
  }
  /** Canonical side records use the same authenticated/resource/workflow fences
   * and book lock as document changes. They do not advance the content head. */
  async sideRecord<T>(userId: number, bookId: number, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.transaction(bookId, async (tx) => {
      await this.owned(tx, userId, bookId, true); await this.lock(tx, bookId);
      await this.owned(tx, userId, bookId, true);
      return action(tx);
    }, true);
  }
  private async operatorTransaction<T>(userId:number,bookId:number,maintenanceAction:ReleaseMaintenanceAction,action:(tx:Prisma.TransactionClient)=>Promise<T>){
    if(currentDocumentMutationContext()||currentWorkflowExecution())throw new DocumentError('DOCUMENT_OPERATOR_REQUIRED','Release maintenance is restricted to a local operator.',403);
    return this.transaction(bookId,async tx=>{await this.owned(tx,userId,bookId,true);await this.lock(tx,bookId);return action(tx);},false,maintenanceAction);
  }
  async registerSelectedArtworkForRelease(userId:number,bookId:number){return this.operatorTransaction(userId,bookId,'register-selected-artwork',async tx=>(await import('./selectedAssetBackfill')).registerSelectedArtworkEvidence(tx,userId,bookId,true));}
  async recoverSearchIndexForRelease(userId:number,bookId:number,after?:string){return this.operatorTransaction(userId,bookId,'recover-search-index',tx=>backfillSceneSearchIndexes(tx,bookId,{after,limit:8,apply:true}));}
  /** Cancellation and application serialize on the same book lock. An already
   * committed result remains committed; cancellation never rolls it back. */
  async cancelInference(userId: number, bookId: number, operationId: string) {
    return this.transaction(bookId, async (tx) => {
      await this.owned(tx, userId, bookId, true); await this.lock(tx, bookId);
      const row = await tx.documentInferenceOperation.findFirst({ where: { id: operationId, bookId, userId } });
      if (!row) throw new NotFoundError('Generation operation not found');
      const applied = await tx.documentOperation.findUnique({ where: { id: operationId } });
      if (applied || ['cancelled', 'failed', 'unknown'].includes(row.status)) return { operationId, status: row.status, application: applied ? 'committed' : 'unapplied' };
      await tx.documentInferenceOperation.update({ where: { id: operationId }, data: { status: 'cancelled', errorCode: 'CANCELLED_BY_OWNER', completedAt: new Date() } });
      await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: { operationId, action: 'cancel-document-inference', authenticatedActor: currentDocumentMutationContext()?.actorGithubId } } });
      return { operationId, status: 'cancelled', application: 'unapplied' };
    }, true);
  }
  private async assertInferenceApplication(tx: Prisma.TransactionClient, userId: number, bookId: number, operationId: string, origin: DocumentOrigin) {
    const inference = await tx.documentInferenceOperation.findUnique({ where: { id: operationId } });
    if (!inference) return;
    if (inference.userId !== userId || inference.bookId !== bookId || origin === 'manual') throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Inference operation cannot be used for another document mutation.', 409);
    if (inference.status !== 'completed') throw new DocumentError('DOCUMENT_INFERENCE_CANCELLED', 'The retained provider operation cannot be applied.', 409, { operationId, status: inference.status });
  }
  async ensureRevisionBridge(userId: number, bookId: number, revisionId?: string, changedScopes: unknown[] = [], options: DocumentBackfillOptions = {}) {
    const includeDeleted = archivedOperatorBackfill(options);
    return this.transaction(bookId, async (tx) => {
      await this.owned(tx, userId, bookId, includeDeleted); await this.lock(tx, bookId);
      const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
      if (!head) throw new DocumentError('DOCUMENT_NOT_MIGRATED', 'Book document authority is not initialized.', 409);
      const execution = currentWorkflowExecution();
      return writeRevisionBridge(tx, bookId, revisionId ?? head.revisionId, execution?.runId, execution?.leaseOwner, changedScopes);
    }, false, 'verify-document-bridge');
  }
  /** Explicit backfill only. Reads never silently create authority under a read-only grant. */
  async initialize(userId: number, bookId: number, options: DocumentBackfillOptions = {}): Promise<string> {
    const includeDeleted = archivedOperatorBackfill(options);
    return this.transaction(bookId, async (tx) => {
      await this.owned(tx, userId, bookId, includeDeleted); await this.lock(tx, bookId);
      await this.owned(tx, userId, bookId, includeDeleted);
      const existing = await tx.bookDocumentHead.findUnique({ where: { bookId } });
      if (existing && (existing.manifest as unknown as DocumentManifest).scopes) {
        const manifest = existing.manifest as unknown as DocumentManifest;
        const references = manifest.scopes!;
        const preserved = { structure: await readScope(tx, bookId, 'structure', references.structure), canon: await readScope(tx, bookId, 'canon', references.canon), layout: await readScope(tx, bookId, 'layout', references.layout) };
        for (const document of scopeDocuments(preserved)) assertOwnedStyleReferences(validateDocument(document), preserved.layout.styles);
        const physical = await captureBookScopes(tx, bookId);
        const current = await captureManifestScopes(tx, bookId, preserved, physical);
        // Older schema-1 scope records omitted the optional active lifecycle
        // field. Compare its null default without rewriting historical hashes.
        const expectedStructure = { ...preserved.structure, book: { ...preserved.structure.book, deletedAt: preserved.structure.book.deletedAt ?? null } };
        if (scopeHash(current.structure) !== scopeHash(expectedStructure) || scopeHash(current.canon) !== references.canon.contentHash) throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'Legacy catalog writes changed the migrated book. Reconcile them before activation.', 409);
        for (const reference of [...manifest.scenes, ...(manifest.retiredScenes ?? [])]) {
          const row = await tx.scene.findFirst({ where: { id: reference.sceneId, deletedAt: {}, chapter: { act: { bookId } } } });
          const body = await tx.sceneDocumentRevision.findFirst({ where: { id: reference.revisionId, sceneId: reference.sceneId, bookId } });
          if (!row || !body || body.contentHash !== reference.contentHash || digest(body.document) !== reference.contentHash) throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'Migrated body identity/checksum is unavailable.', 409);
          const document = validateDocument(body.document);
          assertOwnedStyleReferences(document, preserved.layout.styles);
          const projection = projectDocument(document);
          if ((row.prose ?? '') !== projection.text || row.wordCount !== projection.wordCount || row.chapterId !== reference.chapterId || row.sceneNumber !== reference.sceneNumber || (row.deletedAt?.toISOString() ?? null) !== (reference.deletedAt ?? null)) throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'Legacy body/projection writes changed the migrated book. Reconcile them before activation.', 409);
        }
        await writeRevisionBridge(tx, bookId, existing.revisionId);
        return existing.revisionId;
      }
      const previousManifest = existing?.manifest as unknown as DocumentManifest | undefined;
      const scenes = await tx.scene.findMany({ where: { deletedAt: {}, chapter: { act: { bookId } } }, orderBy: [{ chapter: { act: { actNumber: 'asc' } } }, { chapter: { chapterNumber: 'asc' } }, { sceneNumber: 'asc' }] });
      const references: SceneDocumentReference[] = [];
      for (const scene of scenes) {
        const previous = previousManifest?.scenes.find((reference) => reference.sceneId === scene.id);
        if (previous) {
          const revision = await tx.sceneDocumentRevision.findUniqueOrThrow({ where: { id: previous.revisionId } });
          if (digest(revision.document) !== previous.contentHash || (scene.prose ?? '') !== projectDocument(validateDocument(revision.document)).text) throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'Reconcile existing document authority before completing backfill.', 409);
          references.push({ ...previous, chapterId: scene.chapterId, sceneNumber: scene.sceneNumber, deletedAt: scene.deletedAt?.toISOString() ?? null });
          continue;
        }
        const document = validateDocument(documentFromText(scene.prose ?? '', randomUUID));
        const contentHash = digest(document); const revisionId = randomUUID();
        await tx.sceneDocumentRevision.create({ data: { id: revisionId, bookId, sceneId: scene.id, schemaVersion: 1, contentHash, document: json(document), originalProse: scene.prose, actorId: userId, origin: 'backfill' } });
        await insertSceneSearchIndex(tx, { revisionId, bookId, sceneId: scene.id, contentHash, document });
        const projection = projectDocument(document);
        // Avoid changing @updatedAt on an already-correct legacy projection.
        if (scene.wordCount !== projection.wordCount) await tx.scene.update({ where: { id: scene.id }, data: { wordCount: projection.wordCount } });
        references.push({ sceneId: scene.id, chapterId: scene.chapterId, sceneNumber: scene.sceneNumber, revisionId, contentHash, wordCount: projection.wordCount, deletedAt: scene.deletedAt?.toISOString() ?? null });
      }
      const manifest: DocumentManifest = { schemaVersion: 1, scenes: references, scopes: await initializeScopeReferences(tx, bookId, userId) };
      const revisionId = randomUUID();
      await tx.bookDocumentRevision.create({ data: { id: revisionId, bookId, parentRevisionId: existing?.revisionId, contentHash: digest(manifest), manifest: json(manifest), actorId: userId, operationId: `backfill:${revisionId}` } });
      await tx.bookDocumentHead.upsert({ where: { bookId }, create: { bookId, revisionId, manifest: json(manifest) }, update: { revisionId, manifest: json(manifest) } });
      await this.audit(tx, userId, bookId, 'create', { origin: 'backfill', revisionId, parentRevisionId: existing?.revisionId, contentHash: digest(manifest), sceneIds: references.map((reference) => reference.sceneId) });
      return revisionId;
    }, false, 'backfill-document-authority');
  }
  async manifest(userId: number, bookId: number): Promise<DocumentManifestResponse> {
    await this.owned(this.db, userId, bookId);
    const head = await this.db.bookDocumentHead.findUnique({ where: { bookId } });
    if (!head) throw new DocumentError('DOCUMENT_NOT_MIGRATED', 'This book has not been migrated to structured documents.', 409);
    const manifest = head.manifest as unknown as DocumentManifest;
    const revision = await this.db.bookDocumentRevision.findFirst({ where: { id: head.revisionId, bookId }, select: { contentHash: true } });
    const contentHash = digest(manifest);
    if (!revision || revision.contentHash !== contentHash) throw new DocumentError('DOCUMENT_MANIFEST_INVALID', 'Document head checksum is invalid.', 503);
    const active = manifest.scenes.filter((reference) => !reference.deletedAt);
    return { ...manifest, revisionId: head.revisionId, contentHash, totals: { projection: 'final' as const, wordCount: active.reduce((sum, reference) => sum + reference.wordCount, 0), sceneCount: active.length } };
  }
  async read(userId: number, bookId: number, sceneId: number) {
    const manifest = await this.manifest(userId, bookId);
    const reference = manifest.scenes.find((item) => item.sceneId === sceneId);
    const scene = await this.db.scene.findFirst({ where: { id: sceneId, deletedAt: null, chapter: { act: { bookId } } } });
    if (!reference || !scene) throw new NotFoundError('Scene document not found');
    const revision = await this.db.sceneDocumentRevision.findFirst({ where: { id: reference.revisionId, bookId, sceneId } });
    if (!revision) throw new DocumentError('DOCUMENT_REVISION_MISSING', 'Document revision is unavailable.', 503);
    const document = validateDocument(revision.document);
    if (revision.contentHash !== reference.contentHash || digest(document) !== reference.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Document checksum does not match its immutable manifest.', 503);
    if (reference.chapterId !== scene.chapterId || reference.sceneNumber !== scene.sceneNumber) throw new DocumentError('DOCUMENT_STRUCTURE_DRIFT', 'A legacy writer changed scene structure. Reconcile authority before editing.', 409);
    if ((scene.prose ?? '') !== projectDocument(document).text) throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'A legacy writer changed this scene. Reconcile authority before editing.', 409);
    return { ...reference, bookRevisionId: manifest.revisionId, document, projection: projectDocument(document) };
  }
  /** Materialize compatibility prose only for an explicitly bound immutable
   * manifest. Capturing a revision itself never serializes the novel. */
  async revisionProjection(userId: number, bookId: number, revisionId: string) {
    await this.owned(this.db, userId, bookId);
    const revision = await this.db.bookDocumentRevision.findFirst({ where: { id: revisionId, bookId } });
    if (!revision || digest(revision.manifest) !== revision.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Projection manifest is unavailable or invalid.', 409);
    const manifest = revision.manifest as unknown as DocumentManifest;
    if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Historical document scope mapping is required.', 409);
    const structure = await readScope(this.db, bookId, 'structure', manifest.scopes.structure);
    const canon = await readScope(this.db, bookId, 'canon', manifest.scopes.canon);
    const scenes = [];
    for (const reference of manifest.scenes.filter((scene) => !scene.deletedAt)) {
      const body = await this.db.sceneDocumentRevision.findFirst({ where: { id: reference.revisionId, bookId, sceneId: reference.sceneId } });
      if (!body || body.contentHash !== reference.contentHash || digest(body.document) !== reference.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Projection body is unavailable or invalid.', 503);
      const metadata = structure.scenes.find((scene) => scene.id === reference.sceneId && !scene.deletedAt);
      if (!metadata || metadata.chapterId !== reference.chapterId || metadata.sceneNumber !== reference.sceneNumber) throw new DocumentError('DOCUMENT_SCOPE_MANIFEST_INVALID', 'Projection membership is invalid.', 503);
      const projection = projectDocument(validateDocument(body.document));
      if (projection.wordCount !== reference.wordCount) throw new DocumentError('DOCUMENT_PROJECTION_INVALID', 'Projection word count is invalid.', 503);
      scenes.push({ id: reference.sceneId, chapterId: reference.chapterId, sceneNumber: reference.sceneNumber, prose: projection.text, summary: metadata.summary, outline: metadata.outline, sourceRevisionId: reference.revisionId, contentHash: reference.contentHash, projection: 'final' as const });
    }
    return { scenes, codex: canon.entries.filter((entry) => !entry.deletedAt), wordCount: manifest.scenes.filter((scene) => !scene.deletedAt).reduce((sum, scene) => sum + scene.wordCount, 0), contentHash: revision.contentHash, sourceRevisionId: revision.id, projection: 'final' as const };
  }
  private async validateAssets(tx: Prisma.TransactionClient, userId: number, bookId: number, document: ProserDocument) {
    for (const image of imagesOf(document)) {
      const asset = await tx.imageAsset.findFirst({ where: { id: image.assetId, userId, bookId } });
      if (!asset) throw new ValidationError('Document image is not owned by this book');
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(asset.configJson ?? '{}') as Record<string, unknown>; } catch { /* Missing digest is never considered verified. */ }
      if (metadata.sha256 !== image.sha256) throw new ValidationError('Document image digest is unverified or mismatched');
    }
  }
  private async writeSceneContent(tx: Prisma.TransactionClient, userId: number, bookId: number, manifest: DocumentManifest, item: SceneContentInput, actorName: string, origin: DocumentOrigin, reviewSource?: ProserDocument, trustedImport = false, reviewOptions?: { operationId: string; sourceBookRevisionId: string; sourceBookContentHash: string; styleDefinitions?: DocumentStyleDefinitions; lineage?: ValidatedCommentLineage[]; sourceDocuments?: CommentSource[]; resolution?: CommentResolution; affectedSceneIds?: ReadonlySet<number> }): Promise<DocumentReceipt['scenes'][number]> {
    const ref = manifest.scenes.find((entry) => entry.sceneId === item.sceneId && !entry.deletedAt);
    if (!ref || ref.revisionId !== item.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'The scene changed. Reconcile your draft before saving.', 412, { sceneId: item.sceneId, currentRevisionId: ref?.revisionId });
    const scene = await tx.scene.findFirst({ where: { id: item.sceneId, deletedAt: null, chapter: { act: { bookId } } } });
    if (!scene) throw new NotFoundError('Scene not found');
    if (scene.chapterId !== ref.chapterId || scene.sceneNumber !== ref.sceneNumber) throw new DocumentError('DOCUMENT_STRUCTURE_DRIFT', 'A legacy writer changed scene structure. Reconcile authority before saving.', 409);
    const document = item.restoreFromRevisionId ? validateDocument(item.document) : parseCommentCandidateDocument(item.document);
    await this.validateAssets(tx, userId, bookId, document);
    const source = await tx.sceneDocumentRevision.findFirst({ where: { id: ref.revisionId, sceneId: item.sceneId, bookId } });
    if (!source || source.contentHash !== ref.contentHash || digest(source.document) !== ref.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Source document checksum is invalid.', 503);
    const previousDocument = validateDocument(source.document);
    if (!item.restoreFromRevisionId && !trustedImport && digest(document.layout) !== digest(previousDocument.layout)) throw new DocumentError('DOCUMENT_LAYOUT_SCOPE_REQUIRED', 'Scene layout is a retained compatibility snapshot. Edit the owned book or chapter layout scope with its revision precondition.', 409);
    const previousProjection = projectDocument(previousDocument);
    let reviewEvents: DocumentReviewAudit[] = [];
    if ((scene.prose ?? '') !== previousProjection.text || scene.wordCount !== previousProjection.wordCount) throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'A legacy writer changed this scene. Reconcile authority before saving.', 409);
    if (item.restoreFromRevisionId) {
      if (origin !== 'manual') throw new DocumentError('DOCUMENT_RESTORATION_INVALID', 'Automated edits cannot claim manual journal restoration.', 409);
      await this.verifySceneRestoration(tx, bookId, item, reviewOptions?.affectedSceneIds);
    }
    else {
      if (!reviewOptions) throw new DocumentError('DOCUMENT_COMMENT_CONTEXT_REQUIRED', 'The document operation must bind its immutable comment source.', 409);
      reconcileDocumentComments(reviewSource ?? previousDocument, document, { sceneId: item.sceneId, revisionId: source.id, contentHash: source.contentHash, document: previousDocument }, { id: userId, name: actorName }, reviewOptions.operationId, reviewOptions);
      reviewEvents = stampDocumentReview(document, reviewSource ?? previousDocument, { id: userId, name: actorName }, origin, trustedImport, { operationId: reviewOptions.operationId, sourceBookRevisionId: reviewOptions.sourceBookRevisionId, sourceContentHash: reviewOptions.sourceBookContentHash, sourceKind: 'scene', sourceSceneId: item.sceneId, sourceSceneRevisionId: source.id, ...(origin === 'workflow' ? { workflowRunId: currentWorkflowExecution()?.runId } : {}), sourceDocuments: reviewOptions.sourceDocuments?.flatMap((source) => source.sourceKind === 'layout-story' ? [] : [{ sceneId: source.sceneId, revisionId: source.revisionId, contentHash: source.contentHash, document: source.document }]) });
    }
    await assertOwnedCommentEvidence(tx, userId, bookId, document);
    await assertOwnedBoundaryEvidence(tx, userId, bookId, document);
    validateDocument(document);
    if (reviewOptions?.styleDefinitions) assertOwnedStyleReferences(document, reviewOptions.styleDefinitions);
    else await validateSceneOwnedStyles(tx, bookId, manifest, document);
    const revisionId = randomUUID(); const contentHash = digest(document); const projection = projectDocument(document);
    await persistDocumentReviewAudits(tx, userId, bookId, revisionId, reviewEvents, currentDocumentMutationContext()?.actorGithubId);
    await tx.sceneDocumentRevision.create({ data: { id: revisionId, bookId, sceneId: item.sceneId, parentRevisionId: ref.revisionId, schemaVersion: 1, contentHash, document: json(document), actorId: userId, origin } });
    await insertSceneSearchIndex(tx, { revisionId, bookId, sceneId: item.sceneId, contentHash, document });
    await tx.scene.update({ where: { id: item.sceneId }, data: { prose: projection.text, wordCount: projection.wordCount } });
    Object.assign(ref, { revisionId, contentHash, wordCount: projection.wordCount });
    if (item.restoreFromRevisionId) await this.audit(tx, userId, bookId, 'update', { action: 'restore-document-scene-scope', sceneId: item.sceneId, sourceRevisionId: source.id, restoredFromRevisionId: item.restoreFromRevisionId, outputRevisionId: revisionId, contentHash });
    return { ...ref, text: projection.text, document, ...(item.restoreFromRevisionId ? { restoredFromRevisionId: item.restoreFromRevisionId } : {}) };
  }
  private async verifySceneRestoration(tx: Prisma.TransactionClient, bookId: number, item: SceneContentInput, affectedSceneIds: ReadonlySet<number> = new Set([item.sceneId])): Promise<ProserDocument> {
    const original = await tx.sceneDocumentRevision.findFirst({ where: { id: item.restoreFromRevisionId, bookId, sceneId: item.sceneId } });
    if (!original || digest(original.document) !== original.contentHash || canonicalDocument(item.document) !== canonicalDocument(original.document)) throw new DocumentError('DOCUMENT_RESTORATION_INVALID', 'Scene restoration requires the exact complete owned immutable revision.', 409);
    const incomplete = await tx.$queryRaw<Array<{ id: string }>>`SELECT m.legacy_revision_id AS id FROM document_legacy_revision_mappings m JOIN book_document_revisions r ON r.id = m.document_revision_id WHERE m.book_id = ${bookId} AND COALESCE(m.fidelity->>'completeDocument', 'false') <> 'true' AND (r.manifest @> jsonb_build_object('scenes', jsonb_build_array(jsonb_build_object('revisionId', ${original.id}::text))) OR r.manifest->'retiredScenes' @> jsonb_build_array(jsonb_build_object('revisionId', ${original.id}::text))) LIMIT 1`;
    if (incomplete.length) throw new DocumentError('DOCUMENT_RESTORATION_INCOMPLETE', 'Historical conversion lacks complete document evidence and cannot authorize restoration.', 409);
    const restored = validateDocument(original.document);
    await assertSceneRestorationIdentityIsolation(tx, bookId, restored, affectedSceneIds);
    return restored;
  }
  private async assertCatalogConsistent(tx: Prisma.TransactionClient, bookId: number, base: BookScopeContents, before: BookScopeContents) {
    const current = await captureManifestScopes(tx, bookId, base, before);
    const expected = { ...base.structure, book: { ...base.structure.book, deletedAt: base.structure.book.deletedAt ?? null } };
    if (scopeHash(comparableStructure(current.structure, base.structure)) !== scopeHash(expected) || scopeHash(current.canon) !== scopeHash(base.canon))
      throw new DocumentError('DOCUMENT_AUTHORITY_DRIFT', 'A legacy writer changed book structure or canon. Reconcile authority before saving.', 409);
  }
  async commit(userId: number, bookId: number, input: DocumentCommit, origin: 'manual' | 'ai' | 'workflow' = 'manual'): Promise<DocumentReceipt> {
    if (input.schemaVersion !== 1 || !input.operationId || !input.expectedRevisionId || !input.scenes?.length || input.scenes.some((item) => !item.expectedRevisionId)) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Document revision and operation preconditions are required.', 428);
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_COMMIT_TOO_LARGE', 'Document request exceeds 8 MiB.', 413);
    if (!/^[a-f0-9-]{36}$/.test(input.operationId) || input.scenes.length > 100) throw new ValidationError('Invalid document operation or scope count');
    if (new Set(input.scenes.map((item) => item.sceneId)).size !== input.scenes.length) throw new ValidationError('Duplicate scene commit');
    const documents = input.scenes.map((item) => ({ ...item, document: item.restoreFromRevisionId ? validateDocument(item.document) : parseCommentCandidateDocument(item.document) }));
    const requestHash = digest({ userId, bookId, input, origin });
    const receipt = await this.transaction(bookId, async (tx) => {
      const book = await this.owned(tx, userId, bookId, true); await this.lock(tx, bookId);
      await this.owned(tx, userId, bookId, true);
      const previous = await tx.documentOperation.findUnique({ where: { id: input.operationId } });
      if (previous) {
        if (previous.bookId !== bookId || previous.userId !== userId || previous.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Operation ID was already used for different content.', 409);
        return previous.receipt as unknown as DocumentReceipt;
      }
      if (book.deletedAt) throw new NotFoundError('Book not found');
      await this.assertInferenceApplication(tx, userId, bookId, input.operationId, origin);
      const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
      if (!head || head.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'The manuscript changed. Reconcile your draft before saving.', 412, { currentRevisionId: head?.revisionId });
      const manifest = await this.verifiedManifest(tx, bookId, head);
      const changed: DocumentReceipt['scenes'] = [];
      let ownedStyleDefinitions: DocumentStyleDefinitions | undefined;
      if (manifest.scopes) {
        const base = { structure: await readScope(tx, bookId, 'structure', manifest.scopes.structure), canon: await readScope(tx, bookId, 'canon', manifest.scopes.canon), layout: await readScope(tx, bookId, 'layout', manifest.scopes.layout) };
        await this.assertCatalogConsistent(tx, bookId, base, await captureBookScopes(tx, bookId));
        ownedStyleDefinitions = base.layout.styles;
      }
      const actor = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });
      const transferScopes = [];
      const restorations = new Map<number, ProserDocument>();
      for (const item of documents) {
        const reference = manifest.scenes.find((scene) => scene.sceneId === item.sceneId && !scene.deletedAt);
        if (!reference || reference.revisionId !== item.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'A scene changed before the atomic document operation.', 412, { sceneId: item.sceneId, currentRevisionId: reference?.revisionId });
        const source = await tx.sceneDocumentRevision.findFirst({ where: { id: item.expectedRevisionId, sceneId: item.sceneId, bookId } });
        if (!source || digest(source.document) !== source.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Transfer source is unavailable or invalid.', 409);
        transferScopes.push({ sceneId: item.sceneId, previous: validateDocument(source.document), next: item.document });
        if (item.restoreFromRevisionId) {
          if (origin !== 'manual') throw new DocumentError('DOCUMENT_RESTORATION_INVALID', 'Automated edits cannot claim manual journal restoration.', 409);
          restorations.set(item.sceneId, await this.verifySceneRestoration(tx, bookId, item, new Set(documents.map(document => document.sceneId))));
        }
      }
      const reviewSources = transferredReviewSources(transferScopes, new Set(restorations.keys()));
      const verifiedLineage = validateAnchorLineage(input.anchorLineage ?? [],transferScopes, restorations);
      const commentSources = transferScopes.map((scope) => ({ sceneId: scope.sceneId, revisionId: documents.find((item) => item.sceneId === scope.sceneId)!.expectedRevisionId, contentHash: digest(scope.previous), document: scope.previous }));
      for (const item of documents) changed.push(await this.writeSceneContent(tx, userId, book.id, manifest, item, actor.username ?? String(userId), origin, reviewSources.get(item.sceneId), false, { operationId: input.operationId, sourceBookRevisionId: head.revisionId, sourceBookContentHash: digest(head.manifest), styleDefinitions: ownedStyleDefinitions, lineage: verifiedLineage, sourceDocuments: commentSources, affectedSceneIds: new Set(documents.map(document => document.sceneId)) }));
      if (manifest.scopes) manifest.scenes = orderedSceneReferences(manifest.scenes, await readScope(tx, bookId, 'structure', manifest.scopes.structure));
      const revisionId = randomUUID(); const contentHash = digest(manifest);
      await tx.bookDocumentRevision.create({ data: { id: revisionId, bookId, parentRevisionId: head.revisionId, contentHash, manifest: json(manifest), actorId: userId, operationId: input.operationId } });
      await tx.bookDocumentHead.update({ where: { bookId }, data: { revisionId, manifest: json(manifest) } });
      const anchorLineage = verifiedLineage.map((mapping) => ({ ...mapping, sourceSceneRevisionId: documents.find((item) => item.sceneId === mapping.source.sceneId)!.expectedRevisionId, targetSceneRevisionId: changed.find((item) => item.sceneId === mapping.target.sceneId)!.revisionId }));
      const result: DocumentReceipt = { kind: 'commit', operationId: input.operationId, revisionId, contentHash, scenes: changed, status: 'completed', ...(anchorLineage.length ? { anchorLineage } : {}) };
      await tx.documentOperation.create({ data: { id: input.operationId, bookId, userId, requestHash, receipt: json(result) } });
      await this.audit(tx, userId, bookId, 'update', { origin, operationId: input.operationId, revisionId, parentRevisionId: head.revisionId, contentHash, sceneIds: changed.map((reference) => reference.sceneId), ...(anchorLineage.length ? { anchorLineage } : {}) });
      return result;
    });
    await Promise.allSettled([invalidateExport(bookId), invalidateStructure(bookId)]);
    return receipt;
  }
  async scope<K extends DocumentScopeKind>(userId: number, bookId: number, kind: K) {
    const manifest = await this.manifest(userId, bookId);
    if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Book scopes need explicit backfill.', 409);
    const reference = manifest.scopes[kind];
    return { ...reference, bookRevisionId: manifest.revisionId, content: await readScope(this.db, bookId, kind, reference) };
  }
  async layoutRevision(userId: number, bookId: number, revisionId: string) {
    await this.owned(this.db, userId, bookId);
    const revision = await this.db.bookDocumentScopeRevision.findFirst({ where: { id: revisionId, bookId, kind: 'layout' } });
    if (!revision) throw new NotFoundError('Document layout revision not found');
    const content = await readScope(this.db, bookId, 'layout', { revisionId: revision.id, contentHash: revision.contentHash });
    return { revisionId: revision.id, contentHash: revision.contentHash, content };
  }
  /** All metadata/structure/canon mutations share the book head, lease fence,
   * receipts and scope references. Only this service writes prose projections. */
  async mutateCatalog<T>(userId: number, bookId: number, input: CatalogPreconditions, action: (tx: Prisma.TransactionClient) => Promise<CatalogMutation<T>>, origin: DocumentOrigin = 'manual'): Promise<CatalogReceipt<T>> {
    if (!input.operationId || !input.expectedRevisionId || !input.expectedScopes) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Book and affected scope revisions and operation ID are required.', 428);
    if (!/^[a-f0-9-]{36}$/.test(input.operationId)) throw new ValidationError('Invalid document operation ID');
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new DocumentError('DOCUMENT_COMMIT_TOO_LARGE', 'Document request exceeds 8 MiB.', 413);
    const requestHash = digest({ kind: 'catalog', userId, bookId, input, origin });
    const receipt = await this.transaction(bookId, async (tx) => {
      const book = await this.owned(tx, userId, bookId, true); await this.lock(tx, bookId); await this.owned(tx, userId, bookId, true);
      const previous = await tx.documentOperation.findUnique({ where: { id: input.operationId } });
      if (previous) {
        if (previous.userId !== userId || previous.bookId !== bookId || previous.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Operation ID was already used for different content.', 409);
        return previous.receipt as unknown as CatalogReceipt<T>;
      }
      if (book.deletedAt) throw new NotFoundError('Book not found');
      await this.assertInferenceApplication(tx, userId, bookId, input.operationId, origin);
      const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
      if (!head || head.revisionId !== input.expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book changed before the catalog mutation.', 412, { currentRevisionId: head?.revisionId });
      const manifest = await this.verifiedManifest(tx, bookId, head);
      if (!manifest.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'Book scopes need explicit backfill.', 409);
      for (const [kind, expected] of Object.entries(input.expectedScopes)) if (!['structure', 'canon', 'layout'].includes(kind) || manifest.scopes[kind as DocumentScopeKind].revisionId !== expected) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Book scope changed before mutation.', 412);
      const actor = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });
      const previousLayout = await readScope(tx, bookId, 'layout', manifest.scopes.layout);
      const base: BookScopeContents = { structure: await readScope(tx, bookId, 'structure', manifest.scopes.structure), canon: await readScope(tx, bookId, 'canon', manifest.scopes.canon), layout: previousLayout };
      const before = await captureBookScopes(tx, bookId);
      await this.assertCatalogConsistent(tx, bookId, base, before);
      const mutation = await action(tx);
      let trustedImport = false;
      let trustedImportedStories = new Set<string>();
      if (origin === 'import' || mutation.importSource) {
        const proof = mutation.importSource;
        if (!proof || origin !== 'import') throw new DocumentError('DOCUMENT_IMPORT_PROVENANCE_REQUIRED', 'Imported attribution requires retained original and preview evidence.', 409);
        const original = await tx.documentImportOriginal.findFirst({ where: { id: proof.originalId, bookId, userId } });
        const preview = await tx.documentImportPreview.findFirst({ where: { id: proof.previewId, originalId: proof.originalId, bookId, userId } });
        const report = preview?.report as { convertedSha256?: string; originalSha256?: string } | undefined;
        if (!original || !preview || original.sha256 !== proof.originalSha256 || createHash('sha256').update(original.bytes).digest('hex') !== proof.originalSha256 || original.byteLength !== original.bytes.length || digest(preview.report) !== proof.reportHash || preview.reportHash !== proof.reportHash || digest(preview.conversion) !== report?.convertedSha256 || report.originalSha256 !== original.sha256 || preview.sourceBookRevision !== head.revisionId) throw new DocumentError('DOCUMENT_IMPORT_PROVENANCE_INVALID', 'Retained import evidence changed or belongs to another source.', 409);
        trustedImportedStories = await verifyImportedGraph(tx, bookId, preview.conversion as unknown as RetainedDocxConversion, [...(mutation.newDocuments ?? []), ...(mutation.changedDocuments ?? [])], mutation.layout, mutation.importStoryMappings, previousLayout);
        trustedImport = true;
      }
      const contents = await captureManifestScopes(tx, bookId, base, before);
      contents.layout = mutation.layout ? validateBookLayout(mutation.layout, { commentCandidates: true }) : previousLayout;
      const layoutRestoration = mutation.restoreLayoutFromRevisionId;
      if (layoutRestoration) {
        if (origin !== 'manual' || !input.expectedScopes.layout || !mutation.layout) throw new DocumentError('DOCUMENT_RESTORATION_INVALID', 'Layout restoration requires an exact manual scope commit.', 409);
        const original = await tx.bookDocumentScopeRevision.findFirst({ where: { id: layoutRestoration, bookId, kind: 'layout' } });
        if (!original || original.contentHash !== digest(original.content) || digest(contents.layout) !== original.contentHash) throw new DocumentError('DOCUMENT_RESTORATION_INVALID', 'Layout restoration requires the exact complete owned immutable revision.', 409);
        const incomplete = await tx.$queryRaw<Array<{ id: string }>>`SELECT m.legacy_revision_id AS id FROM document_legacy_revision_mappings m JOIN book_document_revisions r ON r.id=m.document_revision_id WHERE m.book_id=${bookId} AND COALESCE(m.fidelity->>'completeDocument','false') <> 'true' AND r.manifest#>>'{scopes,layout,revisionId}'=${layoutRestoration} LIMIT 1`;
        if (incomplete.length) throw new DocumentError('DOCUMENT_RESTORATION_INCOMPLETE', 'Historical conversion lacks complete layout evidence and cannot authorize restoration.', 409);
      }
      const previousStories = new Map([...previousLayout.frontMatter, ...previousLayout.backMatter, ...(previousLayout.headerFooterStories ?? [])].map((story) => [story.id, story.document]));
      const stories = [...contents.layout.frontMatter, ...contents.layout.backMatter, ...(contents.layout.headerFooterStories ?? [])];
      const layoutReviewEvents: DocumentReviewAudit[] = [];
      const storyIds = new Set(stories.map((story) => story.id));
      for (const [id, old] of previousStories) if (!layoutRestoration && !storyIds.has(id) && (old.comments.some((comment) => !comment.resolved) || old.changes.some((change) => change.status === 'pending'))) throw new DocumentError('DOCUMENT_STORY_REVIEW_UNRESOLVED', 'Resolve retained comments and changes before removing their layout story.', 409);
      for (const story of stories) {
        story.document = parseCommentCandidateDocument(story.document);
        const previousStory = previousStories.get(story.id);
        if (!layoutRestoration) reconcileDocumentComments(previousStory ?? documentFromText('', randomUUID), story.document, { sourceKind: 'layout-story', storyId: story.id, revisionId: manifest.scopes.layout.revisionId, contentHash: manifest.scopes.layout.contentHash, ...(previousStory ? { document: previousStory } : {}) }, { id: userId, name: actor.username ?? String(userId) }, input.operationId, { resolution: mutation.layoutCommentResolution?.storyId === story.id ? mutation.layoutCommentResolution : undefined });
        const importedStory = trustedImportedStories.has(story.id);
        if (!layoutRestoration) layoutReviewEvents.push(...stampDocumentReview(story.document, previousStory, { id: userId, name: actor.username ?? String(userId) }, importedStory ? 'import' : origin, importedStory, { operationId: input.operationId, sourceBookRevisionId: head.revisionId, sourceContentHash: digest(head.manifest), sourceKind: 'layout-story', sourceStoryId: story.id, sourceLayoutRevisionId: manifest.scopes.layout.revisionId, ...(origin === 'workflow' ? { workflowRunId: currentWorkflowExecution()?.runId } : {}) }));
      }
      await assertOwnedCommentEvidence(tx, userId, bookId, stories.map((story) => story.document));
      await assertOwnedBoundaryEvidence(tx, userId, bookId, stories.map((story) => story.document));
      contents.layout = validateBookLayout(contents.layout);
      for (const document of scopeDocuments(contents)) assertOwnedStyleReferences(validateDocument(document), contents.layout.styles);
      if (digest(previousLayout.styles) !== digest(contents.layout.styles)) await validateManifestSceneStyles(tx, bookId, manifest, contents.layout.styles, new Map((mutation.changedDocuments ?? []).map((item) => [item.sceneId, item.document])));
      for (const chapterId of Object.keys(contents.layout.chapters)) if (!contents.structure.chapters.some((chapter) => chapter.id === Number(chapterId))) throw new ValidationError('Chapter layout is not owned by the book');
      for (const document of scopeDocuments(contents)) await this.validateAssets(tx, userId, bookId, validateDocument(document));
      if (manifest.scenes.some((reference) => !contents.structure.scenes.some((scene) => scene.id === reference.sceneId))) throw new DocumentError('DOCUMENT_HARD_DELETE_FORBIDDEN', 'Tombstone scene identities instead of deleting them.', 409);
      validateScopeMembership(contents);
      await validateSelectedAssets(tx, bookId, contents.structure, base.structure);
      const fresh = new Map((mutation.newDocuments ?? []).map((item) => [item.sceneId, validateDocument(item.document)]));
      if (fresh.size !== (mutation.newDocuments?.length ?? 0)) throw new ValidationError('Duplicate new scene document');
      for (const scene of contents.structure.scenes) {
        let reference = manifest.scenes.find((item) => item.sceneId === scene.id);
        const retired = manifest.retiredScenes?.find((item) => item.sceneId === scene.id);
        if (!reference && retired) {
          reference = { ...retired };
          manifest.scenes.push(reference);
          manifest.retiredScenes = manifest.retiredScenes?.filter((item) => item.sceneId !== scene.id);
        }
        if (reference) {
          if (fresh.has(scene.id)) throw new DocumentError('DOCUMENT_SCOPE_BODY_CONFLICT', 'Existing scene bodies require a document commit.', 409);
          Object.assign(reference, { chapterId: scene.chapterId, sceneNumber: scene.sceneNumber, deletedAt: scene.deletedAt });
        } else {
          const row = await tx.scene.findUniqueOrThrow({ where: { id: scene.id }, select: { prose: true } });
          if (row.prose !== null) throw new DocumentError('DOCUMENT_SCOPE_BODY_CONFLICT', 'Scene creation must provide its document through the document service.', 409);
          const document = fresh.get(scene.id) ?? validateDocument(documentFromText('', randomUUID));
          const newReviewEvents = stampDocumentReview(document, undefined, { id: userId, name: actor.username ?? String(userId) }, origin, trustedImport, { operationId: input.operationId, sourceBookRevisionId: head.revisionId, sourceContentHash: digest(head.manifest), sourceKind: 'scene-creation', sourceSceneId: scene.id, ...(origin === 'workflow' ? { workflowRunId: currentWorkflowExecution()?.runId } : {}) });
          await this.validateAssets(tx, userId, bookId, document);
          assertOwnedStyleReferences(document, contents.layout.styles);
          const revisionId = randomUUID(); const contentHash = digest(document); const projection = projectDocument(document);
          await persistDocumentReviewAudits(tx, userId, bookId, revisionId, newReviewEvents, currentDocumentMutationContext()?.actorGithubId);
          await tx.sceneDocumentRevision.create({ data: { id: revisionId, bookId, sceneId: scene.id, schemaVersion: 1, contentHash, document: json(document), originalProse: null, actorId: userId, origin } });
          await insertSceneSearchIndex(tx, { revisionId, bookId, sceneId: scene.id, contentHash, document });
          await tx.scene.update({ where: { id: scene.id }, data: { prose: projection.text, wordCount: projection.wordCount } });
          manifest.scenes.push({ sceneId: scene.id, chapterId: scene.chapterId, sceneNumber: scene.sceneNumber, revisionId, contentHash, wordCount: projection.wordCount, deletedAt: scene.deletedAt });
        }
      }
      if ([...fresh.keys()].some((id) => !contents.structure.scenes.some((scene) => scene.id === id))) throw new ValidationError('New document scene is not owned by this book');
      for (const kind of ['structure', 'canon', 'layout'] as const) if (scopeHash(contents[kind]) !== manifest.scopes[kind].contentHash) {
        if (!input.expectedScopes[kind]) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', `Expected ${kind} revision is required for this mutation.`, 428);
        manifest.scopes[kind] = await writeScopeRevision(tx, bookId, userId, kind, contents[kind], manifest.scopes[kind].revisionId);
      }
      await persistDocumentReviewAudits(tx, userId, bookId, manifest.scopes.layout.revisionId, layoutReviewEvents, currentDocumentMutationContext()?.actorGithubId);
      const changed: DocumentReceipt['scenes'] = [];
      const changedDocuments = mutation.changedDocuments ?? [];
      if (new Set(changedDocuments.map((item) => item.sceneId)).size !== changedDocuments.length) throw new ValidationError('Duplicate scene content mutation');
      const lineageSources = await Promise.all(changedDocuments.map(async item => {
        const row = await tx.sceneDocumentRevision.findFirst({ where: { id: item.expectedRevisionId, bookId, sceneId: item.sceneId } });
        if (!row || digest(row.document) !== row.contentHash) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'Lineage immutable source is unavailable.', 412);
        return { sceneId: item.sceneId, previous: validateDocument(row.document), next: parseCommentCandidateDocument(item.document), revisionId: row.id, contentHash: row.contentHash };
      }));
      const catalogReviewSources = transferredReviewSources(lineageSources, new Set(changedDocuments.filter(document=>document.restoreFromRevisionId).map(document=>document.sceneId)));
      const verifiedCatalogLineage = validateAnchorLineage(mutation.anchorLineage ?? [], lineageSources);
      const catalogCommentSources: CommentSource[] = lineageSources.map(source => ({ sceneId: source.sceneId, revisionId: source.revisionId, contentHash: source.contentHash, document: source.previous }));
      for (const item of changedDocuments) {
        if (!item.expectedRevisionId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Expected scene revision is required.', 428);
        changed.push(await this.writeSceneContent(tx, userId, bookId, manifest, item, actor.username ?? String(userId), origin, catalogReviewSources.get(item.sceneId), trustedImport, { operationId: input.operationId, sourceBookRevisionId: head.revisionId, sourceBookContentHash: digest(head.manifest), styleDefinitions: contents.layout.styles, resolution: mutation.commentResolution, lineage: verifiedCatalogLineage, sourceDocuments: catalogCommentSources, affectedSceneIds: new Set(changedDocuments.map(document => document.sceneId)) }));
      }
      manifest.scenes = orderedSceneReferences(manifest.scenes, contents.structure);
      const revisionId = randomUUID(); const contentHash = digest(manifest);
      await tx.bookDocumentRevision.create({ data: { id: revisionId, bookId, parentRevisionId: head.revisionId, actorId: userId, operationId: input.operationId, contentHash, manifest: json(manifest) } });
      await tx.bookDocumentHead.update({ where: { bookId }, data: { revisionId, manifest: json(manifest) } });
      const projected = mutation.projectCommitted ? mutation.projectCommitted({ revisionId, contentHash, manifest, scenes: changed }) : mutation.result;
      const result: CatalogReceipt<T> = { kind: 'catalog', operationId: input.operationId, revisionId, contentHash, manifest, result: projected, status: 'completed', ...(changed.length ? mutation.receiptProjection === 'references' ? { sceneReferences: changed.map(({ sceneId, chapterId, sceneNumber, revisionId, contentHash, wordCount, deletedAt }) => ({ sceneId, chapterId, sceneNumber, revisionId, contentHash, wordCount, ...(deletedAt ? { deletedAt } : {}) })) } : { scenes: changed } : {}) };
      await tx.documentOperation.create({ data: { id: input.operationId, userId, bookId, requestHash, receipt: json(result) } });
      await this.audit(tx, userId, bookId, 'update', { origin, operationId: input.operationId, revisionId, parentRevisionId: head.revisionId, contentHash, scopes: input.expectedScopes, sceneIds: changed.map((reference) => reference.sceneId), ...(trustedImport ? { importSource: mutation.importSource } : {}), ...(layoutRestoration ? { action: 'restore-document-layout-scope', restoredFromLayoutRevisionId: layoutRestoration } : {}) });
      await mutation.recordCommitted?.(tx, result);
      return result;
    });
    await Promise.allSettled([invalidateExport(bookId), invalidateStructure(bookId)]);
    return receipt;
  }
  async operation(userId: number, bookId: number, operationId: string): Promise<DocumentReceipt | DocumentRestoreReceipt | CatalogReceipt> {
    await this.owned(this.db, userId, bookId, true);
    const operation = await this.db.documentOperation.findFirst({ where: { id: operationId, bookId, userId } });
    if (!operation) throw new NotFoundError('Document operation not found');
    return operation.receipt as unknown as DocumentReceipt | DocumentRestoreReceipt | CatalogReceipt;
  }
  async restore(userId: number, bookId: number, revisionId: string, expectedRevisionId: string, operationId: string) {
    if (!expectedRevisionId || !/^[a-f0-9-]{36}$/.test(operationId)) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Revision and operation preconditions are required.', 428);
    const requestHash = digest({ kind: 'restore', userId, bookId, revisionId, expectedRevisionId });
    const result = await this.transaction(bookId, async (tx) => {
      await this.owned(tx, userId, bookId, true); await this.lock(tx, bookId);
      await this.owned(tx, userId, bookId, true);
      const existing = await tx.documentOperation.findUnique({ where: { id: operationId } });
      if (existing) {
        if (existing.userId !== userId || existing.bookId !== bookId || existing.requestHash !== requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT', 'Operation ID was already used for different content.', 409);
        return existing.receipt as unknown as DocumentRestoreReceipt;
      }
      const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
      if (!head || head.revisionId !== expectedRevisionId) throw new DocumentError('DOCUMENT_SOURCE_STALE', 'The manuscript changed before restoration.', 412, { currentRevisionId: head?.revisionId });
      const revision = await tx.bookDocumentRevision.findFirst({ where: { id: revisionId, bookId } });
      if (!revision) throw new NotFoundError('Document revision not found');
      await this.verifiedManifest(tx, bookId, head);
      if (digest(revision.manifest) !== revision.contentHash) throw new DocumentError('DOCUMENT_MANIFEST_INVALID', 'Restoration source checksum is invalid.', 503);
      const target = structuredClone(revision.manifest as unknown as DocumentManifest);
      const historical = await tx.documentLegacyRevisionMapping.findFirst({ where: { bookId, documentRevisionId: revisionId } });
      if ((historical?.fidelity as { completeDocument?: boolean } | undefined)?.completeDocument === false) throw new DocumentError('DOCUMENT_LEGACY_RESTORE_INCOMPLETE', 'This historical conversion lacks complete document/layout evidence. Review its fidelity report; automatic restoration is blocked.', 409);
      if (!target.scopes) throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED', 'This historical manifest predates complete scope authority. Its preserved mapping must be completed before restoration.', 409);
      const layout = await readScope(tx, bookId, 'layout', target.scopes.layout);
      const layoutDocuments = scopeDocuments({ layout });
      for (const document of layoutDocuments) { await this.validateAssets(tx, userId, bookId, validateDocument(document)); assertOwnedStyleReferences(validateDocument(document), layout.styles); }
      await assertOwnedCommentEvidence(tx, userId, bookId, layoutDocuments);
      await assertOwnedBoundaryEvidence(tx, userId, bookId, layoutDocuments);
      const restored = await restoreBookScopes(tx, bookId, target.scopes);
      if (restored.structure.scenes.length !== target.scenes.length || restored.structure.scenes.some((scene) => !target.scenes.some((reference) => reference.sceneId === scene.id && reference.chapterId === scene.chapterId && reference.sceneNumber === scene.sceneNumber && (reference.deletedAt ?? null) === scene.deletedAt))) throw new DocumentError('DOCUMENT_SCOPE_MANIFEST_INVALID', 'Body references disagree with the preserved structure.', 409);
      // Reuse immutable revision references. Never serialize an entire book into
      // the commit request/response or restamp its historical attribution.
      for (const reference of target.scenes) {
        const source = await tx.sceneDocumentRevision.findFirst({ where: { id: reference.revisionId, bookId, sceneId: reference.sceneId } });
        if (!source) throw new DocumentError('DOCUMENT_REVISION_MISSING', 'Restoration source is unavailable.', 409);
        const document = validateDocument(source.document);
        if (source.contentHash !== reference.contentHash || digest(document) !== reference.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Restoration document checksum is invalid.', 503);
        await this.validateAssets(tx, userId, bookId, document);
        assertOwnedStyleReferences(document, layout.styles);
        await assertOwnedCommentEvidence(tx, userId, bookId, document);
    await assertOwnedBoundaryEvidence(tx, userId, bookId, document);
        const projection = projectDocument(document);
        await tx.scene.update({ where: { id: reference.sceneId }, data: { prose: projection.text, wordCount: projection.wordCount } });
      }
      const retained = new Map((target.retiredScenes ?? []).map((reference) => [reference.sceneId, reference]));
      const currentManifest = head.manifest as unknown as DocumentManifest;
      for (const reference of [...currentManifest.scenes, ...(currentManifest.retiredScenes ?? [])]) if (!target.scenes.some((scene) => scene.sceneId === reference.sceneId)) {
        const tombstone = await tx.scene.findFirst({ where: { id: reference.sceneId, deletedAt: {} }, select: { chapterId: true, sceneNumber: true, deletedAt: true } });
        if (!tombstone?.deletedAt) throw new DocumentError('DOCUMENT_RESTORE_MEMBERSHIP_INVALID', 'A superseded scene was not safely tombstoned.', 409);
        retained.set(reference.sceneId, { ...reference, chapterId: tombstone.chapterId, sceneNumber: tombstone.sceneNumber, deletedAt: tombstone.deletedAt.toISOString() });
      }
      if (retained.size) target.retiredScenes = [...retained.values()].sort((left, right) => left.sceneId - right.sceneId);
      target.scenes = orderedSceneReferences(target.scenes, restored.structure);
      const nextRevisionId = randomUUID(); const contentHash = digest(target);
      await tx.bookDocumentRevision.create({ data: { id: nextRevisionId, bookId, parentRevisionId: head.revisionId, contentHash, manifest: json(target), actorId: userId, operationId } });
      await tx.bookDocumentHead.update({ where: { bookId }, data: { revisionId: nextRevisionId, manifest: json(target) } });
      const receipt: DocumentRestoreReceipt = { kind: 'restore', operationId, revisionId: nextRevisionId, restoredRevisionId: revisionId, contentHash, scenes: target.scenes, status: 'completed' };
      await tx.documentOperation.create({ data: { id: operationId, bookId, userId, requestHash, receipt: json(receipt) } });
      await this.audit(tx, userId, bookId, 'restore', { operationId, revisionId: nextRevisionId, restoredRevisionId: revisionId, parentRevisionId: head.revisionId, contentHash });
      return receipt;
    });
    await Promise.allSettled([invalidateExport(bookId), invalidateStructure(bookId)]);
    return result;
  }
  /** Build an exact formatting-aware replacement from an immutable source.
   * The caller supplies the source revision captured before inference. */
  async replacementDocument(tx: Prisma.TransactionClient, bookId: number, sceneId: number, sourceRevisionId: string, text: string, userId: number, origin: DocumentOrigin, regeneration = false): Promise<ProserDocument> {
    const sourceRevision = await tx.sceneDocumentRevision.findFirst({ where: { id: sourceRevisionId, bookId, sceneId } });
    if (!sourceRevision || digest(sourceRevision.document) !== sourceRevision.contentHash) throw new DocumentError('DOCUMENT_REVISION_INVALID', 'Replacement source is unavailable or invalid.', 409);
    const document = validateDocument(sourceRevision.document); const source = projectDocument(document).text;
    if (source === text) return document;
    const { start, end, replacement } = minimalTextEdit(source, text);
    try {
      if (regeneration || (!source && origin !== 'manual')) return regenerateDocumentText(document, text, randomUUID, { authorId: userId, authorName: String(userId), createdAt: new Date().toISOString(), status: origin === 'workflow' ? 'accepted' : 'pending', origin });
      return replaceDocumentText(document, start, end, source.slice(start, end), replacement, randomUUID,
        origin === 'manual' ? undefined : { authorId: userId, authorName: String(userId), createdAt: new Date().toISOString(), status: origin === 'workflow' ? 'accepted' : 'pending', origin });
    } catch (error) { throw new DocumentError('DOCUMENT_RECONCILIATION_REQUIRED', error instanceof Error ? error.message : 'A structured revision is required.', 409); }
  }
  /** Compatibility commands use stable request hashes and recover their original
   * receipt before recomputing generated identities or retrying a mutation. */
  async replaceProse(userId: number, bookId: number, sceneId: number, text: string, expectedRevisionId: string, expectedSceneRevisionId: string, origin: DocumentOrigin = 'manual', operationId = randomUUID()) {
    if (!expectedSceneRevisionId) throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED', 'Expected scene revision is required.', 428);
    return this.mutateCatalog(userId, bookId, { operationId, expectedRevisionId, expectedScopes: {}, payload: { command: 'replace-prose', sceneId, text, expectedSceneRevisionId } }, async (tx) => ({
      result: { sceneId }, changedDocuments: [{ sceneId, expectedRevisionId: expectedSceneRevisionId, document: await this.replacementDocument(tx, bookId, sceneId, expectedSceneRevisionId, text, userId, origin) }],
    }), origin);
  }
}
export const documentService = new DocumentService();
