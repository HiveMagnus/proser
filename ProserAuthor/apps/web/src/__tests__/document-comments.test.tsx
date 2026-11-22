import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  documentFromText,
  paragraphSelection,
  type DocumentParagraph,
} from '@cheftaco/proser-editor';
import { DocumentComments } from '@/components/editor/document-comments';
import * as api from '@/lib/document-api';
import * as journal from '@/lib/document-comment-journal';
import type {
  DocumentCommentReviewReceipt,
  SceneCommentsResponse,
} from '@cheftaco/proser-contracts';
vi.mock('@/lib/document-api', async (original) => ({
  ...(await original<typeof import('@/lib/document-api')>()),
  getDocumentComments: vi.fn(),
  revalidateDocumentComment: vi.fn(),
  resolveDocumentComment: vi.fn(),
  recoverDocumentComment: vi.fn(),
}));
vi.mock('@/lib/document-comment-journal', () => ({
  readDocumentCommentIntent: vi.fn(),
  writeDocumentCommentIntent: vi.fn(),
  deleteDocumentCommentIntent: vi.fn(),
}));
const document = documentFromText('Exact current text', () => crypto.randomUUID());
const paragraph = document.blocks[0] as DocumentParagraph;
const source = (): SceneCommentsResponse => ({
  schemaVersion: 1,
  sceneId: 2,
  bookRevisionId: 'book-base',
  sceneRevisionId: 'scene-base',
  contentHash: 'a'.repeat(64),
  comments: [
    {
      id: 'note',
      authorId: 7,
      authorName: 'Writer',
      text: 'Read this note',
      createdAt: '2026-10-05T00:00:00Z',
      resolved: false,
      anchors: [{ blockId: 'old', runId: 'old-run', start: 0, end: 4, sourceText: 'Lost' }],
      anchorStates: [
        {
          anchorIndex: 0,
          status: 'orphaned',
          reason: 'target-removed',
          sourceSceneId: 2,
          sourceSceneRevisionId: 'old-revision',
          sourceContentHash: 'b'.repeat(64),
          sourceAnchor: { blockId: 'old', runId: 'old-run', start: 0, end: 4, sourceText: 'Lost' },
        },
      ],
    },
  ],
});
const receipt = (
  operationId: string,
  action: 'resolved' | 'reanchored' = 'resolved',
): DocumentCommentReviewReceipt => ({
  kind: 'catalog',
  status: 'completed',
  operationId,
  revisionId: 'book-next',
  contentHash: 'c'.repeat(64),
  manifest: {} as DocumentCommentReviewReceipt['manifest'],
  result: { sceneId: 2, commentId: 'note', action },
});
const props = () => ({
  userId: 'writer',
  bookId: '1',
  scope: { kind: 'scene' as const, id: '2' },
  prepare: vi.fn(async () => ({ document, bookRevisionId: 'book-base', revisionId: 'scene-base' })),
  onCommitted: vi.fn(async () => undefined),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getDocumentComments).mockResolvedValue(source());
  vi.mocked(journal.readDocumentCommentIntent).mockResolvedValue(undefined);
  vi.mocked(api.resolveDocumentComment).mockImplementation(
    async (_book, _scope, _comment, request) =>
      receipt(request.operationId, request.action === 'reanchored' ? 'reanchored' : 'resolved'),
  );
});
describe('exact comment review and recovery', () => {
  it('shows original orphan evidence and journals authenticated revision preconditions before resolving', async () => {
    const p = props();
    const user = userEvent.setup();
    render(<DocumentComments {...p} />);
    await screen.findByText('Original quotation: Lost');
    expect(screen.getByText('Orphaned anchor: target removed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Resolve comment' }));
    await waitFor(() => expect(p.onCommitted).toHaveBeenCalledTimes(1));
    const intent = vi.mocked(journal.writeDocumentCommentIntent).mock.calls[0]![0];
    expect(intent.request).toMatchObject({
      expectedRevisionId: 'book-base',
      expectedSceneRevisionId: 'scene-base',
      action: 'resolved',
    });
    expect(vi.mocked(journal.writeDocumentCommentIntent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.resolveDocumentComment).mock.invocationCallOrder[0]!,
    );
    expect(journal.deleteDocumentCommentIntent).toHaveBeenCalledWith(
      'writer',
      '1',
      p.scope,
      intent.request.operationId,
    );
  });
  it('recovers a lost acknowledgement before retrying the exact operation', async () => {
    const p = props();
    const user = userEvent.setup();
    vi.mocked(api.resolveDocumentComment).mockRejectedValueOnce(
      new TypeError('Lost acknowledgement'),
    );
    vi.mocked(api.recoverDocumentComment).mockRejectedValueOnce(
      new api.DocumentRequestError('No operation', 404),
    );
    render(<DocumentComments {...p} />);
    await screen.findByText('Read this note');
    await user.click(screen.getByRole('button', { name: 'Resolve comment' }));
    await screen.findByText('Lost acknowledgement');
    expect(screen.queryByRole('button', { name: 'Retry exact comment resolution' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Recover comment receipt' }));
    await user.click(await screen.findByRole('button', { name: 'Retry exact comment resolution' }));
    await waitFor(() => expect(p.onCommitted).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.resolveDocumentComment).mock.calls[1]![3]).toEqual(
      vi.mocked(api.resolveDocumentComment).mock.calls[0]![3],
    );
  });
  it('requires exact reviewed anchors and refuses stale quotations without relocation', async () => {
    const p = props();
    const selection = paragraphSelection(document, paragraph.id, 0, 5, 'Exact current text')!;
    vi.mocked(api.revalidateDocumentComment).mockResolvedValue({
      ...source(),
      commentId: 'note',
      comment: source().comments[0]!,
      attachment: 'attached',
      proposedAnchors: [
        {
          blockId: paragraph.id,
          runId: paragraph.runs[0]!.id,
          start: 0,
          end: 5,
          sourceText: 'Exact',
        },
      ],
    });
    const user = userEvent.setup();
    const view = render(<DocumentComments {...p} selection={selection} />);
    await screen.findByText('Read this note');
    await user.click(screen.getByRole('button', { name: 'Revalidate selected anchor' }));
    await screen.findByText('Proposed quotation: Exact');
    expect(api.resolveDocumentComment).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply reviewed anchor' }));
    await waitFor(() => expect(p.onCommitted).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.resolveDocumentComment).mock.calls[0]![3]).toMatchObject({
      action: 'reanchored',
      anchors: [{ sourceText: 'Exact' }],
    });
    view.unmount();
    const stale = {
      ...selection,
      targets: selection.targets.map((target) => ({ ...target, sourceText: 'Other' })),
    };
    render(<DocumentComments {...props()} selection={stale} />);
    await screen.findByText('Read this note');
    await user.click(screen.getByRole('button', { name: 'Revalidate selected anchor' }));
    await screen.findByText('The selected quotation changed. Select it again.');
    expect(api.revalidateDocumentComment).toHaveBeenCalledTimes(1);
  });
  it('retains the exact completed operation when loading or recording its committed document fails', async () => {
    const p = props();
    const user = userEvent.setup();
    p.onCommitted.mockRejectedValueOnce(new Error('Could not retain exact committed layout'));
    render(<DocumentComments {...p} />);
    await screen.findByText('Read this note');
    await user.click(screen.getByRole('button', { name: 'Resolve comment' }));
    await screen.findByText('Could not retain exact committed layout');
    expect(journal.deleteDocumentCommentIntent).not.toHaveBeenCalled();
    const request = vi.mocked(api.resolveDocumentComment).mock.calls[0]![3];
    vi.mocked(api.recoverDocumentComment).mockResolvedValue(receipt(request.operationId));
    await user.click(screen.getByRole('button', { name: 'Recover comment receipt' }));
    await waitFor(() =>
      expect(journal.deleteDocumentCommentIntent).toHaveBeenCalledWith(
        'writer',
        '1',
        p.scope,
        request.operationId,
      ),
    );
    expect(api.resolveDocumentComment).toHaveBeenCalledTimes(1);
    expect(p.onCommitted).toHaveBeenLastCalledWith(receipt(request.operationId));
  });
});
