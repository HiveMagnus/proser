import { describe, expect, it, vi } from 'vitest';
import {
  defaultLayout,
  canonicalDocument,
  type DocumentPassage,
  type DocumentPassageOperationCommit,
  type DocumentPassageRestore,
  type DocumentPassageReceipt,
  type DocumentPassageRestoreResult,
} from '@hivemagnus/proser-contracts';
import {
  PassageTypedSession,
  type PassageTypedReceipt,
  type PassageTypedDependencies,
} from '@/lib/document-passage-typed-session';
import { passageDocument } from '@/lib/document-passage-document';
import type { DocumentPassageDraft } from '@/lib/document-passage-journal';
function window(revision = 'before', text = 'First'): DocumentPassage {
  return {
    schemaVersion: 1,
    sourceFrame: {
      bookId: 1,
      actId: 2,
      chapterId: 3,
      sceneId: 4,
      bookRevisionId: `book-${revision}`,
      sceneRevisionId: `scene-${revision}`,
      bookContentHash: 'a'.repeat(64),
      sceneContentHash: 'b'.repeat(64),
      qualifiedMembershipHash: 'c'.repeat(64),
      effectiveStyleLayoutHash: 'd'.repeat(64),
      structureScope: { revisionId: 'structure', contentHash: 'e'.repeat(64) },
      layoutScope: { revisionId: 'layout', contentHash: 'f'.repeat(64) },
      projection: 'final',
    },
    bookRevisionId: `book-${revision}`,
    sceneId: 4,
    sceneRevisionId: `scene-${revision}`,
    contentHash: 'b'.repeat(64),
    projection: 'final',
    cursor: { paragraph: 0, offset: 0, item: 0 },
    windowHash: '9'.repeat(64),
    images: [],
    changes: [],
    layout: defaultLayout(),
    omitted: { paragraphs: 100000, objects: 0, comments: 0, changes: 0 },
    paragraphs: [
      {
        paragraph: {
          type: 'paragraph',
          id: 'p',
          style: {},
          runs: [{ id: 'r', text, style: { italic: true } }],
        },
        paragraphHash: '1'.repeat(64),
        containerHash: '2'.repeat(64),
        ordinal: 0,
        offset: 0,
        length: text.length,
        continuedBefore: false,
        continuedAfter: false,
        runs: [
          {
            runId: 'r',
            sourceHash: '3'.repeat(64),
            from: 0,
            to: text.length,
            sourceLength: text.length,
          },
        ],
      },
    ],
  };
}
function receipt(request: DocumentPassageOperationCommit): PassageTypedReceipt {
  const passage = window('after', 'First new');
  const reference = {
    sceneId: 4,
    chapterId: 3,
    sceneNumber: 1,
    revisionId: passage.sceneRevisionId,
    contentHash: passage.contentHash,
    wordCount: 300000,
  };
  return {
    kind: 'catalog',
    operationId: request.operationId,
    revisionId: passage.bookRevisionId,
    contentHash: 'a'.repeat(64),
    status: 'completed',
    sceneReferences: [reference],
    manifest: { schemaVersion: 1, scenes: [reference] },
    result: {
      passage,
      operationMappings: [],
      introducedIds: [],
      touched: { blockIds: ['p'], runIds: ['r'], objectIds: [], changeIds: [] },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}
function harness() {
  let row: DocumentPassageDraft | undefined;
  let sequence = 0;
  const dependencies: PassageTypedDependencies = {
    load: vi.fn(async () => window()),
    read: vi.fn(async () => (row ? structuredClone(row) : undefined)),
    write: vi.fn(async (draft, version) => {
      if (
        row &&
        (row.version !== version ||
          (row.pending && canonicalDocument(row.pending) !== canonicalDocument(draft.pending)))
      )
        throw new Error('Competing tab');
      row = structuredClone(draft);
    }),
    advance: vi.fn(async (draft, version, operationId) => {
      if (row?.version !== version || row?.pending?.request.operationId !== operationId)
        throw new Error('Stale acknowledgement');
      row = structuredClone(draft);
    }),
    remove: vi.fn(async (version) => {
      if (row?.version === version) row = undefined;
    }),
    commit: vi.fn(async (request) => receipt(request)),
    recover: vi.fn(async () => undefined),
    restore: vi.fn(async (request) => {
      const result = receipt({
        ...request,
        sourceFrame: window().sourceFrame!,
        operations: [],
      } as DocumentPassageOperationCommit);
      const value: DocumentPassageReceipt<DocumentPassageRestoreResult> = {
        ...result,
        result: {
          passage: window('restored', 'First'),
          restoredFromRevisionId: request.restoreFromRevisionId,
        },
      };
      value.revisionId = value.result.passage.bookRevisionId;
      value.sceneReferences![0]!.revisionId = value.result.passage.sceneRevisionId;
      value.manifest.scenes[0]!.revisionId = value.result.passage.sceneRevisionId;
      return value;
    }),
    id: () => `id-${++sequence}`,
  };
  return {
    session: new PassageTypedSession({ userId: 'owner', bookId: '1', sceneId: '4' }, dependencies),
    dependencies,
    row: () => row,
  };
}
function edit(session: PassageTypedSession, text = 'First new') {
  const document = structuredClone(session.getSnapshot().document!);
  if (document.blocks[0]!.type !== 'paragraph') throw new Error('paragraph');
  document.blocks[0]!.runs[0]!.text = text;
  session.edit(document);
}
describe('active bounded typed passage session', () => {
  it('uses the exact operation UUID and intents disclosed to discussion, with durable pre-dispatch storage', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    const discussion = session.localOperations()!;
    vi.mocked(dependencies.commit).mockImplementation(async (request) => {
      expect(row()?.pending).toEqual({
        kind: 'operations',
        request,
        submittedDocument: row()?.document,
      });
      return receipt(request);
    });
    await session.save(true);
    const request = vi.mocked(dependencies.commit).mock.calls[0]![0];
    expect(request.operationId).toBe(discussion.operationId);
    expect(request.operations).toEqual(discussion.operations);
    expect(request.tracking).toBe(true);
    expect(session.getSnapshot().state).toBe('saved');
    expect(row()).toBeUndefined();
    expect(JSON.stringify(request).length).toBeLessThan(3000);
    expect(request).not.toHaveProperty('document');
  });
  it('retains and rebases same-run typing while Factory saves the earlier exact intent', async () => {
    const { session, dependencies, row } = harness();
    const completion = deferred<PassageTypedReceipt>();
    vi.mocked(dependencies.commit).mockReturnValue(completion.promise);
    await session.load();
    edit(session);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.commit).mock.calls.length === 1);
    edit(session, 'First new more');
    completion.resolve(receipt(vi.mocked(dependencies.commit).mock.calls[0]![0]));
    await saving;
    expect(session.getSnapshot()).toMatchObject({
      state: 'unsaved',
      passage: { sceneRevisionId: 'scene-after' },
      document: { blocks: [{ runs: [{ text: 'First new more', style: { italic: true } }] }] },
    });
    expect(row()?.pending).toBeUndefined();
    expect(row()?.passage.sceneRevisionId).toBe('scene-after');
  });
  it('recovers a lost response without automatically dispatching the effect twice', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    vi.mocked(dependencies.commit).mockRejectedValue(new Error('Lost response'));
    await session.save();
    expect(session.getSnapshot().state).toBe('recoverable');
    const pending = row()?.pending;
    if (pending?.kind !== 'operations') throw new Error('pending');
    await session.recover();
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().state).toBe('recoverable');
    vi.mocked(dependencies.recover).mockResolvedValue(receipt(pending.request));
    await session.recover();
    expect(session.getSnapshot().state).toBe('saved');
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
  });
  it('retains queued typing immediately on logout without dispatching a save', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session, 'First new');
    edit(session, 'First new latest');
    session.dispose();
    await until(() => vi.mocked(dependencies.write).mock.calls.length === 2);
    expect(row()?.document?.blocks[0]).toMatchObject({ runs: [{ text: 'First new latest' }] });
    expect(row()?.userId).toBe('owner');
    expect(session.getSnapshot().state).toBe('inactive');
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it('awaits the previous owned journal when Strict Mode reactivates a session', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session, 'First new');
    session.dispose();
    session.activate();
    await session.load();
    expect(row()?.document?.blocks[0]).toMatchObject({ runs: [{ text: 'First new' }] });
    expect(session.getSnapshot().recovery?.document?.blocks[0]).toMatchObject({
      runs: [{ text: 'First new' }],
    });
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it('acknowledges a completed operation after reload when Factory replaced run identities', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    vi.mocked(dependencies.commit).mockRejectedValue(new Error('Lost response'));
    await session.save();
    const pending = row()!.pending!;
    if (pending.kind !== 'operations') throw new Error('pending');
    const completed = receipt(pending.request);
    completed.result.passage.paragraphs[0]!.paragraph.runs[0]!.id = 'committed-run';
    completed.result.passage.paragraphs[0]!.runs[0]!.runId = 'committed-run';
    vi.mocked(dependencies.load).mockResolvedValue(completed.result.passage);
    vi.mocked(dependencies.recover).mockResolvedValue(completed);
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await reopened.load();
    await reopened.recover();
    expect(reopened.getSnapshot()).toMatchObject({
      state: 'saved',
      document: { blocks: [{ runs: [{ id: 'committed-run', text: 'First new' }] }] },
    });
    expect(row()).toBeUndefined();
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
  });
  it('retains post-dispatch typing when recovering a reopened journal', async () => {
    const { session, dependencies, row } = harness();
    const completion = deferred<PassageTypedReceipt>();
    vi.mocked(dependencies.commit).mockReturnValue(
      completion.promise.then(() => {
        throw new Error('Lost response');
      }),
    );
    await session.load();
    edit(session);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.commit).mock.calls.length === 1);
    edit(session, 'First new more');
    const completed = receipt(vi.mocked(dependencies.commit).mock.calls[0]![0]);
    completion.resolve(completed);
    await saving;
    vi.mocked(dependencies.load).mockResolvedValue(completed.result.passage);
    vi.mocked(dependencies.recover).mockResolvedValue(completed);
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await reopened.load();
    await reopened.recover();
    expect(reopened.getSnapshot()).toMatchObject({
      state: 'unsaved',
      document: { blocks: [{ runs: [{ text: 'First new more', style: { italic: true } }] }] },
    });
    expect(row()?.pending).toBeUndefined();
    expect(row()?.passage.sceneRevisionId).toBe('scene-after');
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
  });
  it('keeps a later remote revision and the retained draft for explicit reconciliation', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    vi.mocked(dependencies.commit).mockRejectedValue(new Error('Lost response'));
    await session.save();
    const pending = row()!.pending!;
    if (pending.kind !== 'operations') throw new Error('pending');
    vi.mocked(dependencies.load).mockResolvedValue(window('later', 'Remote newer'));
    vi.mocked(dependencies.recover).mockResolvedValue(receipt(pending.request));
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await reopened.load();
    await reopened.recover();
    expect(reopened.getSnapshot()).toMatchObject({
      state: 'conflict',
      currentSaved: {
        passage: { sceneRevisionId: 'scene-later' },
        document: { blocks: [{ runs: [{ text: 'Remote newer' }] }] },
      },
    });
    expect(row()?.pending).toEqual(pending);
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
  });
  it('restores complete Factory-side scene revisions for undo without transporting scene bodies', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    await session.save();
    expect(session.getSnapshot().canUndo).toBe(true);
    vi.mocked(dependencies.restore).mockImplementation(async (request: DocumentPassageRestore) => {
      expect(row()?.pending).toEqual({ kind: 'restore', request });
      const base = receipt({
        ...request,
        sourceFrame: window().sourceFrame!,
        operations: [],
      } as DocumentPassageOperationCommit);
      const passage = window('restored', 'First');
      base.revisionId = passage.bookRevisionId;
      base.sceneReferences![0]!.revisionId = passage.sceneRevisionId;
      base.manifest.scenes[0]!.revisionId = passage.sceneRevisionId;
      return {
        ...base,
        result: { passage, restoredFromRevisionId: request.restoreFromRevisionId },
      };
    });
    await session.undoRevision();
    expect(dependencies.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        restoreFromRevisionId: 'scene-before',
        expectedSceneRevisionId: 'scene-after',
      }),
    );
    expect(session.getSnapshot()).toMatchObject({
      state: 'saved',
      canRedo: true,
      canUndo: false,
      passage: { sceneRevisionId: 'scene-restored' },
    });
    expect(row()).toBeUndefined();
  });
  it('registers an exactly recovered editorial acknowledgement once and refuses newer scene history', async () => {
    const { session, dependencies } = harness();
    vi.mocked(dependencies.load).mockResolvedValue(window('after', 'First new'));
    await session.load();
    session.registerReviewAcknowledgement('scene-before', window('after', 'First new'));
    session.registerReviewAcknowledgement('scene-before', window('after', 'First new'));
    await session.undoRevision();
    expect(dependencies.restore).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().canUndo).toBe(false);
    const newer = harness();
    await newer.session.load();
    newer.session.registerReviewAcknowledgement('scene-before', window('after', 'First new'));
    vi.mocked(newer.dependencies.load).mockResolvedValue(window('newer', 'Third-party work'));
    await newer.session.navigate({ paragraph: 0, offset: 0 });
    await expect(newer.session.undoRevision()).rejects.toThrow('Newer scene work');
    expect(newer.dependencies.restore).not.toHaveBeenCalled();
    expect(() =>
      newer.session.registerReviewAcknowledgement('scene-before', window('after', 'First new')),
    ).toThrow('scene changed');
  });
  it('retains the exact AI derivative UUID and intents across interruption before flush', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    const frozen = session.localOperations()!;
    await session.retainLocalOperations(frozen);
    expect(row()?.prepared).toMatchObject({
      operationId: frozen.operationId,
      operations: frozen.operations,
    });
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await reopened.load();
    await reopened.restoreLocalDraft();
    expect(reopened.localOperations()).toEqual(frozen);
    await reopened.save();
    expect(dependencies.commit).toHaveBeenCalledWith(expect.objectContaining(frozen));
  });
  it('refuses stale inference intents and tampered recovered derivative bodies', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    const frozen = session.localOperations()!;
    edit(session, 'First different');
    await expect(session.retainLocalOperations(frozen)).rejects.toThrow('draft changed');
    await session.retainLocalOperations(session.localOperations()!);
    const retained = row()!;
    if (retained.document!.blocks[0]!.type !== 'paragraph') throw new Error('paragraph');
    retained.document!.blocks[0]!.runs[0]!.text = 'Tampered derivative';
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await reopened.load();
    await expect(reopened.restoreLocalDraft()).rejects.toThrow('retained AI derivative');
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(reopened.getSnapshot().state).toBe('recoverable');
  });
  it('refuses a draft that changes during the durable context fence', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    const frozen = session.localOperations()!;
    await session.retainLocalOperations(frozen);
    const gate = deferred<void>();
    const original = vi.mocked(dependencies.write).getMockImplementation()!;
    vi.mocked(dependencies.write).mockImplementation(async (...args) => {
      await gate.promise;
      await original(...args);
    });
    const retaining = session.retainLocalOperations(frozen);
    await until(() => vi.mocked(dependencies.write).mock.calls.length >= 3);
    edit(session, 'First late change');
    gate.resolve();
    await expect(retaining).rejects.toThrow('draft changed while retaining');
    await until(
      () => row()?.prepared?.documentKey === canonicalDocument(session.getSnapshot().document),
    );
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it('adopts the exact pinned AI application receipt once for complete saved undo', async () => {
    const { session, dependencies } = harness();
    await session.load();
    const applied = window('after', 'First new');
    const proof = {
      kind: 'catalog' as const,
      status: 'completed' as const,
      operationId: 'ai-application',
      revisionId: applied.bookRevisionId,
      contentHash: 'a'.repeat(64),
      sceneReferences: [
        {
          sceneId: 4,
          chapterId: 3,
          sceneNumber: 1,
          revisionId: applied.sceneRevisionId,
          contentHash: applied.contentHash,
          wordCount: 2,
        },
      ],
      result: {
        sceneId: 4,
        sourceBookRevisionId: 'book-before',
        sourceSceneRevisionId: 'scene-before',
      },
    };
    vi.mocked(dependencies.load).mockResolvedValue(applied);
    await session.acknowledgeExternalApplication(proof, 'scene-before');
    await session.acknowledgeExternalApplication(proof, 'scene-before');
    expect(dependencies.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookRevisionId: 'book-after', projection: 'final' }),
    );
    await session.undoRevision();
    await session.undoRevision();
    expect(dependencies.restore).toHaveBeenCalledTimes(1);
    expect(dependencies.restore).toHaveBeenCalledWith(
      expect.objectContaining({ restoreFromRevisionId: 'scene-before' }),
    );
    await expect(
      session.acknowledgeExternalApplication({ ...proof, contentHash: '0'.repeat(64) }),
    ).rejects.toThrow('immutable receipt');
  });
  it('does not dispatch when the IndexedDB journal fails and hides late acknowledgements after account change', async () => {
    const broken = harness();
    await broken.session.load();
    vi.mocked(broken.dependencies.write).mockRejectedValue(new Error('Unavailable storage'));
    edit(broken.session);
    await broken.session.save();
    expect(broken.dependencies.commit).not.toHaveBeenCalled();
    expect(broken.session.getSnapshot().state).toBe('failed');
    const { session, dependencies, row } = harness();
    const completion = deferred<PassageTypedReceipt>();
    vi.mocked(dependencies.commit).mockReturnValue(completion.promise);
    await session.load();
    edit(session);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.commit).mock.calls.length === 1);
    session.dispose();
    completion.resolve(receipt(vi.mocked(dependencies.commit).mock.calls[0]![0]));
    await saving;
    expect(session.getSnapshot().state).toBe('inactive');
    expect(row()?.pending).toBeDefined();
    expect(dependencies.remove).not.toHaveBeenCalled();
  });
  it('retains typing that arrives during local acknowledgement instead of falsely displaying Saved', async () => {
    const { session, dependencies, row } = harness();
    const deleting = deferred<void>();
    const original = vi.mocked(dependencies.remove).getMockImplementation()!;
    vi.mocked(dependencies.remove).mockImplementation(async (version) => {
      await deleting.promise;
      await original(version);
    });
    await session.load();
    edit(session);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.remove).mock.calls.length === 1);
    edit(session, 'First new late');
    deleting.resolve();
    await saving;
    expect(session.getSnapshot().state).toBe('conflict');
    expect(row()?.pending).toBeDefined();
    expect(row()?.document).toEqual(session.getSnapshot().document);
  });
  it('qualifies one native paragraph split and pauses structural input until authoritative IDs return', async () => {
    const { session } = harness();
    await session.load();
    const document = passageDocument(window());
    if (document.blocks[0]!.type !== 'paragraph') throw new Error('paragraph');
    document.blocks[0]!.runs[0]!.text = 'Fi';
    document.blocks.push({
      type: 'paragraph',
      id: 'local-right',
      style: {},
      runs: [{ id: 'local-right-run', text: 'rst', style: { italic: true } }],
    });
    session.edit(document);
    expect(session.localOperations()?.operations).toEqual([
      expect.objectContaining({
        kind: 'paragraph-split',
        target: expect.objectContaining({ blockId: 'p', runId: 'r', from: 2, to: 2 }),
      }),
    ]);
    expect(session.getSnapshot().structuralFlight).toBe(true);
    expect(() => session.edit(document)).toThrow('recover');
  });
  it('waits for a retiring same-owner session to retain post-dispatch typing before reopening', async () => {
    const { session, dependencies, row } = harness();
    const completion = deferred<PassageTypedReceipt>();
    const retaining = deferred<void>();
    const originalWrite = vi.mocked(dependencies.write).getMockImplementation()!;
    vi.mocked(dependencies.commit).mockReturnValue(completion.promise);
    vi.mocked(dependencies.write).mockImplementation(async (draft, version) => {
      const first = draft.document?.blocks[0];
      if (first?.type === 'paragraph' && first.runs[0]?.text === 'First new latest')
        await retaining.promise;
      await originalWrite(draft, version);
    });
    await session.load();
    edit(session);
    const saving = session.save();
    await until(() => vi.mocked(dependencies.commit).mock.calls.length === 1);
    const request = vi.mocked(dependencies.commit).mock.calls[0]![0];
    const exactPending = structuredClone(row()!.pending);
    edit(session, 'First new latest');
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    const opening = reopened.load();
    try {
      await until(() =>
        vi.mocked(dependencies.write).mock.calls.some(([draft]) => {
          const first = draft.document?.blocks[0];
          return first?.type === 'paragraph' && first.runs[0]?.text === 'First new latest';
        }),
      );
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(dependencies.read).toHaveBeenCalledTimes(1);
      expect(reopened.getSnapshot().state).toBe('loading');
    } finally {
      retaining.resolve();
    }
    await opening;
    expect(reopened.getSnapshot().recovery?.document?.blocks[0]).toMatchObject({
      runs: [{ text: 'First new latest' }],
    });
    expect(row()?.pending).toEqual(exactPending);
    completion.resolve(receipt(request));
    await saving;
    expect(session.getSnapshot()).toEqual({ state: 'inactive', canUndo: false, canRedo: false });
    expect(dependencies.remove).not.toHaveBeenCalled();
    vi.mocked(dependencies.recover).mockResolvedValue(receipt(request));
    await reopened.recover();
    expect(reopened.getSnapshot()).toMatchObject({
      state: 'unsaved',
      document: { blocks: [{ runs: [{ text: 'First new latest' }] }] },
      passage: { sceneRevisionId: 'scene-after' },
    });
    expect(row()?.pending).toBeUndefined();
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
    expect(dependencies.recover).toHaveBeenCalledWith(request.operationId);
    reopened.dispose();
  });
  it('does not let another authenticated identity wait for or reveal a retiring owner draft', async () => {
    const { session, dependencies, row } = harness();
    const retaining = deferred<void>();
    const originalWrite = vi.mocked(dependencies.write).getMockImplementation()!;
    vi.mocked(dependencies.write).mockImplementation(async (draft, version) => {
      await retaining.promise;
      await originalWrite(draft, version);
    });
    await session.load();
    edit(session, 'Private owner draft');
    session.dispose();
    const foreignDependencies = { ...dependencies, read: vi.fn(async () => undefined) };
    const foreign = new PassageTypedSession(
      { userId: 'different-authenticated-owner', bookId: '1', sceneId: '4' },
      foreignDependencies,
    );
    try {
      await foreign.load();
      expect(foreign.getSnapshot()).toMatchObject({ state: 'saved', recovery: undefined });
      expect(foreignDependencies.read).toHaveBeenCalledTimes(1);
      expect(foreign.getSnapshot().document?.blocks[0]).toMatchObject({
        runs: [{ text: 'First' }],
      });
    } finally {
      retaining.resolve();
    }
    await until(() => Boolean(row()));
    expect(row()?.userId).toBe('owner');
    expect(row()?.document?.blocks[0]).toMatchObject({ runs: [{ text: 'Private owner draft' }] });
    foreign.dispose();
    const tampered = new PassageTypedSession(
      { userId: 'different-authenticated-owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await tampered.load();
    expect(tampered.getSnapshot().state).toBe('failed');
    expect(tampered.getSnapshot().document).toBeUndefined();
    expect(tampered.getSnapshot().recovery).toBeUndefined();
    expect(dependencies.commit).not.toHaveBeenCalled();
    tampered.dispose();
  });
  it('keeps the original operation recoverable when a competing journal rejects acknowledgement deletion', async () => {
    const { session, dependencies, row } = harness();
    await session.load();
    edit(session);
    vi.mocked(dependencies.remove).mockRejectedValue(new Error('Journal version changed'));
    await session.save();
    expect(session.getSnapshot().state).toBe('recoverable');
    expect(row()?.pending?.request.operationId).toBe(
      vi.mocked(dependencies.commit).mock.calls[0]![0].operationId,
    );
    expect(session.getSnapshot().error).toContain('Journal version changed');
    session.dispose();
    const reopened = new PassageTypedSession(
      { userId: 'owner', bookId: '1', sceneId: '4' },
      dependencies,
    );
    await reopened.load();
    expect(reopened.getSnapshot().state).toBe('recoverable');
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
    reopened.dispose();
  });
});
