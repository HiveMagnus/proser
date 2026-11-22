import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  defaultLayout,
  type DocumentPassage,
  type DocumentPassageReceipt,
  type PassageCommentAcknowledgement,
} from '@cheftaco/proser-contracts';
import { DocumentPassageComments } from '@/components/editor/document-passage-comments';
import * as api from '@/lib/document-passage-comment-api';
import * as recovery from '@/lib/document-passage-api';
import * as journal from '@/lib/document-passage-comment-journal';
vi.mock('@/lib/document-passage-comment-api', () => ({
  commitPassageComment: vi.fn(),
  getPassageComment: vi.fn(),
}));
vi.mock('@/lib/document-passage-api', async (original) => ({
  ...(await original<typeof import('@/lib/document-passage-api')>()),
  recoverScenePassage: vi.fn(),
}));
vi.mock('@/lib/document-passage-comment-journal', () => ({
  writePassageCommentIntent: vi.fn(),
  readPassageCommentIntent: vi.fn(),
  deletePassageCommentIntent: vi.fn(),
}));
const passage = (): DocumentPassage => ({
  schemaVersion: 1,
  bookRevisionId: 'book-base',
  sceneId: 4,
  sceneRevisionId: 'scene-base',
  contentHash: 'b'.repeat(64),
  projection: 'final',
  cursor: { paragraph: 9, offset: 50000 },
  reviewOffset: 8,
  sourceFrame: {
    bookId: 1,
    actId: 2,
    chapterId: 3,
    sceneId: 4,
    bookRevisionId: 'book-base',
    bookContentHash: 'a'.repeat(64),
    sceneRevisionId: 'scene-base',
    sceneContentHash: 'b'.repeat(64),
    qualifiedMembershipHash: 'c'.repeat(64),
    structureScope: { revisionId: 'structure', contentHash: 'd'.repeat(64) },
    layoutScope: { revisionId: 'layout', contentHash: 'e'.repeat(64) },
    effectiveStyleLayoutHash: 'f'.repeat(64),
    projection: 'final',
  },
  paragraphs: [
    {
      paragraphHash: 'a'.repeat(64),
      containerHash: 'b'.repeat(64),
      paragraph: {
        type: 'paragraph',
        id: 'paragraph',
        style: {},
        runs: [{ id: 'run', text: 'A😀éZ', style: { italic: true } }],
      },
      ordinal: 9,
      offset: 50000,
      length: 1200000,
      continuedBefore: true,
      continuedAfter: true,
      runs: [
        { runId: 'run', sourceHash: 'a'.repeat(64), from: 50000, to: 50006, sourceLength: 1200000 },
      ],
    },
  ],
  images: [],
  changes: [],
  omitted: { paragraphs: 200, comments: 0, changes: 0, objects: 0 },
  layout: defaultLayout(),
  windowHash: '9'.repeat(64),
});
const selection = {
  projection: 'final' as const,
  targets: [{ blockId: 'paragraph', from: 1, to: 5, sourceText: '😀é' }],
  runs: [{ blockId: 'paragraph', runId: 'run', from: 1, to: 5 }],
  container: {},
};
function receipt(operationId: string): DocumentPassageReceipt<PassageCommentAcknowledgement> {
  const after = passage();
  after.bookRevisionId = 'book-after';
  after.sceneRevisionId = 'scene-after';
  after.sourceFrame!.bookRevisionId = after.bookRevisionId;
  after.sourceFrame!.sceneRevisionId = after.sceneRevisionId;
  const reference = {
    sceneId: 4,
    chapterId: 3,
    sceneNumber: 1,
    revisionId: after.sceneRevisionId,
    contentHash: after.contentHash,
    wordCount: 1,
  };
  return {
    kind: 'catalog',
    operationId,
    revisionId: after.bookRevisionId,
    contentHash: 'f'.repeat(64),
    status: 'completed',
    manifest: { schemaVersion: 1, scenes: [reference] },
    sceneReferences: [reference],
    result: { commentId: 'new-comment', action: 'create', passage: after },
  };
}
describe('bounded comment actions and exact receipt recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(journal.readPassageCommentIntent).mockResolvedValue(undefined);
    vi.mocked(journal.writePassageCommentIntent).mockResolvedValue();
    vi.mocked(journal.deletePassageCommentIntent).mockResolvedValue();
  });
  it('flushes and freezes raw UTF16 source anchors, journals before dispatch and acknowledges only sparse owned receipts', async () => {
    const user = userEvent.setup();
    const source = passage();
    const flush = vi.fn().mockResolvedValue(source),
      onCommitted = vi.fn();
    vi.mocked(api.commitPassageComment).mockImplementation(async (_book, _scene, request) =>
      receipt(request.operationId),
    );
    render(
      <DocumentPassageComments
        userId="writer"
        bookId="1"
        passage={source}
        selection={selection}
        flush={flush}
        onCommitted={onCommitted}
      />,
    );
    await user.type(
      screen.getByRole('textbox', { name: 'New passage comment' }),
      'Keep this exact phrase.',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add comment to selected text' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Add comment to selected text' }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(api.commitPassageComment).toHaveBeenCalledWith(
      '1',
      '4',
      expect.objectContaining({
        reviewOffset: 8,
        maxCharacters: 8000,
        action: 'create',
        anchors: [
          { blockId: 'paragraph', runId: 'run', start: 50001, end: 50005, sourceText: '😀é' },
        ],
      }),
    );
    expect(vi.mocked(journal.writePassageCommentIntent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.commitPassageComment).mock.invocationCallOrder[0]!,
    );
    expect(journal.deletePassageCommentIntent).toHaveBeenCalledWith(
      'writer',
      '1',
      '4',
      expect.any(String),
    );
  });
  it('refuses changed targets after flush without relocating a repeated selection', async () => {
    const user = userEvent.setup();
    const source = passage(),
      changed = passage();
    changed.paragraphs[0]!.runs[0]!.sourceHash = 'f'.repeat(64);
    render(
      <DocumentPassageComments
        userId="writer"
        bookId="1"
        passage={source}
        selection={selection}
        flush={vi.fn().mockResolvedValue(changed)}
        onCommitted={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'New passage comment' }), 'Do not guess.');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add comment to selected text' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Add comment to selected text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('selected run changed');
    expect(journal.writePassageCommentIntent).not.toHaveBeenCalled();
    expect(api.commitPassageComment).not.toHaveBeenCalled();
  });
  it('recovers a retained lost acknowledgement before allowing another request', async () => {
    const user = userEvent.setup();
    const source = passage();
    const intent = {
      schemaVersion: 1 as const,
      userId: 'writer',
      bookId: '1',
      sceneId: '4',
      updatedAt: Date.now(),
      request: {
        schemaVersion: 1 as const,
        operationId: 'saved-operation',
        expectedRevisionId: source.bookRevisionId,
        expectedSceneRevisionId: source.sceneRevisionId,
        windowHash: source.windowHash,
        cursor: source.cursor,
        action: 'create' as const,
        text: 'Retained',
        anchors: [],
      },
    };
    vi.mocked(journal.readPassageCommentIntent).mockResolvedValue(intent);
    vi.mocked(recovery.recoverScenePassage).mockResolvedValue(receipt(intent.request.operationId));
    const onCommitted = vi.fn();
    render(
      <DocumentPassageComments
        userId="writer"
        bookId="1"
        passage={source}
        selection={selection}
        flush={vi.fn()}
        onCommitted={onCommitted}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Recover comment operation' }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(recovery.recoverScenePassage).toHaveBeenCalledWith('1', 'saved-operation');
    expect(api.commitPassageComment).not.toHaveBeenCalled();
  });
});
