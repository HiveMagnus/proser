import { StrictMode, type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultLayout,
  type DocumentPassage,
  type DocumentPassageCommit,
  type DocumentPassageReceipt,
} from '@cheftaco/proser-contracts';
import { usePassageSession } from '@/hooks/use-passage-session';
import { getScenePassage, saveScenePassage } from '@/lib/document-passage-api';
import {
  readDocumentPassageDraft,
  writeDocumentPassageDraft,
  deleteDocumentPassageDraft,
} from '@/lib/document-passage-journal';
vi.mock('@/lib/document-passage-api', async () => ({
  ...(await vi.importActual('@/lib/document-passage-api')),
  getScenePassage: vi.fn(),
  saveScenePassage: vi.fn(),
  recoverScenePassage: vi.fn(),
}));
vi.mock('@/lib/document-passage-journal', () => ({
  readDocumentPassageDraft: vi.fn(),
  writeDocumentPassageDraft: vi.fn(),
  deleteDocumentPassageDraft: vi.fn(),
  acknowledgeDocumentPassageDraft: vi.fn(),
}));
const identity = { userId: 'trusted-user', bookId: '1', sceneId: '4' };
function passage(revision = 'before', text = 'Seed'): DocumentPassage {
  return {
    schemaVersion: 1,
    sourceFrame: {
      bookId: 1,
      actId: 2,
      chapterId: 3,
      sceneId: 4,
      bookRevisionId: revision,
      sceneRevisionId: revision,
      bookContentHash: 'a'.repeat(64),
      sceneContentHash: 'b'.repeat(64),
      qualifiedMembershipHash: 'c'.repeat(64),
      effectiveStyleLayoutHash: 'd'.repeat(64),
      structureScope: { revisionId: 'structure', contentHash: 'e'.repeat(64) },
      layoutScope: { revisionId: 'layout', contentHash: 'f'.repeat(64) },
      projection: 'final',
    },
    bookRevisionId: revision,
    sceneRevisionId: revision,
    sceneId: 4,
    contentHash: 'b'.repeat(64),
    projection: 'final',
    cursor: { paragraph: 0, offset: 0 },
    paragraphs: [
      {
        paragraph: {
          type: 'paragraph',
          id: 'paragraph',
          style: {},
          runs: [{ id: 'run', text, style: {} }],
        },
        ordinal: 0,
        offset: 0,
        length: text.length,
        continuedBefore: false,
        continuedAfter: false,
        runs: [
          {
            runId: 'run',
            sourceHash: 'a'.repeat(64),
            from: 0,
            to: text.length,
            sourceLength: text.length,
          },
        ],
      },
    ],
    images: [],
    changes: [],
    omitted: { paragraphs: 100, comments: 0, changes: 0, objects: 0 },
    layout: defaultLayout(),
    windowHash: '9'.repeat(64),
  };
}
function receipt(request: DocumentPassageCommit): DocumentPassageReceipt {
  const edited = request.edits[0]!;
  const text = 'Seed'.slice(0, edited.from) + edited.replacement + 'Seed'.slice(edited.to);
  const window = passage('after', text);
  const reference = {
    sceneId: 4,
    chapterId: 3,
    sceneNumber: 1,
    revisionId: window.sceneRevisionId,
    contentHash: window.contentHash,
    wordCount: 1,
  };
  return {
    kind: 'catalog',
    operationId: request.operationId,
    revisionId: 'after',
    contentHash: 'a'.repeat(64),
    status: 'completed',
    manifest: { schemaVersion: 1, scenes: [reference] },
    sceneReferences: [reference],
    result: window,
  };
}
async function flush() {
  await act(async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(getScenePassage).mockResolvedValue(passage());
  vi.mocked(readDocumentPassageDraft).mockResolvedValue(undefined);
  vi.mocked(writeDocumentPassageDraft).mockResolvedValue();
  vi.mocked(deleteDocumentPassageDraft).mockResolvedValue();
  vi.mocked(saveScenePassage).mockImplementation(async (_book, _scene, request) =>
    receipt(request),
  );
});
afterEach(() => vi.useRealTimers());
describe('inactive bounded passage hook checkpoint', () => {
  it('does not load a disabled or unauthenticated surface', async () => {
    renderHook(() => usePassageSession(identity, { enabled: false }));
    renderHook(() => usePassageSession(undefined, { enabled: true }));
    await flush();
    expect(getScenePassage).not.toHaveBeenCalled();
  });
  it('survives React development StrictMode teardown and retains bounded defaults', async () => {
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => usePassageSession(identity, { enabled: true }), {
      wrapper,
    });
    await flush();
    expect(result.current.state).toBe('saved');
    expect(getScenePassage).toHaveBeenLastCalledWith('1', '4', {
      maxCharacters: 2400,
      maxParagraphs: 12,
    });
  });
  it('debounces autosave for750ms and enforces the5s maximum while typing continues', async () => {
    const { result } = renderHook(() =>
      usePassageSession(identity, { enabled: true, tracking: true }),
    );
    await flush();
    act(() =>
      result.current.controller!.edit({ blockId: 'paragraph', runId: 'run', text: 'Seed once' }),
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(749);
    });
    expect(saveScenePassage).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(saveScenePassage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveScenePassage).mock.calls[0]![2].tracking).toBe(true);
    // Keep a separate source/session for continuous-input maximum-delay evidence.
    vi.mocked(saveScenePassage).mockClear();
    const continuous = renderHook(() =>
      usePassageSession({ ...identity, userId: 'continuous-user' }, { enabled: true }),
    );
    await flush();
    for (let step = 0; step < 10; step++) {
      act(() =>
        continuous.result.current.controller!.edit({
          blockId: 'paragraph',
          runId: 'run',
          text: 'Seed ' + step,
        }),
      );
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }
    expect(saveScenePassage).toHaveBeenCalledTimes(1);
  });
});
