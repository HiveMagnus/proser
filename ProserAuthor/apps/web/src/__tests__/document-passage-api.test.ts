import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultLayout,
  type DocumentPassage,
  type DocumentPassageReceipt,
} from '@hivemagnus/proser-contracts';
import {
  acknowledgedScenePassage,
  getScenePassage,
  recoverScenePassage,
  restoreScenePassage,
  saveScenePassage,
} from '@/lib/document-passage-api';
const window = (): DocumentPassage => ({
  schemaVersion: 1,
  bookRevisionId: 'book-after',
  sceneId: 2,
  sceneRevisionId: 'scene-after',
  contentHash: 'a'.repeat(64),
  projection: 'final',
  cursor: { paragraph: 17, offset: 50000 },
  paragraphs: [],
  images: [],
  changes: [],
  omitted: { paragraphs: 20, comments: 2, changes: 0, objects: 1 },
  layout: defaultLayout(),
  windowHash: 'b'.repeat(64),
});
const receipt = (): DocumentPassageReceipt => {
  const passage = window();
  const scene = {
    sceneId: 2,
    chapterId: 3,
    sceneNumber: 1,
    revisionId: passage.sceneRevisionId,
    contentHash: passage.contentHash,
    wordCount: 300000,
  };
  return {
    kind: 'catalog',
    operationId: 'original-operation',
    revisionId: passage.bookRevisionId,
    contentHash: 'c'.repeat(64),
    status: 'completed',
    manifest: { schemaVersion: 1, scenes: [scene] },
    sceneReferences: [scene],
    result: passage,
  };
};
afterEach(() => vi.unstubAllGlobals());
describe('bounded scene passage API', () => {
  it('preserves relative proxy routes, immutable source cursor and requested bounds', async () => {
    const fetch = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true, data: window() })),
    );
    vi.stubGlobal('fetch', fetch);
    expect(
      await getScenePassage('1', '2', {
        bookRevisionId: 'book-before',
        cursor: { paragraph: 17, offset: 50000 },
        maxCharacters: 2400,
        maxParagraphs: 12,
      }),
    ).toEqual(window());
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/books/1/scenes/2/document-passages?bookRevisionId=book-before&paragraph=17&offset=50000&maxCharacters=2400&maxParagraphs=12',
    );
  });
  it('posts the exact operation or immutable restoration proof without complete scene content', async () => {
    const fetch = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true, data: receipt() })),
    );
    vi.stubGlobal('fetch', fetch);
    const request = {
      schemaVersion: 1 as const,
      operationId: 'original-operation',
      expectedRevisionId: 'book-before',
      expectedSceneRevisionId: 'scene-before',
      cursor: { paragraph: 17, offset: 50000 },
      windowHash: 'b'.repeat(64),
      edits: [
        {
          blockId: 'paragraph',
          runId: 'run',
          sourceHash: 'a'.repeat(64),
          from: 50000,
          to: 50000,
          expectedText: '',
          replacement: 'X',
        },
      ],
    };
    await saveScenePassage('1', '2', request);
    const restoration = {
      schemaVersion: 1 as const,
      operationId: 'restore-operation',
      expectedRevisionId: 'book-before',
      expectedSceneRevisionId: 'scene-before',
      cursor: request.cursor,
      windowHash: request.windowHash,
      restoreFromRevisionId: 'owned-immutable-scene',
    };
    await restoreScenePassage('1', '2', restoration);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/books/1/scenes/2/document-passages');
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(request);
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/books/1/scenes/2/document-passages/restore');
    expect(JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual(
      restoration,
    );
  });
  it('treats only explicit owned-operation absence as retryable', async () => {
    const fetch = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Absent' } }),
          { status: 404 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await recoverScenePassage('1', 'original-operation')).toBeUndefined();
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'UNAVAILABLE', message: 'Unknown provider outcome' },
          }),
          { status: 503 },
        ),
    );
    await expect(recoverScenePassage('1', 'original-operation')).rejects.toThrow(
      'Unknown provider outcome',
    );
  });
  it('checks sparse scene reference, manifest membership and operation before deleting recovery evidence', () => {
    const saved = receipt();
    expect(acknowledgedScenePassage(saved, '1', '2', 'original-operation')).toEqual(window());
    expect(() =>
      acknowledgedScenePassage(
        { ...saved, sceneReferences: undefined },
        '1',
        '2',
        'original-operation',
      ),
    ).toThrow('incompatible');
    expect(() =>
      acknowledgedScenePassage(
        { ...saved, operationId: 'different-operation' },
        '1',
        '2',
        'original-operation',
      ),
    ).toThrow('incompatible');
    expect(() =>
      acknowledgedScenePassage(
        { ...saved, manifest: { schemaVersion: 1, scenes: [] } },
        '1',
        '2',
        'original-operation',
      ),
    ).toThrow('incompatible');
    expect(() => acknowledgedScenePassage(saved, '1', '3', 'original-operation')).toThrow(
      'incompatible',
    );
    expect(() =>
      acknowledgedScenePassage(
        { ...saved, result: { restoredFromRevisionId: 'owned-old-scene', passage: saved.result } },
        '1',
        '2',
        'original-operation',
        'owned-old-scene',
      ),
    ).not.toThrow();
    expect(() =>
      acknowledgedScenePassage(
        { ...saved, result: { restoredFromRevisionId: 'other-scene', passage: saved.result } },
        '1',
        '2',
        'original-operation',
        'owned-old-scene',
      ),
    ).toThrow('incompatible');
  });
});
