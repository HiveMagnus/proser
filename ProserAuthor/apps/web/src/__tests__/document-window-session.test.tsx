import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentFromText,
  projectDocument,
  type SceneDocumentReference,
} from '@cheftaco/proser-editor';
import { useDocumentWindowSession } from '@/hooks/use-document-window-session';
import {
  DocumentRequestError,
  getSceneDocument,
  recoverDocumentSave,
  saveSceneDocument,
  type SaveDocumentReceipt,
  type SaveDocumentRequest,
  type SavedSceneDocument,
} from '@/lib/document-api';
import { readDocumentDraft, writeDocumentDraft } from '@/lib/document-drafts';
vi.mock('@/lib/document-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-api')>('@/lib/document-api')),
  getSceneDocument: vi.fn(),
  recoverDocumentSave: vi.fn(),
  saveSceneDocument: vi.fn(),
}));
vi.mock('@/lib/document-drafts', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-drafts')>('@/lib/document-drafts')),
  readDocumentDraft: vi.fn(),
  writeDocumentDraft: vi.fn(),
  deleteDocumentDraft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/document-window-history', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-window-history')>(
    '@/lib/document-window-history',
  )),
  readWindowHistory: vi.fn().mockResolvedValue(undefined),
  writeWindowHistory: vi.fn().mockResolvedValue('history-key'),
}));
let sequence = 0;
const id = () => `window-${++sequence}`;
let source: SavedSceneDocument[];
const references = (): SceneDocumentReference[] =>
  source.map((scene) => ({
    sceneId: scene.sceneId,
    chapterId: 1,
    sceneNumber: scene.sceneId,
    revisionId: scene.revisionId,
    contentHash: scene.contentHash,
    wordCount: 1,
  }));
const receipt = (request: SaveDocumentRequest): SaveDocumentReceipt => ({
  kind: 'commit',
  operationId: request.operationId,
  status: 'completed',
  revisionId: 'book-2',
  scenes: request.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    revisionId: `scene-${scene.sceneId}-2`,
    contentHash: `hash-${scene.sceneId}-2`,
    document: scene.document,
    text: '',
    wordCount: 1,
  })),
});
beforeEach(() => {
  vi.clearAllMocks();
  sequence = 0;
  source = [1, 2, 3].map((sceneId) => ({
    sceneId,
    revisionId: `scene-${sceneId}-1`,
    bookRevisionId: 'book-1',
    contentHash: `hash-${sceneId}-1`,
    document: documentFromText(`Scene ${sceneId}\n\nRemaining ${sceneId}`, id),
    projection: { text: '', wordCount: 1, spans: [] },
  }));
  vi.mocked(getSceneDocument).mockImplementation(async (_book, scene) =>
    structuredClone(source[Number(scene) - 1]!),
  );
  vi.mocked(readDocumentDraft).mockResolvedValue(undefined);
  vi.mocked(writeDocumentDraft).mockResolvedValue('draft-key');
  vi.mocked(recoverDocumentSave).mockRejectedValue(new DocumentRequestError('Not committed', 404));
  vi.mocked(saveSceneDocument).mockImplementation(async (_book, request) => receipt(request));
});
describe('atomic bounded editing windows', () => {
  it('refreshes only a manifest-proven unchanged window head after a layout commit', async () => {
    const refs = references();
    const hook = renderHook(
      ({ head, refs }) => useDocumentWindowSession('window-user', '1', refs, head),
      { initialProps: { head: 'book-1', refs } },
    );
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    hook.rerender({ head: 'layout-book-2', refs });
    await waitFor(() =>
      expect(hook.result.current.sessions[0]!.saved!.bookRevisionId).toBe('layout-book-2'),
    );
    const first = structuredClone(hook.result.current.sessions[0]!.document!);
    const block = first.blocks[0];
    if (block?.type !== 'paragraph') throw new Error('fixture');
    block.runs[0]!.text += ' edited';
    act(() => hook.result.current.sessions[0]!.change(first));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(vi.mocked(saveSceneDocument).mock.calls[0]![1].expectedRevisionId).toBe('layout-book-2');
    const changed = refs.map((ref, index) =>
      index === 2 ? { ...ref, revisionId: 'changed-remote-scene' } : ref,
    );
    hook.rerender({ head: 'unsafe-book-head', refs: changed });
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.sessions[1]!.saved!.bookRevisionId).not.toBe('unsafe-book-head');
  });
  it('moves a canonical block, saves both scopes once and undoes both after acknowledgement', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(getSceneDocument).toHaveBeenCalledTimes(3);
    const blockId = source[0]!.document.blocks[0]!.id;
    act(() => hook.result.current.move('1', '2', [blockId], 'end'));
    expect(hook.result.current.sessions[0]!.document!.blocks).toHaveLength(1);
    expect(hook.result.current.sessions[1]!.document!.blocks.at(-1)!.id).toBe(blockId);
    await act(async () => {
      await hook.result.current.save();
    });
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    expect(request.scenes.map((scene) => scene.sceneId)).toEqual([1, 2]);
    expect(request.expectedRevisionId).toBe('book-1');
    const staged = vi
      .mocked(writeDocumentDraft)
      .mock.calls.map(([draft]) => draft)
      .filter((draft) => draft.pendingSave?.operationId === request.operationId);
    expect(new Set(staged.map((draft) => draft.sceneId))).toEqual(new Set(['1', '2']));
    expect(staged.every((draft) => draft.pendingSave!.scenes.length === 2)).toBe(true);
    await waitFor(() => expect(hook.result.current.sessions[0]!.canUndo).toBe(true));
    act(() => hook.result.current.sessions[0]!.undo());
    expect(hook.result.current.sessions[0]!.document).toEqual(source[0]!.document);
    expect(hook.result.current.sessions[1]!.document).toEqual(source[1]!.document);
    await act(async () => {
      await hook.result.current.save();
    });
    expect(vi.mocked(saveSceneDocument).mock.calls[1]![1]).toMatchObject({
      expectedRevisionId: 'book-2',
    });
    const restoration = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(restoration.scenes).toHaveLength(2);
    expect(restoration.scenes.map((scene) => scene.restoreFromRevisionId)).toEqual([
      'scene-1-1',
      'scene-2-1',
    ]);
    expect(restoration.anchorLineage?.every((mapping) => mapping.kind === 'restore')).toBe(true);
  });
  it('splits adjacent scenes with immutable lineage and saves both bodies before later input', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(saveSceneDocument).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.split('1', '2', source[0]!.document.blocks[0]!.id, 5);
    });
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    expect(request.scenes.map((scene) => scene.sceneId)).toEqual([1, 2]);
    expect(request.anchorLineage?.[0]).toMatchObject({
      kind: 'split',
      source: { sceneId: 1, from: 5, to: 7 },
      target: { sceneId: 2, from: 0, to: 2 },
    });
    expect(projectDocument(hook.result.current.sessions[0]!.document!).text).toBe('Scene');
    expect(projectDocument(hook.result.current.sessions[1]!.document!).text).toBe(
      ' 1\n\nRemaining 1\n\nScene 2\n\nRemaining 2',
    );
    await waitFor(() => expect(hook.result.current.sessions[0]!.canUndo).toBe(true));
    await act(async () => {
      hook.result.current.sessions[0]!.undo();
      await hook.result.current.save();
    });
    const restored = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(restored.scenes.map((scene) => scene.restoreFromRevisionId)).toEqual([
      'scene-1-1',
      'scene-2-1',
    ]);
    expect(
      restored.anchorLineage?.some(
        (mapping) => mapping.kind === 'restore' && mapping.source.runId !== mapping.target.runId,
      ),
    ).toBe(true);
  });
  it('joins adjacent physical paragraphs and records a direct manual boundary without deleting either scene', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(async () => {
      await hook.result.current.join('1', '2');
    });
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    expect(request.scenes.map((scene) => scene.sceneId)).toEqual([1, 2]);
    expect(request.anchorLineage?.every((mapping) => mapping.kind === 'join')).toBe(true);
    expect(projectDocument(hook.result.current.sessions[0]!.document!).text).toBe(
      'Scene 1\n\nRemaining 1Scene 2',
    );
    expect(hook.result.current.sessions[0]!.document!.changes.at(-1)).toMatchObject({
      kind: 'paragraphJoin',
      status: 'accepted',
      origin: 'manual',
    });
    expect(projectDocument(hook.result.current.sessions[1]!.document!).text).toBe('Remaining 2');
  });
  it('recovers an interrupted atomic commit using the same operation without duplicate dispatch', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    act(() => hook.result.current.move('1', '2', [source[0]!.document.blocks[0]!.id], 'start'));
    vi.mocked(saveSceneDocument).mockRejectedValueOnce(new TypeError('Lost acknowledgement'));
    await act(async () => {
      await hook.result.current.save();
    });
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    expect(hook.result.current.sessions[0]!.canUndo).toBe(false);
    expect(hook.result.current.sessions[1]!.state).toBe('failed');
    vi.mocked(recoverDocumentSave).mockResolvedValueOnce(receipt(request));
    await act(async () => {
      await hook.result.current.save();
    });
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
    expect(recoverDocumentSave).toHaveBeenLastCalledWith('1', request.operationId);
    await waitFor(() =>
      expect(hook.result.current.sessions.every((scene) => scene.state === 'saved')).toBe(true),
    );
  });
});

describe('window concurrency and identity isolation', () => {
  it('retains edits made during an atomic save and then commits only their remaining scope', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    act(() => hook.result.current.move('1', '2', [source[0]!.document.blocks[0]!.id], 'end'));
    let complete!: (value: SaveDocumentReceipt) => void;
    vi.mocked(saveSceneDocument).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.save();
    });
    await waitFor(() => expect(saveSceneDocument).toHaveBeenCalledTimes(1));
    const request = vi.mocked(saveSceneDocument).mock.calls[0]![1];
    const typed = structuredClone(hook.result.current.sessions[0]!.document!);
    const paragraph = typed.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0]!.text += ' after dispatch';
    act(() => hook.result.current.sessions[0]!.change(typed));
    await act(async () => {
      complete(receipt(request));
      await saving;
    });
    expect(hook.result.current.sessions[0]!.document).toEqual(typed);
    expect(hook.result.current.sessions[0]!.state).toBe('unsaved');
    await act(async () => {
      await hook.result.current.save();
    });
    const remaining = vi.mocked(saveSceneDocument).mock.calls[1]![1];
    expect(remaining.scenes.map((scene) => scene.sceneId)).toEqual([1]);
    expect(remaining.expectedRevisionId).toBe('book-2');
    expect(remaining.scenes[0]!.expectedRevisionId).toBe('scene-1-2');
  });
  it('retains both versions on a stale multi-scene commit and does not fall back to a single-scene proposal flush', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    act(() => hook.result.current.move('1', '2', [source[0]!.document.blocks[0]!.id], 'end'));
    vi.mocked(saveSceneDocument).mockRejectedValueOnce(
      new DocumentRequestError('Newer book head', 412),
    );
    await act(async () => {
      await hook.result.current.save();
    });
    expect(hook.result.current.sessions[0]!.state).toBe('conflict');
    expect(hook.result.current.sessions[1]!.state).toBe('conflict');
    expect(hook.result.current.sessions[0]!.document!.blocks).toHaveLength(1);
    expect(hook.result.current.sessions[1]!.document!.blocks).toHaveLength(3);
    await act(async () => {
      await expect(hook.result.current.sessions[0]!.flush()).rejects.toThrow('reconcile');
    });
    expect(saveSceneDocument).toHaveBeenCalledTimes(1);
  });
  it('hides the previous authenticated actor operation history immediately', async () => {
    const hook = renderHook(({ actor }) => useDocumentWindowSession(actor, '1', references()), {
      initialProps: { actor: 'first-user' },
    });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    act(() => hook.result.current.move('1', '2', [source[0]!.document.blocks[0]!.id], 'end'));
    expect(hook.result.current.sessions[0]!.canUndo).toBe(true);
    hook.rerender({ actor: 'second-user' });
    expect(hook.result.current.sessions[0]!.canUndo).toBe(false);
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(hook.result.current.sessions[0]!.document).toEqual(source[0]!.document);
    expect(hook.result.current.sessions[0]!.canUndo).toBe(false);
  });
});

describe('bounded window rendering', () => {
  it('keeps unaffected scene adapters stable during continuing input', async () => {
    const hook = renderHook(() => useDocumentWindowSession('window-user', '1', references()));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    const edit = () => {
      const next = structuredClone(hook.result.current.sessions[0]!.document!);
      const paragraph = next.blocks[0];
      if (paragraph?.type !== 'paragraph') throw new Error('fixture');
      paragraph.runs[0]!.text += ' typed';
      act(() => hook.result.current.sessions[0]!.change(next));
    };
    edit();
    const second = hook.result.current.sessions[1];
    const third = hook.result.current.sessions[2];
    edit();
    expect(hook.result.current.sessions[1]).toBe(second);
    expect(hook.result.current.sessions[2]).toBe(third);
  });
});
