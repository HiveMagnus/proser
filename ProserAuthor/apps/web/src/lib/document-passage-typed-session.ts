import {
  canonicalDocument,
  minimalTextEdit,
  visibleRun,
  type DocumentPassage,
  type DocumentPassageRequest,
  type DocumentPassageReceipt,
  type DocumentPassageOperationCommit,
  type DocumentPassageOperation,
  type DocumentPassageRestore,
  type DocumentPassageRestoreResult,
  type PassageOperationMapping,
  type ProserDocument,
  type DocumentParagraph,
  type SceneDocumentReference,
} from '@cheftaco/proser-contracts';
import { validatePassageSource } from '../../../../packages/editor/src/passage-source';
import { passageDocument, passageDocumentOperations } from './document-passage-document';
import { acknowledgedScenePassage } from './document-passage-api';
import { DocumentRequestError } from './document-api';
import type { DocumentPassageDraft } from './document-passage-journal';
import type { PassageSessionState } from './document-passage-session';
export interface PassageTypedResult {
  passage: DocumentPassage;
  operationMappings: PassageOperationMapping[];
  introducedIds: Array<{ operationId: string; role: string; id: string }>;
  touched: { blockIds: string[]; runIds: string[]; objectIds: string[]; changeIds: string[] };
}
export type PassageTypedReceipt = DocumentPassageReceipt<PassageTypedResult>;
export interface PassageTypedDependencies {
  load(request: DocumentPassageRequest): Promise<DocumentPassage>;
  read(): Promise<DocumentPassageDraft | undefined>;
  write(draft: DocumentPassageDraft, expectedVersion?: string): Promise<void>;
  advance(draft: DocumentPassageDraft, expectedVersion: string, operationId: string): Promise<void>;
  remove(expectedVersion: string): Promise<void>;
  commit(request: DocumentPassageOperationCommit): Promise<PassageTypedReceipt>;
  restore(
    request: DocumentPassageRestore,
  ): Promise<DocumentPassageReceipt<DocumentPassageRestoreResult>>;
  recover(
    operationId: string,
  ): Promise<
    PassageTypedReceipt | DocumentPassageReceipt<DocumentPassageRestoreResult> | undefined
  >;
  id(): string;
}
export interface PassageTypedSnapshot {
  state: PassageSessionState;
  passage?: DocumentPassage;
  document?: ProserDocument;
  recovery?: DocumentPassageDraft;
  error?: string;
  canUndo: boolean;
  canRedo: boolean;
  structuralFlight?: boolean;
  focusBlockId?: string;
  currentSaved?: { passage: DocumentPassage; document: ProserDocument };
}
const equal = (a: unknown, b: unknown) => canonicalDocument(a) === canonicalDocument(b);
// Retiring React sessions can still be writing their last immutable-owner draft.
// A replacement instance must wait for those local writes before reading it.
// Cross-tab writers remain guarded by the IndexedDB version precondition.
const retentionTails = new Map<string, Promise<void>>();
function paragraphs(document: ProserDocument) {
  return document.blocks.flatMap((block) =>
    block.type === 'paragraph'
      ? [block]
      : block.type === 'table'
        ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
        : [],
  );
}
const text = (paragraph: DocumentParagraph, document: ProserDocument) =>
  paragraph.runs
    .filter((run) => visibleRun(run, document.changes, 'final'))
    .map((run) => (run.inlineImage ? '\ufffc' : run.text))
    .join('');
/** Later typing uses returned identities and numeric source positions. It never
 * relocates a target by searching for an equal quotation. */
export function rebasePassageTyping(
  submitted: ProserDocument,
  latest: ProserDocument,
  acknowledged: ProserDocument,
  mappings: PassageOperationMapping[],
): ProserDocument {
  const old = paragraphs(submitted),
    current = paragraphs(latest),
    next = structuredClone(acknowledged);
  if (
    !equal(
      old.map((p) => p.id),
      current.map((p) => p.id),
    )
  )
    throw new Error('Structural input during save requires explicit reconciliation.');
  for (const source of old) {
    const newer = current.find((p) => p.id === source.id)!;
    if (equal(source, newer)) continue;
    if (!equal(source.style, newer.style))
      throw new Error('Formatting during save requires explicit reconciliation.');
    const sourceText = text(source, submitted),
      newerText = text(newer, latest);
    if (sourceText === newerText)
      throw new Error('Formatting during save requires explicit reconciliation.');
    const candidateIds = new Set([
      source.id,
      ...mappings
        .filter((mapping) => mapping.source.blockId === source.id)
        .flatMap((mapping) => (mapping.target ? [mapping.target.blockId] : [])),
    ]);
    const candidates = paragraphs(next).filter((p) => candidateIds.has(p.id));
    if (candidates.length !== 1 || text(candidates[0]!, next) !== sourceText)
      throw new Error(
        'The acknowledged source left this bounded passage. Retain newer typing for reconciliation.',
      );
    const target = candidates[0]!,
      edit = minimalTextEdit(sourceText, newerText);
    let offset = 0;
    const targets = target.runs
      .filter((run) => visibleRun(run, next.changes, 'final'))
      .flatMap((run) => {
        const start = offset;
        offset += run.inlineImage ? 1 : run.text.length;
        return !run.inlineImage && edit.start >= start && edit.end <= offset
          ? [{ run, start }]
          : [];
      });
    if (targets.length !== 1)
      throw new Error(
        'Later typing crosses a style or object boundary. Retain it for reconciliation.',
      );
    const { run, start } = targets[0]!;
    run.text =
      run.text.slice(0, edit.start - start) + edit.replacement + run.text.slice(edit.end - start);
  }
  return next;
}

/** The operation journal owns bounded input plus exact pending requests.
 * Complete bodies and scene restore bytes remain exclusively in Factory. */
export class PassageTypedSession {
  private snapshot: PassageTypedSnapshot = { state: 'loading', canUndo: false, canRedo: false };
  private listeners = new Set<() => void>();
  private active = true;
  private epoch = 0;
  private serial = 0;
  private journal?: DocumentPassageDraft;
  private chain: Promise<void> = Promise.resolve();
  private flight?: Promise<void>;
  private undo: string[] = [];
  private undoHead?: string;
  private redoHead?: string;
  private localUndo: ProserDocument[] = [];
  private localRedo: ProserDocument[] = [];
  private redo: string[] = [];
  private draftOperationId?: string;
  private completedOperationId?: string;
  private rejectedOperationId?: string;
  private prepared?: { key: string; sourceKey: string; operations: DocumentPassageOperation[] };
  constructor(
    private identity: { userId: string; bookId: string; sceneId: string },
    private dependencies: PassageTypedDependencies,
    private bounds: DocumentPassageRequest = {
      maxCharacters: 8000,
      maxParagraphs: 24,
      maxRuns: 256,
    },
  ) {
    if (!identity.userId) throw new Error('Authenticate before opening a passage journal.');
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<PassageTypedSnapshot>) {
    if (!this.active) return;
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      canUndo: this.localUndo.length > 0 || this.undo.length > 0,
      canRedo: this.localRedo.length > 0 || this.redo.length > 0,
    };
    this.listeners.forEach((listener) => listener());
  }
  private retentionKey() {
    return JSON.stringify([this.identity.userId, this.identity.bookId, this.identity.sceneId]);
  }
  private enqueue(task: () => Promise<void>) {
    const key = this.retentionKey();
    const previous = retentionTails.get(key) ?? Promise.resolve();
    this.chain = Promise.all([this.chain, previous]).then(task);
    // Release the registry on either outcome without hiding this session's
    // storage failure or leaking a settled tail for every previously read scene.
    const tail = this.chain.then(
      () => undefined,
      () => undefined,
    );
    retentionTails.set(key, tail);
    void tail.then(() => {
      if (retentionTails.get(key) === tail) retentionTails.delete(key);
    });
    return this.chain;
  }
  activate() {
    this.active = true;
    this.epoch++;
    // Retiring effects may still be retaining this immutable owner's draft.
    // Keep their serialized journal tail; load waits for it before reading.
    this.flight = undefined;
    this.snapshot = { state: 'loading', canUndo: false, canRedo: false };
  }
  private own(passage: DocumentPassage) {
    validatePassageSource(passage, {
      bookId: Number(this.identity.bookId),
      sceneId: Number(this.identity.sceneId),
    });
  }
  async load(request: DocumentPassageRequest = this.bounds) {
    const epoch = ++this.epoch;
    this.publish({ state: 'loading', error: undefined });
    try {
      await Promise.all([this.chain, retentionTails.get(this.retentionKey())]);
      if (!this.active || epoch !== this.epoch) return;
      const [passage, recovery] = await Promise.all([
        this.dependencies.load({ ...this.bounds, ...request }),
        this.dependencies.read(),
      ]);
      if (!this.active || epoch !== this.epoch) return;
      this.own(passage);
      const document = passageDocument(passage);
      if (
        recovery &&
        (recovery.userId !== this.identity.userId ||
          recovery.bookId !== this.identity.bookId ||
          recovery.sceneId !== this.identity.sceneId)
      )
        throw new Error('This retained draft belongs to another account or scene.');
      this.journal = recovery;
      if (!recovery) {
        this.draftOperationId = undefined;
        this.prepared = undefined;
      }
      this.publish({ passage, document, recovery, state: recovery ? 'recoverable' : 'saved' });
    } catch (error) {
      if (this.active && epoch === this.epoch)
        this.publish({
          state: 'failed',
          error: error instanceof Error ? error.message : 'Unable to load this passage.',
        });
    }
  }
  edit(document: ProserDocument, history = true) {
    if (
      !this.active ||
      !this.snapshot.passage ||
      !this.snapshot.document ||
      !['saved', 'unsaved', 'saving'].includes(this.snapshot.state) ||
      this.snapshot.structuralFlight
    )
      throw new Error('Save or recover this passage before editing.');
    // Validate intent derivation before accepting a controlled native echo.
    const operations = passageDocumentOperations(
      this.snapshot.passage,
      passageDocument(this.snapshot.passage),
      document,
      () => this.dependencies.id(),
    );
    if (history) {
      this.localUndo.push(structuredClone(this.snapshot.document));
      this.localRedo = [];
      while (
        this.localUndo.length > 16 ||
        new TextEncoder().encode(canonicalDocument(this.localUndo)).byteLength > 512 * 1024
      )
        this.localUndo.shift();
    }
    this.draftOperationId ??= this.dependencies.id();
    this.prepared = {
      key: canonicalDocument(document),
      sourceKey: this.sourceKey(this.snapshot.passage),
      operations,
    };
    this.serial++;
    this.redo = [];
    this.publish({
      document,
      state: this.flight
        ? 'saving'
        : equal(document, passageDocument(this.snapshot.passage))
          ? 'saved'
          : 'unsaved',
      error: undefined,
      structuralFlight: operations.some(
        (op) => !['text', 'run-format', 'paragraph-format'].includes(op.kind),
      ),
    });
    void this.persist().catch((error) =>
      this.publish({
        state: 'failed',
        error: error instanceof Error ? error.message : 'Unable to retain this draft.',
      }),
    );
  }
  private persist(force = false) {
    const passage = this.snapshot.passage!,
      document = structuredClone(this.snapshot.document!);
    const localHistory = {
      undo: structuredClone(this.localUndo),
      redo: structuredClone(this.localRedo),
    };
    const prepared =
      this.prepared?.key === canonicalDocument(document) &&
      this.prepared.sourceKey === this.sourceKey(passage) &&
      this.draftOperationId
        ? {
            operationId: this.draftOperationId,
            sourceKey: this.prepared.sourceKey,
            documentKey: this.prepared.key,
            operations: structuredClone(this.prepared.operations),
          }
        : undefined;
    this.enqueue(async () => {
      // Local retention belongs to the captured authenticated identity, even
      // after logout/unmount. Network dispatch and visible state stay fenced.
      const previous = this.journal;
      if (!force && !previous?.pending && equal(document, passageDocument(passage))) {
        if (previous) await this.dependencies.remove(previous.version);
        this.journal = undefined;
        return;
      }
      const next: DocumentPassageDraft = {
        schemaVersion: 1,
        ...this.identity,
        version: this.dependencies.id(),
        updatedAt: Date.now(),
        passage,
        document,
        drafts: [],
        ...(prepared ? { prepared } : {}),
        localHistory,
        ...(previous?.pending ? { pending: previous.pending } : {}),
      };
      await this.dependencies.write(next, previous?.version);
      this.journal = next;
    });
    return this.chain;
  }
  /** Local-only checkpoint. Never dispatch an uncertain Factory operation. */
  retainDraft() {
    if (!this.active || !this.snapshot.passage || !this.snapshot.document) return this.chain;
    if (['unsaved', 'saving'].includes(this.snapshot.state)) return this.persist();
    return this.chain;
  }
  async save(tracking = false) {
    if (this.flight) return this.flight;
    if (
      !this.active ||
      this.snapshot.state !== 'unsaved' ||
      !this.snapshot.passage ||
      !this.snapshot.document
    )
      return;
    const submitted = structuredClone(this.snapshot.document);
    const local = this.localOperations();
    const operations = local?.operations ?? [];
    if (!operations.length) {
      this.publish({ state: 'saved' });
      return;
    }
    return this.dispatch(operations, submitted, tracking, local?.operationId);
  }
  async operate(operations: DocumentPassageOperation[], tracking = false) {
    const projection = this.snapshot.passage?.projection;
    if (
      projection !== 'final' &&
      !(projection === 'markup' && operations.every((op) => op.kind === 'resolve-change'))
    )
      throw new Error('Use Working text to edit or Markup to resolve tracked changes.');
    if (this.snapshot.state === 'unsaved') await this.save(tracking);
    if (this.flight) await this.flight;
    if (this.snapshot.state !== 'saved' || !this.snapshot.document)
      throw new Error('Recover this passage before applying an operation.');
    return this.dispatch(operations, structuredClone(this.snapshot.document), tracking);
  }
  private dispatch(
    operations: DocumentPassageOperation[],
    submitted: ProserDocument,
    tracking: boolean,
    operationId?: string,
  ) {
    const passage = this.snapshot.passage!,
      epoch = this.epoch;
    const request: DocumentPassageOperationCommit = {
      schemaVersion: 1,
      operationId: operationId ?? this.dependencies.id(),
      expectedRevisionId: passage.bookRevisionId,
      expectedSceneRevisionId: passage.sceneRevisionId,
      sourceFrame: passage.sourceFrame!,
      windowHash: passage.windowHash,
      cursor: passage.cursor,
      maxCharacters: this.bounds.maxCharacters,
      maxParagraphs: this.bounds.maxParagraphs,
      maxRuns: this.bounds.maxRuns,
      reviewOffset: passage.reviewOffset,
      tracking,
      operations,
    };
    const flight = (async () => {
      try {
        await this.persist(true);
        if (!this.active || epoch !== this.epoch) return;
        this.enqueue(async () => {
          if (!this.active || epoch !== this.epoch) return;
          const old = this.journal!,
            next: DocumentPassageDraft = {
              ...old,
              version: this.dependencies.id(),
              updatedAt: Date.now(),
              pending: { kind: 'operations', request, submittedDocument: submitted },
            };
          await this.dependencies.write(next, old.version);
          this.journal = next;
        });
        await this.chain;
        if (!this.active || epoch !== this.epoch) return;
        this.publish({
          state: 'saving',
          structuralFlight: operations.some(
            (op) => !['text', 'run-format', 'paragraph-format'].includes(op.kind),
          ),
        });
        const receipt = await this.dependencies.commit(request);
        if (this.active && epoch === this.epoch) await this.acknowledge(receipt, submitted, epoch);
      } catch (error) {
        if (this.active && epoch === this.epoch) {
          const rejected =
            error instanceof DocumentRequestError && [412, 428, 422, 413].includes(error.status);
          if (rejected) this.rejectedOperationId = request.operationId;
          this.publish({
            state: rejected ? 'conflict' : this.journal?.pending ? 'recoverable' : 'failed',
            error: error instanceof Error ? error.message : 'Save outcome unknown.',
          });
        }
      }
    })().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  private async acknowledge(
    receipt: PassageTypedReceipt,
    submitted: ProserDocument,
    epoch: number,
  ) {
    const pending = this.journal?.pending;
    if (pending?.kind !== 'operations') throw new Error('The retained operation changed.');
    // Reuse the sparse receipt validator through its supported passage wrapper.
    const passage = acknowledgedScenePassage(
      { ...receipt, result: { passage: receipt.result.passage, restoredFromRevisionId: '' } },
      this.identity.bookId,
      this.identity.sceneId,
      pending.request.operationId,
      undefined,
      pending.request.sourceFrame.projection,
    );
    this.own(passage);
    const committed = passageDocument(passage);
    this.completedOperationId = pending.request.operationId;
    const apply = this.enqueue(async () => {
      if (!this.active || epoch !== this.epoch) return;
      const old = this.journal!,
        serial = this.serial;
      let document: ProserDocument;
      try {
        if (
          this.snapshot.recovery &&
          this.snapshot.passage!.sceneRevisionId !== pending.request.expectedSceneRevisionId &&
          this.snapshot.passage!.sceneRevisionId !== passage.sceneRevisionId
        ) {
          this.publish({
            state: 'conflict',
            currentSaved: {
              passage: this.snapshot.passage!,
              document: passageDocument(this.snapshot.passage!),
            },
            error:
              'The saved scene advanced after this operation. Compare the retained draft explicitly.',
          });
          return;
        }
        // A reopened session displays the fetched server document. Only the
        // retained journal can contain typing made after the dispatched draft.
        const localDocument = this.snapshot.recovery
          ? (old.document ?? submitted)
          : this.snapshot.document!;
        document = equal(localDocument, submitted)
          ? committed
          : rebasePassageTyping(
              submitted,
              localDocument,
              committed,
              receipt.result.operationMappings,
            );
      } catch (error) {
        this.publish({
          state: 'conflict',
          currentSaved: { passage, document: committed },
          error: error instanceof Error ? error.message : 'Newer typing requires reconciliation.',
        });
        return;
      }
      const changed = !equal(document, committed);
      let next: DocumentPassageDraft | undefined;
      if (changed) {
        next = {
          schemaVersion: 1,
          ...this.identity,
          version: this.dependencies.id(),
          updatedAt: Date.now(),
          passage,
          document,
          drafts: [],
        };
        await this.dependencies.advance(next, old.version, pending.request.operationId);
      } else await this.dependencies.remove(old.version);
      if (!this.active || epoch !== this.epoch) return;
      if (this.serial !== serial) {
        const retained: DocumentPassageDraft = {
          ...old,
          version: this.dependencies.id(),
          updatedAt: Date.now(),
          document: structuredClone(this.snapshot.document!),
        };
        await this.dependencies.write(retained, next?.version);
        if (this.active && epoch === this.epoch) {
          this.journal = retained;
          this.publish({
            state: 'conflict',
            error:
              'Typing arrived during local acknowledgement. The exact draft and operation remain retained.',
          });
        }
        return;
      }
      this.undo.push(pending.request.expectedSceneRevisionId);
      this.undoHead = passage.sceneRevisionId;
      this.redoHead = undefined;
      this.undo = this.undo.slice(-100);
      this.redo = [];
      this.localUndo = [];
      this.localRedo = [];
      this.journal = next;
      this.draftOperationId = changed ? this.dependencies.id() : undefined;
      this.prepared = undefined;
      this.publish({
        passage,
        document,
        state: changed ? 'unsaved' : 'saved',
        error: undefined,
        recovery: undefined,
        structuralFlight: false,
        focusBlockId: receipt.result.introducedIds.find((item) =>
          ['split-paragraph', 'paragraph'].includes(item.role),
        )?.id,
      });
    });
    await apply;
  }
  async restoreLocalDraft() {
    const recovery = this.snapshot.recovery;
    if (!recovery?.document || !this.snapshot.passage) return;
    this.own(recovery.passage);
    if (recovery.passage.sceneRevisionId !== this.snapshot.passage.sceneRevisionId) {
      this.publish({
        state: 'conflict',
        document: recovery.document,
        error:
          'The retained draft has a different saved revision. Compare it explicitly before applying.',
      });
      return;
    }
    const epoch = this.epoch;
    const qualified = await this.dependencies.load({
      ...this.bounds,
      bookRevisionId: recovery.passage.bookRevisionId,
      cursor: recovery.passage.cursor,
      reviewOffset: recovery.passage.reviewOffset,
      projection: 'final',
    });
    if (!this.active || epoch !== this.epoch || this.snapshot.recovery !== recovery)
      throw new Error('The document recovery session changed.');
    this.own(qualified);
    if (
      this.sourceKey(qualified) !== this.sourceKey(recovery.passage) ||
      !equal(passageDocument(qualified), passageDocument(recovery.passage))
    )
      throw new Error(
        'The retained source differs from its pinned Factory passage. Preserve the draft for explicit reconciliation.',
      );
    if (recovery.prepared) {
      const frozen = recovery.prepared;
      if (
        !frozen.operationId ||
        frozen.sourceKey !== this.sourceKey(recovery.passage) ||
        frozen.documentKey !== canonicalDocument(recovery.document) ||
        new Set(frozen.operations.map((op) => op.id)).size !== frozen.operations.length ||
        frozen.operations.some((op) => !op.id)
      )
        throw new Error(
          'The retained AI derivative no longer matches its qualified source and draft. Preserve it for explicit reconciliation.',
        );
      let index = 0;
      const reproduced = passageDocumentOperations(
        recovery.passage,
        passageDocument(recovery.passage),
        recovery.document,
        () => frozen.operations[index++]?.id ?? 'invalid-missing-operation',
      );
      if (!equal(reproduced, frozen.operations))
        throw new Error(
          'The retained AI operations do not reproduce this exact draft. Preserve it for explicit reconciliation.',
        );
      this.draftOperationId = frozen.operationId;
      this.prepared = {
        key: frozen.documentKey,
        sourceKey: frozen.sourceKey,
        operations: structuredClone(frozen.operations),
      };
    } else {
      this.draftOperationId = undefined;
      this.prepared = undefined;
    }
    this.localUndo = structuredClone(recovery.localHistory?.undo ?? []);
    this.localRedo = structuredClone(recovery.localHistory?.redo ?? []);
    this.publish({
      passage: recovery.passage,
      document: recovery.document,
      recovery: undefined,
      state: recovery.pending ? 'recoverable' : 'unsaved',
    });
  }
  async recover(retryAbsent = false) {
    const pending = this.journal?.pending;
    if (!pending || !['operations', 'restore'].includes(pending.kind) || this.flight) return;
    const epoch = this.epoch;
    this.publish({ state: 'saving', error: undefined });
    const flight = (async () => {
      try {
        let receipt = await this.dependencies.recover(pending.request.operationId);
        if (!this.active || epoch !== this.epoch) return;
        if (!receipt && !retryAbsent) {
          this.publish({
            state: 'recoverable',
            error:
              'Factory has no completed receipt. Retry the exact retained operation explicitly.',
          });
          return;
        }
        if (pending.kind === 'operations') {
          receipt ??= await this.dependencies.commit(pending.request);
          if (!this.active || epoch !== this.epoch) return;
          if (!('operationMappings' in receipt.result))
            throw new Error('The retained receipt is not a typed passage operation.');
          await this.acknowledge(receipt as PassageTypedReceipt, pending.submittedDocument, epoch);
        } else if (pending.kind === 'restore') {
          receipt ??= await this.dependencies.restore(pending.request);
          if (!this.active || epoch !== this.epoch) return;
          if (!('restoredFromRevisionId' in receipt.result))
            throw new Error('The retained receipt is not a restoration.');
          await this.acknowledgeRestore(
            receipt as DocumentPassageReceipt<DocumentPassageRestoreResult>,
            epoch,
          );
        }
      } catch (error) {
        if (this.active && epoch === this.epoch)
          this.publish({
            state: 'recoverable',
            error: error instanceof Error ? error.message : 'Unable to recover this operation.',
          });
      }
    })().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  async navigate(cursor: DocumentPassageRequest['cursor']) {
    if (this.snapshot.state !== 'saved' || this.flight || this.journal?.pending)
      throw new Error('Save or recover this passage before navigating.');
    await this.load({
      ...this.bounds,
      cursor,
      bookRevisionId: this.snapshot.passage!.bookRevisionId,
      projection: this.snapshot.passage!.projection,
    });
  }
  localOperations(): { operationId: string; operations: DocumentPassageOperation[] } | undefined {
    if (
      !this.snapshot.passage ||
      !this.snapshot.document ||
      equal(this.snapshot.document, passageDocument(this.snapshot.passage))
    )
      return;
    const key = canonicalDocument(this.snapshot.document);
    const sourceKey = this.sourceKey(this.snapshot.passage);
    if (this.prepared?.key !== key || this.prepared.sourceKey !== sourceKey)
      this.prepared = {
        key,
        sourceKey,
        operations: passageDocumentOperations(
          this.snapshot.passage,
          passageDocument(this.snapshot.passage),
          this.snapshot.document,
          () => this.dependencies.id(),
        ),
      };
    this.draftOperationId ??= this.dependencies.id();
    return {
      operationId: this.draftOperationId,
      operations: structuredClone(this.prepared.operations),
    };
  }
  private sourceKey(passage: DocumentPassage) {
    return canonicalDocument({
      sourceFrame: passage.sourceFrame,
      windowHash: passage.windowHash,
      cursor: passage.cursor,
      reviewOffset: passage.reviewOffset,
    });
  }
  async retainLocalOperations(local: {
    operationId: string;
    operations: DocumentPassageOperation[];
  }) {
    if (this.snapshot.state !== 'unsaved' || this.flight || this.journal?.pending)
      throw new Error('Save or recover the current passage before preparing draft context.');
    const current = this.localOperations(),
      epoch = this.epoch;
    if (!current || !equal(current, local))
      throw new Error(
        'The draft changed before context preparation. Prepare the current draft again.',
      );
    const documentKey = canonicalDocument(this.snapshot.document),
      sourceKey = this.sourceKey(this.snapshot.passage!);
    await this.persist(true);
    if (
      !this.active ||
      epoch !== this.epoch ||
      documentKey !== canonicalDocument(this.snapshot.document) ||
      sourceKey !== this.sourceKey(this.snapshot.passage!) ||
      !equal(this.localOperations(), local) ||
      !equal(this.journal?.prepared, {
        operationId: local.operationId,
        sourceKey,
        documentKey,
        operations: local.operations,
      })
    )
      throw new Error(
        'The draft changed while retaining context. Prepare the current draft again.',
      );
  }
  async acknowledgeExternalApplication(
    receipt: {
      kind: 'catalog';
      status: 'completed';
      operationId: string;
      revisionId: string;
      contentHash: string;
      sceneReferences: SceneDocumentReference[];
      result: { sceneId: number; sourceSceneRevisionId: string; sourceBookRevisionId: string };
    },
    beforeSceneRevisionId?: string,
  ) {
    const source = receipt.result,
      reference = receipt.sceneReferences.find(
        (ref) => ref.sceneId === Number(this.identity.sceneId),
      );
    if (
      receipt.kind !== 'catalog' ||
      receipt.status !== 'completed' ||
      !receipt.operationId ||
      source.sceneId !== Number(this.identity.sceneId) ||
      !reference ||
      !source.sourceSceneRevisionId ||
      !source.sourceBookRevisionId ||
      (beforeSceneRevisionId && beforeSceneRevisionId !== source.sourceSceneRevisionId)
    )
      throw new Error(
        'The proposal acknowledgement does not identify this exact scene source. Recover its original receipt.',
      );
    const epoch = this.epoch;
    const passage = await this.dependencies.load({
      ...this.bounds,
      bookRevisionId: receipt.revisionId,
      cursor: this.snapshot.passage?.cursor,
      projection: 'final',
    });
    if (!this.active || epoch !== this.epoch)
      throw new Error('The document session changed while recovering the application.');
    if (
      passage.bookRevisionId !== receipt.revisionId ||
      passage.sceneRevisionId !== reference.revisionId ||
      passage.contentHash !== reference.contentHash ||
      passage.sourceFrame?.bookContentHash !== receipt.contentHash
    )
      throw new Error(
        'The pinned proposal source differs from its immutable receipt. Preserve the original operation.',
      );
    this.registerReviewAcknowledgement(source.sourceSceneRevisionId, passage);
    return passage;
  }
  adoptScopedPassage(
    passage: DocumentPassage,
    expectedSceneRevisionId: string,
    kind: 'transfer' | 'comment' = 'transfer',
  ) {
    if (
      this.snapshot.state !== 'saved' ||
      this.flight ||
      this.journal?.pending ||
      this.snapshot.passage?.sceneRevisionId !== expectedSceneRevisionId
    )
      throw new Error(
        'This scene changed while applying the scoped acknowledgement. Recover the window operation.',
      );
    this.own(passage);
    this.undo = kind === 'comment' ? [...this.undo, expectedSceneRevisionId].slice(-100) : [];
    this.undoHead = kind === 'comment' ? passage.sceneRevisionId : undefined;
    this.redoHead = undefined;
    this.redo = [];
    this.localUndo = [];
    this.localRedo = [];
    this.draftOperationId = undefined;
    this.prepared = undefined;
    this.publish({
      passage,
      document: passageDocument(passage),
      state: 'saved',
      error: undefined,
      recovery: undefined,
      focusBlockId: undefined,
    });
  }
  registerReviewAcknowledgement(beforeSceneRevisionId: string, passage: DocumentPassage) {
    const current = this.snapshot.passage;
    if (
      this.snapshot.state === 'saved' &&
      !this.flight &&
      !this.journal?.pending &&
      current?.sceneRevisionId === passage.sceneRevisionId &&
      current.contentHash === passage.contentHash
    ) {
      this.own(passage);
      if (this.undo.at(-1) !== beforeSceneRevisionId) this.undo.push(beforeSceneRevisionId);
      this.undoHead = passage.sceneRevisionId;
      this.redoHead = undefined;
      this.redo = [];
      this.publish({});
      return;
    }
    this.adoptScopedPassage(passage, beforeSceneRevisionId, 'comment');
  }
  async flush(tracking = false): Promise<DocumentPassage> {
    if (this.snapshot.state === 'unsaved') await this.save(tracking);
    if (this.flight) await this.flight;
    if (this.snapshot.state !== 'saved' || !this.snapshot.passage)
      throw new Error('Save or recover this passage before continuing.');
    return this.snapshot.passage;
  }
  async undoRevision() {
    if (
      this.localUndo.length &&
      ['unsaved', 'saving', 'saved'].includes(this.snapshot.state) &&
      !this.snapshot.structuralFlight
    ) {
      const target = this.localUndo.pop()!;
      this.localRedo.push(structuredClone(this.snapshot.document!));
      this.edit(target, false);
      return;
    }
    return this.restoreHistory('undo');
  }
  async redoRevision() {
    if (
      this.localRedo.length &&
      ['unsaved', 'saving', 'saved'].includes(this.snapshot.state) &&
      !this.snapshot.structuralFlight
    ) {
      const target = this.localRedo.pop()!;
      this.localUndo.push(structuredClone(this.snapshot.document!));
      this.edit(target, false);
      return;
    }
    return this.restoreHistory('redo');
  }
  private async restoreHistory(direction: 'undo' | 'redo') {
    if (
      this.snapshot.state !== 'saved' ||
      this.flight ||
      this.snapshot.passage?.projection !== 'final'
    )
      return;
    const history = direction === 'undo' ? this.undo : this.redo;
    const target = history.at(-1);
    if (!target) return;
    if (
      this.snapshot.passage.sceneRevisionId !==
      (direction === 'undo' ? this.undoHead : this.redoHead)
    )
      throw new Error(
        'Newer scene work supersedes this operation. Inspect the current revision before restoring.',
      );
    const passage = this.snapshot.passage,
      epoch = this.epoch;
    const request: DocumentPassageRestore = {
      schemaVersion: 1,
      operationId: this.dependencies.id(),
      expectedRevisionId: passage.bookRevisionId,
      expectedSceneRevisionId: passage.sceneRevisionId,
      windowHash: passage.windowHash,
      cursor: passage.cursor,
      maxCharacters: this.bounds.maxCharacters,
      maxParagraphs: this.bounds.maxParagraphs,
      maxRuns: this.bounds.maxRuns,
      reviewOffset: passage.reviewOffset,
      restoreFromRevisionId: target,
    };
    const flight = (async () => {
      try {
        await this.persist(true);
        if (!this.active || epoch !== this.epoch) return;
        this.enqueue(async () => {
          if (!this.active || epoch !== this.epoch) return;
          const old = this.journal!,
            next: DocumentPassageDraft = {
              ...old,
              version: this.dependencies.id(),
              updatedAt: Date.now(),
              pending: { kind: 'restore', request },
            };
          await this.dependencies.write(next, old.version);
          this.journal = next;
        });
        await this.chain;
        if (!this.active || epoch !== this.epoch) return;
        this.publish({ state: 'saving' });
        const receipt = await this.dependencies.restore(request);
        if (!this.active || epoch !== this.epoch) return;
        await this.acknowledgeRestore(receipt, epoch);
        if (this.active && epoch === this.epoch) {
          history.pop();
          (direction === 'undo' ? this.redo : this.undo).push(passage.sceneRevisionId);
          this.undoHead = this.snapshot.passage?.sceneRevisionId;
          this.redoHead = this.snapshot.passage?.sceneRevisionId;
          this.publish({});
        }
      } catch (error) {
        if (this.active && epoch === this.epoch)
          this.publish({
            state: this.journal?.pending ? 'recoverable' : 'failed',
            error: error instanceof Error ? error.message : 'Restore outcome unknown.',
          });
      }
    })().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  private async acknowledgeRestore(
    receipt: DocumentPassageReceipt<DocumentPassageRestoreResult>,
    epoch: number,
  ) {
    const pending = this.journal?.pending;
    if (pending?.kind !== 'restore') throw new Error('The retained restoration changed.');
    const passage = acknowledgedScenePassage(
      receipt,
      this.identity.bookId,
      this.identity.sceneId,
      pending.request.operationId,
      pending.request.restoreFromRevisionId,
    );
    this.own(passage);
    const document = passageDocument(passage);
    await this.enqueue(async () => {
      if (!this.active || epoch !== this.epoch) return;
      await this.dependencies.remove(this.journal!.version);
      this.journal = undefined;
      if (this.active && epoch === this.epoch)
        this.publish({ passage, document, state: 'saved', recovery: undefined, error: undefined });
    });
  }
  async retryStorage() {
    if (this.snapshot.state !== 'failed' || !this.snapshot.document) return;
    this.chain = Promise.resolve();
    try {
      await this.persist(true);
      this.publish({ state: this.journal?.pending ? 'recoverable' : 'unsaved', error: undefined });
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : 'Unable to retain this draft.',
      });
    }
  }
  async inspectConflict() {
    if (this.snapshot.state !== 'conflict' || !this.snapshot.passage) return;
    const epoch = this.epoch,
      passage = await this.dependencies.load({
        ...this.bounds,
        cursor: this.snapshot.passage.cursor,
      });
    if (!this.active || epoch !== this.epoch) return;
    this.own(passage);
    this.publish({ currentSaved: { passage, document: passageDocument(passage) } });
  }
  async useSavedVersion() {
    const current = this.snapshot.currentSaved;
    if (!current || !this.journal) return;
    if (
      this.journal.pending &&
      this.completedOperationId !== this.journal.pending.request.operationId &&
      this.rejectedOperationId !== this.journal.pending.request.operationId
    )
      throw new Error(
        'Recover the original Factory operation before discarding its retained draft.',
      );
    const epoch = this.epoch;
    await this.enqueue(async () => {
      if (!this.active || epoch !== this.epoch) return;
      await this.dependencies.remove(this.journal!.version);
    });
    if (!this.active || epoch !== this.epoch) return;
    this.journal = undefined;
    this.draftOperationId = undefined;
    this.prepared = undefined;
    this.localUndo = [];
    this.localRedo = [];
    this.publish({
      passage: current.passage,
      document: current.document,
      state: 'saved',
      error: undefined,
      recovery: undefined,
      currentSaved: undefined,
      structuralFlight: false,
    });
  }
  async discard() {
    if (this.journal?.pending)
      throw new Error('Recover the original Factory operation before discarding its draft.');
    await this.enqueue(async () => {
      if (this.journal?.pending)
        throw new Error('Recover the original Factory operation before discarding its draft.');
      if (this.journal) await this.dependencies.remove(this.journal.version);
      this.journal = undefined;
    });
    await this.load();
  }
  dispose() {
    this.active = false;
    this.epoch++;
    this.snapshot = { state: 'inactive', canUndo: false, canRedo: false };
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }
}
