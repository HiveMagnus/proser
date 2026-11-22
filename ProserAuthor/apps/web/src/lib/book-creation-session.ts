import { createBook, FactoryRequestError, type Book } from './api';
import {
  recoverDocumentBookCreation,
  getAuthoringDocumentCapabilities,
  DocumentRequestError,
} from './document-api';
import {
  readBookCreationIntent,
  writeBookCreationIntent,
  deleteBookCreationIntent,
  type BookCreationIntent,
  type BookCreationRequest,
} from './book-creation-intent';
export interface BookCreationState {
  userId: string;
  ready: boolean;
  busy: boolean;
  pending?: BookCreationIntent;
  retryAllowed: boolean;
  error?: string;
}
/** No automatic POST retries: immutable request/operation and durable receipts
 * are the recovery authority, including after remount and acknowledgement loss. */
export class BookCreationSession {
  private row?: BookCreationIntent;
  private loaded = false;
  private loading?: Promise<void>;
  private busy = false;
  private absent = false;
  private error?: string;
  constructor(
    private readonly userId: string,
    private readonly owned: () => boolean,
    private readonly changed: (state: BookCreationState) => void,
  ) {}
  snapshot(): BookCreationState {
    return {
      userId: this.userId,
      ready: this.loaded,
      busy: this.busy,
      pending: this.row && structuredClone(this.row),
      retryAllowed: this.absent && this.row?.state === 'retryable',
      error: this.error,
    };
  }
  private check() {
    if (!this.userId || !this.owned())
      throw new Error('Authenticate as the same author before continuing book creation.');
  }
  private publish() {
    if (this.owned()) this.changed(this.snapshot());
  }
  async load(): Promise<void> {
    this.check();
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.row = await readBookCreationIntent(this.userId);
        this.check();
        this.loaded = true;
        this.error = undefined;
      } catch (error) {
        this.loading = undefined;
        this.error =
          error instanceof Error ? error.message : 'Unable to open book creation recovery.';
        throw error;
      } finally {
        this.publish();
      }
    })();
    return this.loading;
  }
  private async run<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    if (this.busy) throw new Error('Book creation recovery is already in progress.');
    this.busy = true;
    this.error = undefined;
    this.publish();
    try {
      await this.load();
      this.check();
      return await action();
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : 'Book creation failed. Recover the original operation.';
      throw error;
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  private async transition(state: BookCreationIntent['state']) {
    this.check();
    if (!this.row) throw new Error('No pending book creation is available.');
    const previous = this.row;
    const next = { ...previous, state, version: crypto.randomUUID(), updatedAt: Date.now() };
    await writeBookCreationIntent(next, previous.version);
    this.check();
    this.row = next;
    this.publish();
  }
  private async finish(book: Book): Promise<{ data: Book }> {
    this.check();
    const row = this.row;
    if (!row || !book.id || book.title !== row.request.title)
      throw new Error('The acknowledgement does not match the original book creation request.');
    await deleteBookCreationIntent(this.userId, row.operationId, row.version);
    this.check();
    this.row = undefined;
    this.absent = false;
    this.publish();
    return { data: book };
  }
  private async requireAuthority() {
    this.check();
    const capabilities = await getAuthoringDocumentCapabilities();
    this.check();
    if (!capabilities.enabled || capabilities.schemaVersion !== 1)
      throw new Error(
        'Project creation requires compatible structured document authority. Factory is inactive or advertises an unsupported schema.',
      );
  }
  private async dispatch() {
    // Capability negotiation is outside mutation rejection handling: failure
    // cannot make a previously sent nonce discardable or change its request.
    await this.requireAuthority();
    this.absent = false;
    await this.transition('dispatched');
    this.check();
    const row = this.row!;
    try {
      const result = await createBook(
        { ...row.request, operationId: row.operationId },
        this.userId,
      );
      this.check();
      return await this.finish(result.data);
    } catch (error) {
      this.check();
      if (error instanceof FactoryRequestError && [400, 412, 413, 422, 428].includes(error.status))
        await this.transition('rejected');
      throw error;
    }
  }
  create(request: BookCreationRequest) {
    return this.run(async () => {
      if (this.row)
        throw new Error('Recover the pending book creation before creating another project.');
      await this.requireAuthority();
      const row: BookCreationIntent = {
        schemaVersion: 1,
        userId: this.userId,
        operationId: crypto.randomUUID(),
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        request: JSON.parse(JSON.stringify(request)) as BookCreationRequest,
        state: 'prepared',
      };
      try {
        await writeBookCreationIntent(row);
        this.check();
        this.row = row;
        this.publish();
      } catch (error) {
        this.row = await readBookCreationIntent(this.userId);
        this.check();
        this.publish();
        throw error;
      }
      return this.dispatch();
    });
  }
  recover() {
    return this.run(async () => {
      const row = this.row;
      if (!row) throw new Error('No pending book creation is available for this author.');
      this.absent = false;
      try {
        const receipt = await recoverDocumentBookCreation(row.operationId, this.userId);
        this.check();
        if (
          receipt.operationId !== row.operationId ||
          receipt.status !== 'completed' ||
          !Number.isSafeInteger(receipt.bookId) ||
          receipt.bookId <= 0 ||
          !receipt.revisionId ||
          receipt.title !== row.request.title
        )
          throw new Error(
            'The recovered receipt does not match the original book creation request.',
          );
        return await this.finish({
          id: String(receipt.bookId),
          title: receipt.title ?? 'Untitled Book',
          genre: row.request.genre,
          archetype: row.request.archetype,
          summary: row.request.summary ?? null,
          wordCount: 0,
          draftStatus: 'draft',
        });
      } catch (error) {
        this.check();
        if (error instanceof DocumentRequestError && error.status === 404) {
          await this.transition('retryable');
          this.absent = true;
          this.publish();
          return undefined;
        }
        throw error;
      }
    });
  }
  retry() {
    return this.run(async () => {
      if (!this.row || !this.absent || this.row.state !== 'retryable')
        throw new Error('Recover the original operation before explicitly retrying it.');
      return this.dispatch();
    });
  }
  discardRejected() {
    return this.run(async () => {
      const row = this.row;
      if (!row || row.state !== 'rejected')
        throw new Error('Recover uncertain book creation operations before discarding them.');
      await deleteBookCreationIntent(this.userId, row.operationId, row.version);
      this.check();
      this.row = undefined;
      this.absent = false;
      this.publish();
    });
  }
}
