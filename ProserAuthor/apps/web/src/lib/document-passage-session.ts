import {
  canonicalDocument,
  type DocumentPassage,
  type DocumentPassageReceipt,
  type DocumentPassageCommit,
  type DocumentPassageRequest,
} from '@hivemagnus/proser-contracts';
import { validatePassageSource } from '../../../../packages/editor/src/passage-source';
import { passageCommit, passageRunEdits, type PassageRunDraft } from './document-passage-editing';
import { acknowledgedScenePassage } from './document-passage-api';
import type { DocumentPassageDraft } from './document-passage-journal';
export type PassageSessionState =
  'loading' | 'saved' | 'unsaved' | 'saving' | 'recoverable' | 'conflict' | 'failed' | 'inactive';
export interface PassageSessionSnapshot {
  state: PassageSessionState;
  passage?: DocumentPassage;
  drafts: PassageRunDraft[];
  recovery?: DocumentPassageDraft;
  acknowledged?: DocumentPassage;
  error?: string;
}
export interface PassageSessionDependencies {
  load(input?: DocumentPassageRequest): Promise<DocumentPassage>;
  read(): Promise<DocumentPassageDraft | undefined>;
  write(draft: DocumentPassageDraft, expectedVersion?: string): Promise<void>;
  advance(draft: DocumentPassageDraft, expectedVersion: string, operationId: string): Promise<void>;
  remove(expectedVersion: string): Promise<void>;
  save(request: DocumentPassageCommit): Promise<DocumentPassageReceipt>;
  recover(operationId: string): Promise<DocumentPassageReceipt | undefined>;
  operationId(): string;
  version(): string;
}
/** Inactive bounded controller. It never owns, serializes or uploads a complete scene. */
export class DocumentPassageSession {
  private snapshot: PassageSessionSnapshot = { state: 'loading', drafts: [] };
  private journal?: DocumentPassageDraft;
  private epoch = 0;
  private active = true;
  private chain: Promise<void> = Promise.resolve();
  private flight?: Promise<void>;
  private editSerial = 0;
  private durableSerial = 0;
  private readRequest?: DocumentPassageRequest;
  private listeners = new Set<() => void>();
  constructor(
    private readonly identity: { userId: string; bookId: string; sceneId: string },
    private readonly dependencies: PassageSessionDependencies,
    private readonly bounds: { maxCharacters?: number; maxParagraphs?: number } = {},
  ) {
    if (!identity.userId) throw new Error('Authenticate before reading a passage journal.');
  }
  /** React development remounts restart reads, retaining durable recovery records. */
  activate() {
    this.active = true;
    ++this.epoch;
    this.journal = undefined;
    this.chain = Promise.resolve();
    this.flight = undefined;
    this.editSerial = this.durableSerial = 0;
    this.snapshot = { state: 'loading', drafts: [] };
    this.listeners.forEach((listener) => listener());
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<PassageSessionSnapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private owned(window: DocumentPassage) {
    validatePassageSource(window, {
      bookId: Number(this.identity.bookId),
      sceneId: Number(this.identity.sceneId),
    });
  }
  async load() {
    if (this.snapshot.passage && this.snapshot.state !== 'saved')
      throw new Error('Recover or save this passage before loading another source.');
    const epoch = ++this.epoch;
    this.publish({ state: 'loading', error: undefined });
    try {
      const [window, recovery] = await Promise.all([
        this.dependencies.load(this.readRequest ?? this.bounds),
        this.dependencies.read(),
      ]);
      if (!this.active || epoch !== this.epoch) return;
      this.owned(window);
      if (
        recovery &&
        (recovery.userId !== this.identity.userId ||
          recovery.bookId !== this.identity.bookId ||
          recovery.sceneId !== this.identity.sceneId)
      )
        throw new Error('This recovery record belongs to another authenticated scope.');
      this.journal = recovery;
      this.publish({
        passage: window,
        drafts: [],
        recovery,
        state: recovery ? 'recoverable' : 'saved',
      });
    } catch (error) {
      if (this.active && epoch === this.epoch)
        this.publish({
          state: 'failed',
          error: error instanceof Error ? error.message : 'Unable to load this passage.',
        });
    }
  }
  async navigate(cursor: DocumentPassageRequest['cursor']) {
    if (!cursor || this.snapshot.state !== 'saved' || this.flight || this.journal?.pending)
      throw new Error('Save or recover this passage before navigating.');
    this.readRequest = {
      ...this.bounds,
      bookRevisionId: this.snapshot.passage!.bookRevisionId,
      cursor: structuredClone(cursor),
    };
    await this.load();
  }
  restoreLocalDraft() {
    const recovery = this.snapshot.recovery;
    if (!recovery || !this.snapshot.passage) return;
    this.owned(recovery.passage);
    if (
      recovery.passage.sceneRevisionId !== this.snapshot.passage.sceneRevisionId ||
      recovery.passage.windowHash !== this.snapshot.passage.windowHash
    ) {
      this.publish({
        state: 'conflict',
        error: 'The retained draft has a different immutable source. Reconcile it explicitly.',
      });
      return;
    }
    passageRunEdits(recovery.passage, recovery.drafts);
    this.publish({
      passage: recovery.passage,
      drafts: structuredClone(recovery.drafts),
      recovery: undefined,
      state: recovery.pending ? 'recoverable' : recovery.drafts.length ? 'unsaved' : 'saved',
    });
  }
  edit(draft: PassageRunDraft) {
    if (
      !this.active ||
      !this.snapshot.passage ||
      ['loading', 'conflict', 'recoverable', 'failed'].includes(this.snapshot.state)
    )
      throw new Error('Recover this passage before editing.');
    passageRunEdits(this.snapshot.passage, [draft]);
    ++this.editSerial;
    const drafts = this.snapshot.drafts.filter(
      (old) => old.blockId !== draft.blockId || old.runId !== draft.runId,
    );
    if (passageRunEdits(this.snapshot.passage, [draft]).length) drafts.push(structuredClone(draft));
    this.publish({
      drafts,
      state: this.flight ? 'saving' : drafts.length ? 'unsaved' : 'saved',
      error: undefined,
    });
    void this.persist().catch((error) =>
      this.publish({
        state: 'failed',
        error: error instanceof Error ? error.message : 'Unable to retain this passage draft.',
      }),
    );
  }
  private persist() {
    const window = this.snapshot.passage;
    if (!window) return Promise.reject(new Error('This passage is not loaded.'));
    const drafts = structuredClone(this.snapshot.drafts);
    const serial = this.editSerial;
    const epoch = this.epoch;
    this.chain = this.chain.then(async () => {
      if (!this.active || epoch !== this.epoch || serial < this.durableSerial) return;
      const previous = this.journal;
      const draft: DocumentPassageDraft = {
        schemaVersion: 1,
        ...this.identity,
        version: this.dependencies.version(),
        updatedAt: Date.now(),
        passage: window,
        drafts,
        ...(previous?.pending ? { pending: previous.pending } : {}),
      };
      await this.dependencies.write(draft, previous?.version);
      if (this.active && epoch === this.epoch) {
        this.journal = draft;
        this.durableSerial = serial;
      }
    });
    return this.chain;
  }
  async save(tracking = false) {
    if (this.flight) return this.flight;
    if (!this.active || !this.snapshot.passage || this.snapshot.state !== 'unsaved') return;
    const flight = this.commit(tracking).finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  private async commit(tracking: boolean) {
    const epoch = this.epoch;
    const window = this.snapshot.passage!;
    const submitted = structuredClone(this.snapshot.drafts);
    const request = passageCommit(
      window,
      submitted,
      this.dependencies.operationId(),
      tracking,
      this.bounds,
    );
    try {
      await this.persist();
      if (!this.active || epoch !== this.epoch) return;
      this.chain = this.chain.then(async () => {
        if (!this.active || epoch !== this.epoch) return;
        const previous = this.journal!;
        const serial = this.editSerial;
        const pending: DocumentPassageDraft = {
          ...previous,
          drafts: structuredClone(this.snapshot.drafts),
          version: this.dependencies.version(),
          updatedAt: Date.now(),
          pending: { kind: 'commit', request, submittedDrafts: submitted },
        };
        await this.dependencies.write(pending, previous.version);
        if (this.active && epoch === this.epoch) {
          this.journal = pending;
          this.durableSerial = serial;
        }
      });
      await this.chain;
      if (!this.active || epoch !== this.epoch) return;
      this.publish({ state: 'saving' });
      const receipt = await this.dependencies.save(request);
      if (!this.active || epoch !== this.epoch) return;
      await this.acknowledge(receipt, submitted, epoch);
    } catch (error) {
      if (this.active && epoch === this.epoch)
        this.publish({
          state: this.journal?.pending ? 'recoverable' : 'failed',
          error: error instanceof Error ? error.message : 'The passage save outcome is unknown.',
        });
    }
  }
  async recover(retryAbsent = false) {
    const pending = this.journal?.pending;
    if (!pending || pending.kind !== 'commit' || this.flight || !this.active) return;
    const epoch = this.epoch;
    const submitted = pending.submittedDrafts;
    if (!submitted) {
      this.publish({
        state: 'conflict',
        error:
          'This retained operation lacks its dispatched draft snapshot. Inspect its exact request before reconciling.',
      });
      return;
    }
    this.publish({ state: 'saving', error: undefined });
    const flight = (async () => {
      try {
        let receipt = await this.dependencies.recover(pending.request.operationId);
        if (!this.active || epoch !== this.epoch) return;
        if (!receipt && !retryAbsent) {
          this.publish({
            state: 'recoverable',
            error: 'Factory has no completed receipt. Explicitly retry the retained operation.',
          });
          return;
        }
        receipt ??= await this.dependencies.save(pending.request);
        if (!this.active || epoch !== this.epoch) return;
        await this.acknowledge(receipt, submitted, epoch);
      } catch (error) {
        if (this.active && epoch === this.epoch)
          this.publish({
            state: 'recoverable',
            error:
              error instanceof Error ? error.message : 'Unable to recover the original operation.',
          });
      }
    })().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  private async acknowledge(
    receipt: DocumentPassageReceipt,
    submitted: PassageRunDraft[],
    epoch: number,
  ) {
    const operation = this.journal?.pending;
    if (!operation || operation.kind !== 'commit')
      throw new Error('The retained passage operation changed.');
    const window = acknowledgedScenePassage(
      receipt,
      this.identity.bookId,
      this.identity.sceneId,
      operation.request.operationId,
    );
    this.owned(window);
    const apply = this.chain.then(async () => {
      if (!this.active || epoch !== this.epoch) return;
      const before = this.snapshot.passage!;
      const serial = this.editSerial;
      const changedKeys = new Map(
        [...submitted, ...this.snapshot.drafts].map((draft) => [
          JSON.stringify([draft.blockId, draft.runId]),
          draft,
        ]),
      );
      const newer = [...changedKeys.values()].flatMap((key) => {
        const originalRun = before.paragraphs
          .find((scope) => scope.paragraph.id === key.blockId)
          ?.paragraph.runs.find((run) => run.id === key.runId);
        if (!originalRun) throw new Error('The pending target left its frozen passage.');
        const current = this.snapshot.drafts.find(
          (draft) => draft.blockId === key.blockId && draft.runId === key.runId,
        ) ?? { blockId: key.blockId, runId: key.runId, text: originalRun.text };
        const sent = submitted.find(
          (draft) => draft.blockId === key.blockId && draft.runId === key.runId,
        ) ?? { blockId: key.blockId, runId: key.runId, text: originalRun.text };
        return canonicalDocument(current) === canonicalDocument(sent) ? [] : [current];
      });
      const rebased: PassageRunDraft[] = [];
      for (const draft of newer) {
        const oldScope = before.paragraphs.find((item) => item.paragraph.id === draft.blockId);
        const newScope = window.paragraphs.find((item) => item.paragraph.id === draft.blockId);
        const oldSource = oldScope?.runs.find((run) => run.runId === draft.runId);
        const newSource = newScope?.runs.find((run) => run.runId === draft.runId);
        const oldRun = oldScope?.paragraph.runs.find((run) => run.id === draft.runId);
        const newRun = newScope?.paragraph.runs.find((run) => run.id === draft.runId);
        if (
          !oldSource ||
          !newSource ||
          canonicalDocument(oldSource) !== canonicalDocument(newSource) ||
          canonicalDocument(oldRun) !== canonicalDocument(newRun)
        ) {
          this.publish({
            state: 'conflict',
            acknowledged: window,
            error:
              'Your newer typing remains retained. This acknowledgement changed its source identities; reconcile using validated operation mappings.',
          });
          return;
        }
        rebased.push(draft);
      }
      const previous = this.journal!;
      let next: DocumentPassageDraft | undefined;
      if (rebased.length) {
        next = {
          schemaVersion: 1,
          ...this.identity,
          version: this.dependencies.version(),
          updatedAt: Date.now(),
          passage: window,
          drafts: rebased,
        };
        await this.dependencies.advance(next, previous.version, operation.request.operationId);
      } else await this.dependencies.remove(previous.version);
      if (!this.active || epoch !== this.epoch) return;
      this.journal = next;
      if (this.editSerial !== serial) {
        // Input arrived while the local acknowledgement transaction was committing.
        // Keep its old source and original operation; do not relabel it as saved.
        const latestSerial = this.editSerial;
        const retained: DocumentPassageDraft = {
          schemaVersion: 1,
          ...this.identity,
          version: this.dependencies.version(),
          updatedAt: Date.now(),
          passage: before,
          drafts: structuredClone(this.snapshot.drafts),
          pending: operation,
        };
        this.publish({
          state: 'conflict',
          acknowledged: window,
          error:
            'Typing arrived during acknowledgement. Its frozen source remains retained for validated reconciliation.',
        });
        await this.dependencies.write(retained, next?.version);
        if (this.active && epoch === this.epoch) {
          this.journal = retained;
          this.durableSerial = latestSerial;
        }
        return;
      }
      this.durableSerial = serial;
      this.publish({
        state: rebased.length ? 'unsaved' : 'saved',
        passage: window,
        drafts: rebased,
        acknowledged: undefined,
        error: undefined,
        recovery: undefined,
      });
    });
    this.chain = apply;
    await apply;
  }
  async retryDraftStorage() {
    if (!this.active || this.snapshot.state !== 'failed') return;
    this.chain = Promise.resolve();
    try {
      await this.persist();
      if (this.active)
        this.publish({
          state: this.journal?.pending
            ? 'recoverable'
            : this.snapshot.drafts.length
              ? 'unsaved'
              : 'saved',
          error: undefined,
        });
    } catch (error) {
      this.publish({
        state: 'failed',
        error: error instanceof Error ? error.message : 'Unable to retain this passage.',
      });
    }
  }
  dispose() {
    this.active = false;
    ++this.epoch;
    this.snapshot = { state: 'inactive', drafts: [] };
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }
}
