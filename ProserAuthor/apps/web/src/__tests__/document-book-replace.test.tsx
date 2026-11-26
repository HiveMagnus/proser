import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentBookReplace } from '@/components/editor/document-book-replace';
import {
  applyDocumentReplace,
  previewDocumentReplace,
  undoDocumentReplace,
  DocumentRequestError,
} from '@/lib/document-api';
import type {
  DocumentReplaceApplyReceipt,
  DocumentReplacePreviewResponse,
} from '@hivemagnus/proser-contracts';
vi.mock('@/lib/document-api', async (original) => ({
  ...(await original<typeof import('@/lib/document-api')>()),
  previewDocumentReplace: vi.fn(),
  applyDocumentReplace: vi.fn(),
  undoDocumentReplace: vi.fn(),
}));
const revision = '11111111-1111-4111-8111-111111111111';
const sceneRevision = '22222222-2222-4222-8222-222222222222';
const preview = (): DocumentReplacePreviewResponse => ({
  schemaVersion: 1,
  sourceBookRevisionId: revision,
  query: 'raven',
  replacement: 'crow',
  caseSensitive: false,
  sceneCount: 1,
  truncated: false,
  matches: [
    {
      id: `${sceneRevision}:4:9`,
      sceneId: 7,
      sceneNumber: 1,
      chapterId: 3,
      sceneRevisionId: sceneRevision,
      from: 4,
      to: 9,
      sourceText: 'Raven',
      excerpt: 'The Raven flew.',
      excerptFrom: 0,
      excerptTo: 15,
      replaceable: true,
    },
    {
      id: `${sceneRevision}:20:25`,
      sceneId: 7,
      sceneNumber: 1,
      chapterId: 3,
      sceneRevisionId: sceneRevision,
      from: 20,
      to: 25,
      sourceText: 'raven',
      excerpt: 'The raven sang.',
      excerptFrom: 16,
      excerptTo: 31,
      replaceable: true,
    },
    {
      id: `${sceneRevision}:40:45`,
      sceneId: 7,
      sceneNumber: 1,
      chapterId: 3,
      sceneRevisionId: sceneRevision,
      from: 40,
      to: 45,
      sourceText: 'raven',
      excerpt: 'Bold raven end',
      excerptFrom: 35,
      excerptTo: 49,
      replaceable: false,
      reason: 'formatting',
    },
  ],
});
const receipt: DocumentReplaceApplyReceipt = {
  kind: 'replace',
  operationId: '33333333-3333-4333-8333-333333333333',
  revisionId: '44444444-4444-4444-8444-444444444444',
  previousRevisionId: revision,
  contentHash: 'a'.repeat(64),
  replacedCount: 1,
  scenes: [{ sceneId: 7, revisionId: sceneRevision, contentHash: 'b'.repeat(64), wordCount: 9 }],
  status: 'completed',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(previewDocumentReplace).mockResolvedValue(preview());
  vi.mocked(applyDocumentReplace).mockResolvedValue(receipt);
  vi.mocked(undoDocumentReplace).mockResolvedValue({ revisionId: revision });
});
const fill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('Find in whole book'), 'raven');
  await user.type(screen.getByLabelText('Replace with'), 'crow');
  await user.click(screen.getByRole('button', { name: 'Preview replacements' }));
  await screen.findByText('3 matches in 1 scene. 2 selected.');
};
describe('book-wide find and replace', () => {
  it('previews matches, skips unticked and unsupported ones, and applies one revision', async () => {
    const user = userEvent.setup();
    const committed = vi.fn();
    render(<DocumentBookReplace bookId="5" onCommitted={committed} />);
    await fill(user);
    const boxes = screen.getAllByRole('checkbox', { name: /Scene 1/ });
    expect(boxes[2]).toBeDisabled();
    expect(screen.getByText('Skipped: this match crosses formatting.')).toBeInTheDocument();
    await user.click(boxes[1]!);
    await user.click(screen.getByRole('button', { name: 'Replace 1 selected' }));
    await waitFor(() => expect(applyDocumentReplace).toHaveBeenCalledTimes(1));
    const [bookId, body] = vi.mocked(applyDocumentReplace).mock.calls[0]!;
    expect(bookId).toBe('5');
    expect(body).toMatchObject({
      schemaVersion: 1,
      expectedRevisionId: revision,
      q: 'raven',
      replacement: 'crow',
      caseSensitive: false,
      matches: [{ sceneId: 7, sceneRevisionId: sceneRevision, from: 4, to: 9 }],
    });
    expect(committed).toHaveBeenCalledTimes(1);
    await screen.findByText('Replaced 1 match in 1 scene as one saved revision.');
    await user.click(screen.getByRole('button', { name: 'Undo replace' }));
    await waitFor(() => expect(undoDocumentReplace).toHaveBeenCalledTimes(1));
    expect(vi.mocked(undoDocumentReplace).mock.calls[0]![1]).toMatchObject({
      revisionId: receipt.revisionId,
      previousRevisionId: revision,
    });
    await screen.findByText('Replace undone. The manuscript is back to the revision before it.');
    expect(committed).toHaveBeenCalledTimes(2);
  });
  it('retries a failed apply with the same operation ID and blocks unsaved edits', async () => {
    vi.mocked(applyDocumentReplace).mockRejectedValueOnce(
      new DocumentRequestError('Factory did not acknowledge the replace.', 504),
    );
    const user = userEvent.setup();
    const { rerender } = render(<DocumentBookReplace bookId="5" onCommitted={vi.fn()} />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Replace 2 selected' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Factory did not acknowledge the replace.',
    );
    await user.click(screen.getByRole('button', { name: 'Replace 2 selected' }));
    await waitFor(() => expect(applyDocumentReplace).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(applyDocumentReplace).mock.calls;
    expect(calls[1]![1].operationId).toBe(calls[0]![1].operationId);
    rerender(<DocumentBookReplace bookId="5" disabled onCommitted={vi.fn()} />);
    expect(
      screen.getByText('Save your changes before replacing across the book.'),
    ).toBeInTheDocument();
  });
});
