import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlotThreadRevision } from '@/components/plot/plot-thread-revision';
import type {
  PlotThreadEvidenceRecord,
  PlotThreadRecord,
  PlotThreadReviewRecord,
} from '@cheftaco/proser-contracts';
import type { usePlotThreadActions } from '@/hooks/use-plot-thread-actions';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  dispatch: vi.fn(),
  status: 'failed',
  outcome: 'completed',
}));
vi.mock('@/lib/plot-thread-api', () => ({ plotRequest: mocks.request }));
const evidence: PlotThreadEvidenceRecord = {
  id: 'evidence',
  stage: 'payoff',
  createdAt: '2026-10-13T00:00:00Z',
  removedAt: null,
  stale: false,
  source: {
    label: 'Saved payoff',
    text: 'Literal saved passage.',
    targets: [],
    anchors: [],
    position: [1],
    frame: {
      bookId: 7,
      actId: 1,
      chapterId: 1,
      sceneId: 9,
      bookRevisionId: 'book',
      bookContentHash: 'hash',
      sceneRevisionId: 'scene',
      sceneContentHash: 'hash',
      qualifiedMembershipHash: 'hash',
      effectiveStyleLayoutHash: 'hash',
      projection: 'final',
      structureScope: { revisionId: 'structure', contentHash: 'hash' },
      layoutScope: { revisionId: 'layout', contentHash: 'hash' },
    },
  },
};
const review: PlotThreadReviewRecord = {
  id: 'review',
  status: 'ready',
  stale: false,
  result: null,
  errorCode: null,
  assessment: null,
  notes: null,
  createdAt: '2026-10-13T00:00:00Z',
  snapshot: {
    schemaVersion: 1,
    bookRevisionId: 'book',
    threadId: 4,
    threadVersion: 1,
    question: 'Who betrayed her?',
    description: null,
    notes: null,
    evidence: [evidence],
    checks: [],
  },
};
const thread: PlotThreadRecord = {
  id: 4,
  bookId: 7,
  threadKey: 'author',
  question: 'Who betrayed her?',
  description: null,
  notes: null,
  status: 'open',
  version: 1,
  authorManaged: true,
  archivedAt: null,
  evidence: [evidence],
  checks: [],
  reviews: [review],
};
const actions = {
  blocked: false,
  dispatch: mocks.dispatch,
  setError: vi.fn(),
} as unknown as ReturnType<typeof usePlotThreadActions>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 'failed';
  mocks.outcome = 'completed';
  mocks.request.mockImplementation(async (path: string) =>
    path.endsWith('/proposals')
      ? [
          {
            id: 'failed-proposal',
            status: mocks.status,
            providerOutcome: mocks.outcome,
            result: null,
            errorCode: 'PLOT_THREAD_PROPOSAL_NO_CHANGE',
          },
        ]
      : [
          {
            id: 'discussion',
            snapshot: { plotThread: { reviewId: 'review', evidenceId: 'evidence' } },
          },
        ],
  );
  mocks.dispatch.mockResolvedValue({ id: 'new-request', status: 'running', result: null });
});
const mount = () =>
  render(
    <PlotThreadRevision
      userId="owner"
      bookId="7"
      thread={thread}
      review={review}
      evidenceId="evidence"
      actions={actions}
      onChanged={() => {}}
    />,
  );
describe('Plot thread failed proposal handling', () => {
  it('offers another revision only as an explicit new request after a known completed failure', async () => {
    const user = userEvent.setup();
    mount();
    const button = await screen.findByRole('button', { name: 'Request another small revision' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Revision instruction' })).toBeEnabled();
    await user.click(button);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'proposal',
        path: '/api/books/7/document-discussions/discussion/proposals',
        body: expect.objectContaining({ operationId: expect.any(String) }),
      }),
    );
    expect(mocks.dispatch.mock.calls[0]![0].operationId).not.toBe('failed-proposal');
  });
  it('keeps unknown provider failures from offering a replacement call', async () => {
    mocks.outcome = 'unknown';
    mount();
    await screen.findByText('Saved proposal: failed');
    expect(
      screen.queryByRole('button', { name: 'Request another small revision' }),
    ).not.toBeInTheDocument();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
