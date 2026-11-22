import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  ChapterTransitions as Batch,
  DocumentProposalRecord,
} from '@cheftaco/proser-contracts';
import { ChapterTransitions } from '@/components/editor/chapter-transitions';
import * as api from '@/lib/document-api';
import * as journal from '@/lib/chapter-transition-journal';
let identity = 'owner-one';
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: identity } } }) }));
vi.mock('@/lib/document-api', () => ({
  requestDocumentResource: vi.fn(),
  prepareDocumentDiscussion: vi.fn(),
  getDocumentDiscussion: vi.fn(),
  requestDocumentProposal: vi.fn(),
  getDocumentProposal: vi.fn(),
  listDocumentDiscussions: vi.fn(),
  listDocumentProposals: vi.fn(),
  DocumentRequestError: class extends Error {},
}));
vi.mock('@/lib/chapter-transition-journal', () => ({
  readTransitionIntent: vi.fn(),
  writeTransitionIntent: vi.fn(),
  clearTransitionIntent: vi.fn(),
}));
const batch: Batch = {
  bookId: 1,
  bookTitle: 'One manuscript',
  bookRevisionId: 'book-source',
  chapterCount: 4,
  transitions: [1, 2, 3].map((n) => ({
    bookRevisionId: 'book-source',
    ending: { chapterId: n, label: `Chapter ${n}`, text: `Actual ending ${n}.`, truncated: false },
    opening: {
      chapterId: n + 1,
      label: `Chapter ${n + 1}`,
      sceneId: n + 10,
      sceneRevisionId: 'scene-source',
      contentHash: 'source-hash',
      text: `Actual opening ${n}.`,
      truncated: false,
      target: { blockId: `block-${n}`, from: 0, to: 17, sourceText: `Actual opening ${n}.` },
    },
  })),
};
function proposal(id: string, discussionId: string, sceneId: number): DocumentProposalRecord {
  return {
    id,
    discussionId,
    bookId: 1,
    sceneId,
    status: 'ready',
    request: { operationId: id, instruction: 'Review.' },
    providerOutcome: 'completed',
    application: null,
    result: {
      output: {
        reply:
          'Continuity: Same threat. Momentum: Carries urgency. Reason to keep reading: Will she act?',
        edits: [
          {
            targetId: 'target',
            sourceText: 'Actual opening 1.',
            replacement: 'Actual urgent opening 1.',
          },
        ],
      },
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  identity = 'owner-one';
  vi.mocked(api.requestDocumentResource).mockResolvedValue(batch);
  vi.mocked(journal.readTransitionIntent).mockResolvedValue(undefined);
  vi.mocked(api.listDocumentDiscussions).mockResolvedValue([]);
  vi.mocked(api.listDocumentProposals).mockResolvedValue([]);
  vi.mocked(journal.writeTransitionIntent).mockResolvedValue();
  vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue({ id: 'context' } as never);
  vi.mocked(api.requestDocumentProposal).mockImplementation(async (_book, discussion, request) =>
    proposal(request.operationId, discussion, 11),
  );
});
it('shows three literal boundaries and journals before provider dispatch; before/after stays a suggestion', async () => {
  const user = userEvent.setup();
  render(<ChapterTransitions bookId="1" />);
  const card = await screen.findByRole('article', { name: 'Transition 1' });
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(within(card).getByText('Actual ending 1.')).toBeInTheDocument();
  expect(within(card).getByText('Actual opening 1.')).toBeInTheDocument();
  await waitFor(() =>
    expect(
      within(card).getByRole('button', { name: 'Review and offer a small revision' }),
    ).toBeEnabled(),
  );
  await user.click(within(card).getByRole('button', { name: 'Review and offer a small revision' }));
  await within(card).findByText('Actual urgent opening 1.');
  expect(within(card).getByRole('heading', { name: 'Before' })).toBeInTheDocument();
  expect(journal.writeTransitionIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: identity,
      bookId: '1',
      chapterId: 1,
      discussion: expect.objectContaining({
        transitionChapterId: 1,
        expectedRevisionId: 'book-source',
        targets: [batch.transitions[0]!.opening.target],
      }),
    }),
  );
  expect(vi.mocked(journal.writeTransitionIntent).mock.invocationCallOrder[0]!).toBeLessThan(
    vi.mocked(api.requestDocumentProposal).mock.invocationCallOrder[0]!,
  );
  expect(within(card).queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
});
it('lost acknowledgement recovers exact original IDs with GET and never repeats inference', async () => {
  const user = userEvent.setup();
  vi.mocked(api.requestDocumentProposal).mockRejectedValue(new Error('Lost acknowledgement'));
  vi.mocked(api.getDocumentProposal).mockImplementation(async (_book, id) => {
    const retained = vi.mocked(journal.writeTransitionIntent).mock.calls[0]![0];
    return proposal(id, retained.discussion.operationId, retained.discussion.sceneId);
  });
  render(<ChapterTransitions bookId="1" />);
  const card = await screen.findByRole('article', { name: 'Transition 1' });
  await waitFor(() =>
    expect(
      within(card).getByRole('button', { name: 'Review and offer a small revision' }),
    ).toBeEnabled(),
  );
  await user.click(within(card).getByRole('button', { name: 'Review and offer a small revision' }));
  await within(card).findByRole('alert');
  await user.click(within(card).getByRole('button', { name: 'Recover saved review' }));
  await within(card).findByText('Actual urgent opening 1.');
  expect(api.requestDocumentProposal).toHaveBeenCalledTimes(1);
  const retained = vi.mocked(journal.writeTransitionIntent).mock.calls[0]![0];
  expect(api.getDocumentDiscussion).toHaveBeenCalledWith('1', retained.discussion.operationId);
  expect(api.getDocumentProposal).toHaveBeenCalledWith('1', retained.request.operationId);
});
it('storage failure prevents dispatch; account changes remount scoped review state', async () => {
  const user = userEvent.setup();
  vi.mocked(journal.writeTransitionIntent).mockRejectedValue(new Error('Storage unavailable'));
  const view = render(<ChapterTransitions bookId="1" />);
  let card = await screen.findByRole('article', { name: 'Transition 1' });
  await waitFor(() =>
    expect(
      within(card).getByRole('button', { name: 'Review and offer a small revision' }),
    ).toBeEnabled(),
  );
  await user.click(within(card).getByRole('button', { name: 'Review and offer a small revision' }));
  await within(card).findByText('Storage unavailable');
  expect(api.prepareDocumentDiscussion).not.toHaveBeenCalled();
  expect(api.requestDocumentProposal).not.toHaveBeenCalled();
  identity = 'owner-two';
  view.rerender(<ChapterTransitions bookId="1" />);
  card = await screen.findByRole('article', { name: 'Transition 1' });
  await waitFor(() =>
    expect(journal.readTransitionIntent).toHaveBeenCalledWith('owner-two', '1', 1),
  );
  expect(within(card).queryByText('Storage unavailable')).not.toBeInTheDocument();
});

it('loads a Factory-retained transition review on another browser without provider dispatch', async () => {
  vi.mocked(api.listDocumentDiscussions).mockResolvedValue([
    {
      id: 'saved-context',
      snapshot: { transition: batch.transitions[0], sourceBookRevisionId: 'older-book-source' },
    },
  ] as never);
  vi.mocked(api.listDocumentProposals).mockResolvedValue([
    { id: 'saved-proposal', status: 'ready', createdAt: '2026-10-09' },
  ]);
  vi.mocked(api.getDocumentProposal).mockImplementation(async () =>
    proposal('saved-proposal', 'saved-context', 11),
  );
  render(<ChapterTransitions bookId="1" />);
  const card = await screen.findByRole('article', { name: 'Transition 1' });
  await within(card).findByText('Actual urgent opening 1.');
  expect(within(card).getByText(/earlier manuscript revision/)).toBeInTheDocument();
  expect(api.requestDocumentProposal).not.toHaveBeenCalled();
  expect(api.prepareDocumentDiscussion).not.toHaveBeenCalled();
});
