import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlotThreadWorkflow } from '@/components/plot/plot-thread-workflow';
import type {
  PlotThreadRecord,
  PlotThreadSummary,
  PlotThreadReviewRecord,
} from '@hivemagnus/proser-contracts';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  dispatch: vi.fn(),
  replace: vi.fn(),
  query: new URLSearchParams(),
  userId: 'owner',
  recover: vi.fn(),
  retry: vi.fn(),
  pending: undefined as import('@/lib/plot-thread-journal').PlotThreadIntent | undefined,
  revision: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: mocks.userId } } }),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.query }));
vi.mock('@/hooks/use-protected-router', () => ({
  useProtectedRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ activeBookId: '7', setActiveBookId: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-books', () => ({
  useBooks: () => ({
    data: [
      { id: '7', title: 'Apprentice' },
      { id: '8', title: 'Other book' },
    ],
  }),
}));
vi.mock('@/lib/plot-thread-api', () => ({
  listThreads: mocks.list,
  readThread: mocks.read,
  plotThreadBase: (bookId: string) => `/api/books/${bookId}/plot-threads`,
}));
vi.mock('@/hooks/use-plot-thread-actions', () => ({
  usePlotThreadActions: () => ({
    ready: true,
    busy: false,
    blocked: false,
    dispatch: mocks.dispatch,
    recover: mocks.recover,
    retry: mocks.retry,
    pending: mocks.pending,
    setError: vi.fn(),
  }),
}));
vi.mock('@/components/plot/plot-thread-revision', () => ({
  PlotThreadRevision: (props: unknown) => {
    mocks.revision(props);
    return null;
  },
}));
const question = 'Will the apprentice discover who betrayed her?';
const summary: PlotThreadSummary = {
  id: 4,
  bookId: 7,
  threadKey: 'author-stable',
  question,
  description: null,
  notes: null,
  status: 'open',
  version: 1,
  authorManaged: true,
  archivedAt: null,
  checks: ['No setup linked.', 'No escalation linked.', 'No payoff linked.'],
  coverage: { setup: 0, escalation: 0, payoff: 0 },
};
const detail: PlotThreadRecord = { ...summary, evidence: [], reviews: [] };
const review: PlotThreadReviewRecord = {
  id: 'review',
  status: 'ready',
  snapshot: {
    schemaVersion: 1,
    bookRevisionId: 'saved',
    threadId: 4,
    threadVersion: 1,
    question,
    description: null,
    notes: null,
    evidence: [],
    checks: [],
  },
  result: {
    output: {
      assessment: 'weak',
      summary: 'Needs a stronger connection.',
      findings: [
        {
          aspect: 'causality',
          explanation: 'Connect the clue.',
          suggestion: 'Show a consequence.',
          citations: [{ evidenceId: 'evidence', quote: 'A clue.' }],
        },
      ],
    },
  },
  errorCode: null,
  assessment: null,
  notes: null,
  createdAt: '2026-10-13T00:00:00Z',
  stale: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = new URLSearchParams();
  mocks.userId = 'owner';
  mocks.pending = undefined;
  mocks.list.mockResolvedValue({ threads: [summary], next: null });
  mocks.read.mockResolvedValue(detail);
  mocks.dispatch.mockResolvedValue({ threadId: 4 });
});
describe('Plot Threads author workflow', () => {
  it('creates a required story question through a recoverable version-zero mutation', async () => {
    const user = userEvent.setup();
    render(<PlotThreadWorkflow />);
    await user.click(await screen.findByRole('button', { name: 'New Thread' }));
    expect(screen.getByRole('button', { name: 'Create thread' })).toBeDisabled();
    await user.type(screen.getByLabelText('Story question'), question);
    await user.click(screen.getByRole('button', { name: 'Create thread' }));
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mutation',
        path: '/api/books/7/plot-threads',
        body: expect.objectContaining({
          expectedVersion: 0,
          question,
          operationId: expect.any(String),
        }),
      }),
    );
    expect(await screen.findByRole('article', { name: 'Plot thread detail' })).toBeInTheDocument();
  });
  it('shows missing linked stages and keeps thread status independent of review controls', async () => {
    const user = userEvent.setup();
    render(<PlotThreadWorkflow />);
    await user.click(await screen.findByRole('button', { name: question }));
    expect(await screen.findByText('No setup linked.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review payoff' })).toBeDisabled();
    await user.type(screen.getByLabelText('Thread notes'), 'Keep this author note.');
    await user.selectOptions(screen.getByLabelText('Thread status'), 'escalated');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save thread changes' }));
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({
          expectedVersion: 1,
          status: 'escalated',
          notes: 'Keep this author note.',
        }),
      }),
    );
  });
  it('exposes backend failures rather than disguising them as an empty registry', async () => {
    mocks.list.mockRejectedValue(new Error('Factory plot thread route unavailable'));
    render(<PlotThreadWorkflow />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Factory plot thread route unavailable',
    );
    expect(
      screen.queryByText('No plot threads. Create a story question to begin.'),
    ).not.toBeInTheDocument();
  });
  it('keeps stable field names when saved textareas already contain notes', async () => {
    mocks.read.mockResolvedValue({
      ...detail,
      description: 'Saved description',
      notes: 'Saved thread note',
      reviews: [{ ...review, notes: 'Saved author assessment note' }],
    });
    const user = userEvent.setup();
    render(<PlotThreadWorkflow />);
    await user.click(await screen.findByRole('button', { name: question }));
    expect(await screen.findByRole('textbox', { name: 'Thread notes' })).toHaveValue(
      'Saved thread note',
    );
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Saved description');
    expect(screen.getByRole('textbox', { name: 'Review notes' })).toHaveValue(
      'Saved author assessment note',
    );
  });
  it('recovers a lost create acknowledgment into the original detail instead of a duplicate form', async () => {
    const user = userEvent.setup(),
      view = render(<PlotThreadWorkflow />);
    await user.click(await screen.findByRole('button', { name: 'New Thread' }));
    await user.type(screen.getByLabelText('Story question'), question);
    const intent = {
      userId: 'owner',
      bookId: '7',
      operationId: 'original',
      kind: 'mutation' as const,
      method: 'POST' as const,
      path: '/api/books/7/plot-threads',
      recoveryPath: '/receipt',
      body: { operationId: 'original', expectedVersion: 0, question },
    };
    mocks.pending = intent;
    mocks.recover.mockResolvedValue({
      intent,
      result: { threadId: 4, version: 1, operationId: 'original' },
    });
    view.rerender(<PlotThreadWorkflow />);
    await user.click(screen.getByRole('button', { name: 'Recover original request' }));
    expect(await screen.findByRole('article', { name: 'Plot thread detail' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create plot thread' })).not.toBeInTheDocument();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('protects metadata and author-assessment drafts against internal back and refresh', async () => {
    mocks.read.mockResolvedValue({ ...detail, reviews: [review] });
    const user = userEvent.setup();
    render(<PlotThreadWorkflow />);
    await user.click(await screen.findByRole('button', { name: question }));
    await screen.findByLabelText('Review notes');
    await user.type(screen.getByLabelText('Thread notes'), 'Unsaved metadata');
    expect(screen.getByRole('button', { name: 'Back to threads' })).toBeDisabled();
    expect(screen.getByLabelText('Review notes')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Discard unsaved thread changes' }));
    await user.type(screen.getByLabelText('Review notes'), 'Preserve this assessment draft.');
    expect(screen.getByRole('button', { name: 'Refresh threads' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to threads' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save thread changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save my assessment' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Discard unsaved assessment' }));
    expect(screen.getByRole('button', { name: 'Back to threads' })).toBeEnabled();
  });
  it('passes the newly stale saved review to an already-open revision panel after refresh', async () => {
    mocks.read.mockResolvedValue({ ...detail, reviews: [review] });
    const user = userEvent.setup();
    render(<PlotThreadWorkflow />);
    await user.click(await screen.findByRole('button', { name: question }));
    await user.click(await screen.findByRole('button', { name: 'Offer a small revision' }));
    expect(mocks.revision).toHaveBeenLastCalledWith(
      expect.objectContaining({ review: expect.objectContaining({ stale: false }) }),
    );
    mocks.read.mockResolvedValue({ ...detail, reviews: [{ ...review, stale: true }] });
    await user.click(screen.getByRole('button', { name: 'Refresh threads' }));
    await waitFor(() =>
      expect(mocks.revision).toHaveBeenLastCalledWith(
        expect.objectContaining({ review: expect.objectContaining({ stale: true }) }),
      ),
    );
  });
  it('remounts author scope and preserves book choice in mobile navigation', async () => {
    const user = userEvent.setup();
    const view = render(<PlotThreadWorkflow mobile />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('7', 'owner', false));
    mocks.userId = 'other-owner';
    view.rerender(<PlotThreadWorkflow mobile />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('7', 'other-owner', false));
    await user.selectOptions(screen.getByLabelText('Plot threads manuscript'), '8');
    expect(mocks.replace).toHaveBeenCalledWith('/m/plot?bookId=8&tab=threads');
  });
});
