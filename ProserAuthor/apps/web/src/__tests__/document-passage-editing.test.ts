import { describe, expect, it, vi } from 'vitest';
import { defaultLayout, type DocumentPassage } from '@cheftaco/proser-contracts';
import { passageCommit, passageRunEdits } from '@/lib/document-passage-editing';
import { executePassageOperation } from '@/lib/document-passage-operation';
import type { DocumentPassageDraft } from '@/lib/document-passage-journal';
const passage = (): DocumentPassage => ({
  schemaVersion: 1,
  bookRevisionId: 'book-revision',
  sceneId: 2,
  sceneRevisionId: 'scene-revision',
  contentHash: 'c'.repeat(64),
  projection: 'final',
  cursor: { paragraph: 17, offset: 50000 },
  paragraphs: [
    {
      paragraph: {
        type: 'paragraph',
        id: 'right-cell-paragraph',
        style: { indent: 12 },
        runs: [{ id: 'same-quote-run', text: 'A😀éZ', style: { italic: true } }],
      },
      ordinal: 17,
      offset: 50000,
      length: 1200000,
      continuedBefore: true,
      continuedAfter: true,
      runs: [
        {
          runId: 'same-quote-run',
          sourceHash: 'a'.repeat(64),
          from: 50000,
          to: 50006,
          sourceLength: 1200000,
        },
      ],
      container: { tableId: 'table', rowId: 'row', cellId: 'right-cell', widths: [800, 400] },
    },
  ],
  images: [],
  changes: [],
  omitted: { paragraphs: 10, comments: 1, changes: 0, objects: 2 },
  layout: defaultLayout(),
  windowHash: 'b'.repeat(64),
});
const draft = (): DocumentPassageDraft => {
  const window = passage();
  return {
    schemaVersion: 1,
    userId: 'owned-user',
    bookId: '1',
    sceneId: '2',
    version: 'v1',
    updatedAt: Date.now(),
    passage: window,
    drafts: [{ blockId: 'right-cell-paragraph', runId: 'same-quote-run', text: 'A😀éXYZ' }],
    pending: {
      kind: 'commit',
      request: passageCommit(
        window,
        [{ blockId: 'right-cell-paragraph', runId: 'same-quote-run', text: 'A😀éXYZ' }],
        'original-operation',
        true,
      ),
    },
  };
};
describe('bounded passage editing and operation recovery', () => {
  it('uses immutable run hashes and raw UTF16 offsets without whole source bodies', () => {
    const window = passage();
    const before = structuredClone(window);
    const request = draft().pending!.request;
    expect(request).toMatchObject({
      expectedRevisionId: window.bookRevisionId,
      expectedSceneRevisionId: window.sceneRevisionId,
      windowHash: window.windowHash,
      cursor: window.cursor,
      edits: [
        {
          blockId: 'right-cell-paragraph',
          runId: 'same-quote-run',
          sourceHash: 'a'.repeat(64),
          from: 50005,
          to: 50005,
          expectedText: '',
          replacement: 'XY',
        },
      ],
    });
    expect(JSON.stringify(request).length).toBeLessThan(1024);
    expect(window).toEqual(before);
  });
  it('never guesses repeated quotations or edits foreign/protected targets', () => {
    expect(() =>
      passageRunEdits(passage(), [{ blockId: 'other-cell', runId: 'same-quote-run', text: 'new' }]),
    ).toThrow('outside');
    const window = passage();
    window.paragraphs[0]!.paragraph.runs[0]!.inlineImage = {
      assetId: 3,
      sha256: 'a'.repeat(64),
      width: 30,
      height: 20,
      alt: 'Kept',
    };
    expect(() => passageRunEdits(window, draft().drafts)).toThrow('protected');
    expect(() => passageRunEdits(passage(), [...draft().drafts, ...draft().drafts])).toThrow(
      'duplicate',
    );
    expect(() => passageRunEdits(passage(), [{ ...draft().drafts[0]!, text: 'A\ud800Z' }])).toThrow(
      'Unicode',
    );
  });
  it('expands edits to complete graphemes without normalizing stored text', () => {
    expect(passageRunEdits(passage(), [{ ...draft().drafts[0]!, text: 'A😀eZ' }])).toEqual([
      {
        blockId: 'right-cell-paragraph',
        runId: 'same-quote-run',
        sourceHash: 'a'.repeat(64),
        from: 50003,
        to: 50005,
        expectedText: 'é',
        replacement: 'e',
      },
    ]);
  });
  it('persists before dispatch and recovers the same operation after a lost acknowledgement', async () => {
    const events: string[] = [];
    const receipt = { operationId: 'original-operation', status: 'completed' as const };
    const dependencies = {
      isCurrent: () => true,
      persist: vi.fn(async () => {
        events.push('persist');
      }),
      recover: vi.fn(async () => receipt),
      dispatch: vi.fn(async () => {
        events.push('dispatch');
        throw new Error('Lost reply');
      }),
      acknowledge: vi.fn(async () => {
        events.push('ack');
      }),
    };
    expect((await executePassageOperation(draft(), dependencies)).state).toBe('recoverable');
    expect(events).toEqual(['persist', 'dispatch']);
    expect(
      (await executePassageOperation(draft(), dependencies, { recoverFirst: true })).state,
    ).toBe('acknowledged');
    expect(dependencies.dispatch).toHaveBeenCalledTimes(1);
    expect(dependencies.recover).toHaveBeenCalledWith('original-operation');
    expect(dependencies.acknowledge).toHaveBeenCalledWith(
      receipt,
      expect.objectContaining({ version: 'v1' }),
    );
  });
  it('does not retry an absent receipt without an explicit retry action', async () => {
    const dependencies = {
      isCurrent: () => true,
      persist: vi.fn(async () => {}),
      recover: vi.fn(async () => undefined),
      dispatch: vi.fn(async (_intent: NonNullable<DocumentPassageDraft['pending']>) => ({
        operationId: 'original-operation',
        status: 'completed' as const,
      })),
      acknowledge: vi.fn(async () => {}),
    };
    expect(
      (await executePassageOperation(draft(), dependencies, { recoverFirst: true })).state,
    ).toBe('recoverable');
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(
      (
        await executePassageOperation(draft(), dependencies, {
          recoverFirst: true,
          retryAbsent: true,
        })
      ).state,
    ).toBe('acknowledged');
    expect(dependencies.dispatch.mock.calls[0]?.[0]).toEqual(draft().pending);
  });
  it('suppresses account changes and retains unknown operations after acknowledgement persistence fails', async () => {
    let current = true;
    const dependencies = {
      isCurrent: () => current,
      persist: vi.fn(async () => {}),
      recover: vi.fn(async () => undefined),
      dispatch: vi.fn(async () => {
        current = false;
        return { operationId: 'original-operation', status: 'completed' as const };
      }),
      acknowledge: vi.fn(async () => {}),
    };
    expect((await executePassageOperation(draft(), dependencies)).state).toBe('inactive');
    expect(dependencies.acknowledge).not.toHaveBeenCalled();
    current = true;
    dependencies.dispatch.mockImplementation(async () => ({
      operationId: 'original-operation',
      status: 'completed' as const,
    }));
    dependencies.acknowledge.mockImplementation(async () => {
      throw new Error('Storage unavailable');
    });
    expect((await executePassageOperation(draft(), dependencies)).state).toBe('recoverable');
  });
});
