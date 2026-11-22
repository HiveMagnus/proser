import type { BookCatalogReceipt, BookCatalogScope } from './document-api';
import type {
  BookCatalogIntent,
  BookCatalogSnapshot,
  BookMetadataPatch,
} from './document-book-catalog-journal';
import { validateBookCatalogIntent } from './document-book-catalog-journal';

export interface BookCatalogDependencies {
  read(userId: string): Promise<BookCatalogIntent | undefined>;
  write(row: BookCatalogIntent, expectedVersion?: string): Promise<void>;
  remove(userId: string, version: string, operationId: string): Promise<void>;
  scope(bookId: string, userId: string): Promise<BookCatalogScope>;
  mutate(row: BookCatalogIntent): Promise<unknown>;
  recover(bookId: string, operationId: string, userId: string): Promise<BookCatalogReceipt>;
}
export interface BookCatalogState {
  pending?: BookCatalogIntent;
  receipt?: BookCatalogReceipt;
  busy: boolean;
  error?: string;
  journalError?: string;
  retryAllowed: boolean;
}
const tails = new Map<string, Promise<unknown>>();
const status = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error ? error.status : undefined;
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Book operation failed.';

export class BookCatalogSession {
  private active = true;
  private epoch = 0;
  private loaded?: Promise<void>;
  private snapshots = new Map<string, string>();
  private state: BookCatalogState = { busy: false, retryAllowed: false };
  private listeners = new Set<() => void>();
  constructor(
    readonly userId: string,
    private deps: BookCatalogDependencies,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.active = true;
    this.epoch++;
    this.loaded = undefined;
  }
  dispose() {
    this.active = false;
    this.epoch++;
    this.snapshots.clear();
    this.state = { busy: false, retryAllowed: false };
  }
  private owned(epoch: number) {
    if (!this.active || epoch !== this.epoch || !this.userId)
      throw new Error('The authenticated user changed. Reopen this operation under its owner.');
  }
  private publish(next: Partial<BookCatalogState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = (tails.get(this.userId) ?? Promise.resolve()).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(this.userId, settled);
    void settled.then(() => {
      if (tails.get(this.userId) === settled) tails.delete(this.userId);
    });
    return result;
  }
  load(): Promise<void> {
    if (this.loaded) return this.loaded;
    const epoch = this.epoch;
    this.loaded = (async () => {
      this.owned(epoch);
      this.publish({ busy: true });
      try {
        await tails.get(this.userId);
        const row = await this.deps.read(this.userId);
        this.owned(epoch);
        if (row) validateBookCatalogIntent(row, this.userId);
        this.publish({
          pending: row,
          retryAllowed: row?.status === 'not-found',
          journalError: undefined,
        });
      } catch (error) {
        if (this.active && epoch === this.epoch) {
          this.loaded = undefined;
          this.publish({ journalError: message(error), error: message(error) });
        }
        throw error;
      } finally {
        if (this.active && epoch === this.epoch) this.publish({ busy: false });
      }
    })();
    return this.loaded;
  }
  private async run<T>(task: (epoch: number) => Promise<T>): Promise<T> {
    await this.load();
    const epoch = this.epoch;
    this.owned(epoch);
    if (this.state.busy) throw new Error('Wait for the current book operation.');
    this.publish({ busy: true, error: undefined });
    try {
      return await task(epoch);
    } catch (error) {
      if (this.active && epoch === this.epoch) this.publish({ error: message(error) });
      throw error;
    } finally {
      if (this.active && epoch === this.epoch) this.publish({ busy: false });
    }
  }
  async prepare(bookId: string): Promise<BookCatalogSnapshot> {
    return this.run(async (epoch) => {
      if (this.state.pending)
        throw new Error('Recover or explicitly discard the retained book operation first.');
      const scope = await this.deps.scope(bookId, this.userId);
      this.owned(epoch);
      if (
        !scope.bookRevisionId ||
        !scope.revisionId ||
        !scope.content?.book ||
        scope.content.book.deletedAt
      )
        throw new Error('The owned book snapshot is unavailable.');
      const source = scope.content.book;
      const snapshot: BookCatalogSnapshot = {
        snapshotId: crypto.randomUUID(),
        userId: this.userId,
        bookId,
        bookRevisionId: scope.bookRevisionId,
        structureRevisionId: scope.revisionId,
        sourceBook: structuredClone(source),
        book: {
          id: bookId,
          title: source.title ?? 'Untitled Book',
          summary: source.summary,
          genre: source.genre ?? undefined,
          archetype: source.storyArchetypeKey ?? undefined,
          draftStatus: source.draftStatus ?? undefined,
        },
      };
      this.snapshots.set(snapshot.snapshotId, JSON.stringify(snapshot));
      Object.freeze(snapshot.book);
      return Object.freeze(snapshot);
    });
  }
  private async persist(row: BookCatalogIntent, previous?: BookCatalogIntent): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.enqueue(() => this.deps.write(structuredClone(row), previous?.version));
    } catch (error) {
      if (epoch === this.epoch) this.publish({ journalError: message(error) });
      throw error;
    }
    if (epoch === this.epoch)
      this.publish({
        pending: row,
        retryAllowed: row.status === 'not-found',
        journalError: undefined,
      });
  }
  private async transition(row: BookCatalogIntent, state: BookCatalogIntent['status']) {
    const next = { ...row, version: crypto.randomUUID(), updatedAt: Date.now(), status: state };
    await this.persist(next, row);
    return next;
  }
  private async acknowledge(row: BookCatalogIntent, receipt: BookCatalogReceipt, epoch: number) {
    this.owned(epoch);
    const identity = row.kind === 'delete' ? receipt.result?.bookId : receipt.result?.id;
    if (
      receipt.kind !== 'catalog' ||
      receipt.status !== 'completed' ||
      receipt.operationId !== row.operationId ||
      !receipt.revisionId ||
      String(identity) !== row.bookId
    )
      throw new Error('The receipt does not prove this exact book operation.');
    try {
      await this.enqueue(() => this.deps.remove(row.userId, row.version, row.operationId));
    } catch (error) {
      if (epoch === this.epoch) this.publish({ journalError: message(error) });
      throw error;
    }
    this.owned(epoch);
    this.publish({ pending: undefined, receipt, retryAllowed: false, journalError: undefined });
    return receipt;
  }
  private async dispatch(row: BookCatalogIntent, epoch: number): Promise<BookCatalogReceipt> {
    const sent = await this.transition(row, 'unknown');
    this.owned(epoch);
    try {
      await this.deps.mutate(structuredClone(sent));
    } catch (error) {
      this.owned(epoch);
      // A generic 409 can refer to a completed original nonce; recover it.
      // Authorization/404 failures likewise never prove its absence.
      if ([400, 412, 413, 422, 428].includes(Number(status(error))))
        await this.transition(sent, 'rejected');
      throw error;
    }
    this.owned(epoch);
    // Updates return a projected catalog result; deletion returns a receipt.
    // The owned original receipt endpoint proves either durable outcome.
    const receipt = await this.deps.recover(sent.bookId, sent.operationId, sent.userId);
    return this.acknowledge(sent, receipt, epoch);
  }
  private async change(
    snapshot: BookCatalogSnapshot,
    kind: 'update' | 'delete',
    patch?: BookMetadataPatch,
  ) {
    return this.run(async (epoch) => {
      if (this.state.pending)
        throw new Error('Recover the retained operation before another mutation.');
      if (
        snapshot.userId !== this.userId ||
        this.snapshots.get(snapshot.snapshotId) !== JSON.stringify(snapshot)
      )
        throw new Error('Reopen the owned edit/delete dialog to capture its exact saved snapshot.');
      const operationId = crypto.randomUUID();
      const row: BookCatalogIntent = {
        schemaVersion: 1,
        userId: this.userId,
        bookId: snapshot.bookId,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        operationId,
        kind,
        status: 'prepared',
        snapshot: structuredClone(snapshot),
        ...(patch ? { patch: structuredClone(patch) } : {}),
        preconditions: {
          operationId,
          expectedRevisionId: snapshot.bookRevisionId,
          expectedScopes: { structure: snapshot.structureRevisionId },
        },
      };
      await this.persist(row);
      this.owned(epoch);
      return this.dispatch(row, epoch);
    });
  }
  update = (snapshot: BookCatalogSnapshot, patch: BookMetadataPatch) =>
    this.change(snapshot, 'update', patch);
  remove = (snapshot: BookCatalogSnapshot) => this.change(snapshot, 'delete');
  recover = () =>
    this.run(async (epoch): Promise<BookCatalogReceipt | undefined> => {
      const row = this.state.pending;
      if (!row) return;
      try {
        return await this.acknowledge(
          row,
          await this.deps.recover(row.bookId, row.operationId, row.userId),
          epoch,
        );
      } catch (error) {
        this.owned(epoch);
        if (status(error) !== 404) throw error;
        // A known validation rejection remains terminal after confirming absence.
        // A transport-unknown request's 404 permits continuation, not discard.
        if (row.status !== 'rejected') await this.transition(row, 'not-found');
        this.owned(epoch);
        return;
      }
    });
  retry = () =>
    this.run(async (epoch): Promise<BookCatalogReceipt | undefined> => {
      const row = this.state.pending;
      if (!row || row.status !== 'not-found' || !this.state.retryAllowed)
        throw new Error(
          'Recover the original receipt before explicitly continuing its exact request.',
        );
      // Recheck immediately before continuation: a delayed original commit may
      // have appeared since the first 404. Never issue a fresh operation ID.
      try {
        return await this.acknowledge(
          row,
          await this.deps.recover(row.bookId, row.operationId, row.userId),
          epoch,
        );
      } catch (error) {
        this.owned(epoch);
        if (status(error) !== 404) throw error;
      }
      return this.dispatch(row, epoch);
    });
  discardRejected = () =>
    this.run(async (epoch) => {
      const row = this.state.pending;
      if (!row || row.status !== 'rejected')
        throw new Error('An uncertain operation must be recovered before discarding.');
      await this.enqueue(() => this.deps.remove(row.userId, row.version, row.operationId));
      this.owned(epoch);
      this.publish({ pending: undefined, retryAllowed: false, journalError: undefined });
    });
}
