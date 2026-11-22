import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WorkflowsPage from '@/app/workflows/page';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import {
  getWorkflowPublication,
  getWorkflow,
  getWorkflowCheckpointDetail,
  listBookFindings,
  listBookReviews,
  listBookRevisions,
  listBookWorkflows,
  listInferenceModels,
  listWorkflowArtifacts,
  listWorkflowCheckpoints,
  startFullBook,
  startQualityReview,
  FactoryRequestError,
} from '@/lib/api';

vi.mock('@/hooks/queries/use-books', () => ({ useBooks: vi.fn() }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: vi.fn() }));
vi.mock('@/components/motion/primitives', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/api', () => ({
  FactoryRequestError: class FactoryRequestError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  FactoryTimeoutError: class FactoryTimeoutError extends Error {
    status = 408;
  },
  controlWorkflow: vi.fn(),
  decideWorkflowCheckpoint: vi.fn(),
  getWorkflow: vi.fn(),
  getWorkflowPublication: vi.fn(),
  getWorkflowCheckpointDetail: vi.fn(),
  listBookFindings: vi.fn(),
  listBookReviews: vi.fn(),
  listBookRevisions: vi.fn(),
  listBookWorkflows: vi.fn(),
  listInferenceModels: vi.fn(),
  listWorkflowArtifacts: vi.fn(),
  listWorkflowCheckpoints: vi.fn(),
  rollbackBookRevision: vi.fn(),
  startFullBook: vi.fn(),
  startGuidedImprove: vi.fn(),
  startImproveQuality: vi.fn(),
  startQualityReview: vi.fn(),
  waiveQualityFinding: vi.fn(),
}));

describe('WorkflowsPage', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    vi.mocked(useBooks).mockReturnValue({
      data: [{ id: '4', title: 'The Dawn Debt', genre: 'fantasy' }],
      isLoading: false,
    } as ReturnType<typeof useBooks>);
    vi.mocked(useWorkspace).mockReturnValue({
      activeBookId: '4',
      activeBookTitle: 'The Dawn Debt',
      activeSceneId: null,
      activeSurface: 'workflows',
      lastVisitedAt: null,
      setActiveBook: vi.fn(),
      setActiveBookId: vi.fn(),
      setActiveBookTitle: vi.fn(),
      setActiveScene: vi.fn(),
      setActiveSceneId: vi.fn(),
      setActiveSurface: vi.fn(),
    });
    vi.mocked(listInferenceModels).mockResolvedValue([{ id: 'qwen3.6-35b' }]);
    vi.mocked(listBookReviews).mockResolvedValue([
      {
        id: 'review-1',
        workflowRunId: 'review-run-1',
        sourceRevisionId: '3f75491c-951e-4ea9-a7e4-7a1615ed42fd',
        modelUsed: 'qwen3.6-35b',
        rubricVersion: 'publishable-v1',
        scopeType: 'book',
        status: 'completed',
        score: 88,
        stale: false,
        coverage: { scene: 48, chapter: 16, act: 3, book: 1 },
        aggregates: {
          total: 2,
          open: 0,
          implemented: 1,
          verified: 1,
          waived: 1,
          stale: 0,
          superseded: 0,
        },
        createdAt: '2026-07-18T10:00:00.000Z',
      },
    ]);
    vi.mocked(listBookFindings).mockResolvedValue({ items: [], nextCursor: null, limit: 100 });
    vi.mocked(getWorkflowCheckpointDetail).mockResolvedValue({
      id: 'checkpoint-1',
      checkpointType: 'final_release',
      proposalChunk: '{}',
      offset: 0,
      nextOffset: null,
      totalCharacters: 2,
    });
    vi.mocked(listBookRevisions).mockResolvedValue([]);
    vi.mocked(listBookWorkflows).mockResolvedValue([
      {
        runId: 'full-run-1',
        workflowType: 'full_book',
        parentRunId: null,
        bookId: 4,
        status: 'release_approved',
        phase: 'release_approved',
        progress: { completed: 1, total: 1, percent: 100 },
        resultRevisionId: '3f75491c-951e-4ea9-a7e4-7a1615ed42fd',
        lastHeartbeatAt: '2026-07-18T10:00:00.000Z',
        manuscript: { scenes: 48, words: 78_246 },
        activeCheckpoint: null,
        children: [
          {
            id: 'review-run-1',
            workflowType: 'quality_review',
            status: 'completed',
            phase: 'completed',
          },
        ],
        findings: null,
      },
    ]);
    vi.mocked(listWorkflowCheckpoints).mockResolvedValue([
      {
        id: 'checkpoint-1',
        checkpointType: 'final_release',
        status: 'approved',
        decision: 'approved',
        createdAt: '2026-07-18T10:00:00.000Z',
      },
    ]);
    vi.mocked(listWorkflowArtifacts).mockResolvedValue([
      {
        id: 'artifact-1',
        artifactType: 'publication_package',
        createdAt: '2026-07-18T10:00:00.000Z',
      },
    ]);
    vi.mocked(getWorkflowPublication).mockResolvedValue({
      status: 'release_approved',
      gateReport: { pass: true, gates: [{ gate: 'complete_prose', pass: true }] },
      artifactManifest: { artifacts: [{ filename: 'the-dawn-debt.epub' }] },
      validationReport: { pass: true },
    });
  });

  it('rediscovers durable runs and renders editorial and publication evidence', async () => {
    render(<WorkflowsPage />);

    expect(await screen.findByText('Workflow history')).toBeInTheDocument();
    expect(screen.getAllByText('release approved').length).toBeGreaterThan(0);
    expect(await screen.findByText('Worker heartbeat')).toBeInTheDocument();
    expect(screen.getAllByText('Quality Review').length).toBeGreaterThan(0);
    expect(await screen.findByText('Release gates')).toBeInTheDocument();
    expect(screen.getByText('complete prose')).toBeInTheDocument();
    expect(screen.getByText('the-dawn-debt.epub')).toBeInTheDocument();
    expect(screen.getByText(/Coverage: 48 scenes/)).toBeInTheDocument();
  });

  it('selects a newly created Full Book when no book was selected', async () => {
    const setActiveBookId = vi.fn();
    vi.mocked(useWorkspace).mockReturnValue({
      activeBookId: null,
      activeBookTitle: null,
      activeSceneId: null,
      activeSurface: 'workflows',
      lastVisitedAt: null,
      setActiveBook: vi.fn(),
      setActiveBookId,
      setActiveBookTitle: vi.fn(),
      setActiveScene: vi.fn(),
      setActiveSceneId: vi.fn(),
      setActiveSurface: vi.fn(),
    });
    const launched = {
      ...(await listBookWorkflows('4'))[0]!,
      runId: 'new-run',
      bookId: 9,
      status: 'queued',
      phase: 'queued',
    };
    vi.mocked(startFullBook).mockResolvedValue(launched);
    vi.mocked(listBookWorkflows).mockImplementation(async (bookId) =>
      bookId === '9' ? [launched] : [],
    );

    render(<WorkflowsPage />);
    await screen.findAllByText('qwen3.6-35b');
    fireEvent.change(screen.getByPlaceholderText('Approved premise'), {
      target: { value: 'A city forgets every promise at midnight.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));

    await waitFor(() => expect(setActiveBookId).toHaveBeenCalledWith('9'));
    await waitFor(() =>
      expect(listBookWorkflows).toHaveBeenCalledWith('9', expect.any(AbortSignal)),
    );
  });

  it('replaces another selected book with the newly created Full Book selection', async () => {
    const workspace = vi.mocked(useWorkspace)();
    const setActiveBookId = vi.fn();
    vi.mocked(useWorkspace).mockReturnValue({ ...workspace, activeBookId: '4', setActiveBookId });
    const launched = {
      ...(await listBookWorkflows('4'))[0]!,
      runId: 'new-run-10',
      bookId: 10,
      status: 'queued',
      phase: 'queued',
    };
    vi.mocked(startFullBook).mockResolvedValue(launched);
    vi.mocked(listBookWorkflows).mockImplementation(async (bookId) =>
      bookId === '10' ? [launched] : [],
    );

    render(<WorkflowsPage />);
    fireEvent.change(screen.getByPlaceholderText('Approved premise'), {
      target: { value: 'A kingdom auctions tomorrow to pay for yesterday.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));

    await waitFor(() => expect(setActiveBookId).toHaveBeenCalledWith('10'));
    expect(startFullBook).toHaveBeenCalledTimes(1);
  });

  it('ignores a slower workflow response after the selected book changes', async () => {
    const baseWorkspace = vi.mocked(useWorkspace)();
    let selectedBookId = '4';
    vi.mocked(useWorkspace).mockImplementation(() => ({
      ...baseWorkspace,
      activeBookId: selectedBookId,
    }));
    let resolveOld!: (runs: Awaited<ReturnType<typeof listBookWorkflows>>) => void;
    const oldRuns = new Promise<Awaited<ReturnType<typeof listBookWorkflows>>>((resolve) => {
      resolveOld = resolve;
    });
    const freshRun = {
      ...(await listBookWorkflows('4'))[0]!,
      runId: 'fresh-run',
      bookId: 5,
      phase: 'fresh_book_phase',
    };
    vi.mocked(listBookWorkflows).mockImplementation(async (bookId) =>
      bookId === '4' ? oldRuns : [freshRun],
    );

    const view = render(<WorkflowsPage />);
    selectedBookId = '5';
    view.rerender(<WorkflowsPage />);
    expect(await screen.findAllByText('fresh book phase')).not.toHaveLength(0);

    await act(async () =>
      resolveOld([{ ...freshRun, runId: 'stale-run', bookId: 4, phase: 'stale_book_phase' }]),
    );
    expect(screen.queryByText('stale book phase')).not.toBeInTheDocument();
  });

  it('keeps last known review data visible and identifies a degraded request', async () => {
    vi.mocked(startQualityReview).mockResolvedValue((await listBookWorkflows('4'))[0]!);
    render(<WorkflowsPage />);
    expect((await screen.findAllByText('qwen3.6-35b')).length).toBeGreaterThan(0);
    vi.mocked(listBookReviews).mockRejectedValueOnce(new Error('review service unavailable'));

    fireEvent.click(screen.getByRole('button', { name: 'Start Quality Review' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('review rounds');
    expect(screen.getAllByText('qwen3.6-35b').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('reuses a retained idempotency key after an ambiguous launch failure', async () => {
    const launched = {
      ...(await listBookWorkflows('4'))[0]!,
      runId: 'retry-found-run',
      status: 'queued',
      phase: 'queued',
    };
    vi.mocked(startFullBook)
      .mockRejectedValueOnce(new TypeError('connection closed after submission'))
      .mockResolvedValueOnce(launched);
    render(<WorkflowsPage />);
    await screen.findAllByText('qwen3.6-35b');
    fireEvent.change(screen.getByPlaceholderText('Approved premise'), {
      target: { value: 'A city keeps every abandoned promise.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));
    await waitFor(() => expect(startFullBook).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('heading', { name: 'Pending operations' })).toBeInTheDocument();
    expect(screen.getByText('retryable')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start Full Book' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));
    await waitFor(() => expect(startFullBook).toHaveBeenCalledTimes(2));

    expect(vi.mocked(startFullBook).mock.calls[1]![1]).toBe(
      vi.mocked(startFullBook).mock.calls[0]![1],
    );
    await waitFor(() =>
      expect(window.sessionStorage.getItem('proser:workflow-launch:full_book')).toBeNull(),
    );
  });

  it.each([
    [409, 'CONFLICT'],
    [425, 'WORKFLOW_IN_PROGRESS'],
    [429, 'RATE_LIMITED'],
  ])('retains a launch key for uncertain %i %s responses', async (status, code) => {
    const launched = {
      ...(await listBookWorkflows('4'))[0]!,
      runId: `retained-${status}`,
      status: 'queued',
      phase: 'queued',
    };
    vi.mocked(startFullBook)
      .mockRejectedValueOnce(new FactoryRequestError(status, 'Operation unresolved', code))
      .mockResolvedValueOnce(launched);
    render(<WorkflowsPage />);
    fireEvent.change(screen.getByPlaceholderText('Approved premise'), {
      target: { value: `An uncertain ${status} response.` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));
    await waitFor(() => expect(startFullBook).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(startFullBook).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startFullBook).mock.calls[1]![1]).toBe(
      vi.mocked(startFullBook).mock.calls[0]![1],
    );
  });

  it('allows intentional abandonment of an uncertain launch', async () => {
    vi.mocked(startFullBook).mockRejectedValueOnce(
      new FactoryRequestError(409, 'Still active', 'CONFLICT'),
    );
    render(<WorkflowsPage />);
    fireEvent.change(screen.getByPlaceholderText('Approved premise'), {
      target: { value: 'A launch the author may intentionally abandon.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Pending operations')).not.toBeInTheDocument(),
    );
    expect(window.sessionStorage.getItem('proser:workflow-launch:full_book')).toBeNull();
  });

  it('abandons a retained launch key after a definitive rejection', async () => {
    const launched = {
      ...(await listBookWorkflows('4'))[0]!,
      runId: 'accepted-after-rejection',
      status: 'queued',
      phase: 'queued',
    };
    vi.mocked(startFullBook)
      .mockRejectedValueOnce(new FactoryRequestError(422, 'Premise rejected', 'VALIDATION_FAILED'))
      .mockResolvedValueOnce(launched);
    render(<WorkflowsPage />);
    fireEvent.change(screen.getByPlaceholderText('Approved premise'), {
      target: { value: 'A definitive validation case.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));
    await waitFor(() => expect(startFullBook).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start Full Book' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start Full Book' }));
    await waitFor(() => expect(startFullBook).toHaveBeenCalledTimes(2));

    expect(vi.mocked(startFullBook).mock.calls[1]![1]).not.toBe(
      vi.mocked(startFullBook).mock.calls[0]![1],
    );
  });

  it('treats version zero as authoritative and rejects an update that omits its version', async () => {
    vi.useFakeTimers();
    const running = {
      ...(await listBookWorkflows('4'))[0]!,
      status: 'running',
      phase: 'version_zero_current',
      statusVersion: 0,
      progress: { completed: 1, total: 10, percent: 10 },
      lastHeartbeatAt: '2026-07-20T10:00:00.000Z',
    };
    vi.mocked(listBookWorkflows).mockResolvedValue([running]);
    vi.mocked(getWorkflow).mockResolvedValue({
      ...running,
      phase: 'missing_version_update',
      statusVersion: undefined,
      progress: { completed: 9, total: 10, percent: 90 },
      lastHeartbeatAt: '2026-07-20T10:01:00.000Z',
    });
    render(<WorkflowsPage />);
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(screen.queryByText('missing version update')).not.toBeInTheDocument();
    expect(screen.getAllByText(/version zero current/i).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('rejects version zero when the current authoritative version is higher', async () => {
    vi.useFakeTimers();
    const running = {
      ...(await listBookWorkflows('4'))[0]!,
      status: 'running',
      phase: 'version_one_current',
      statusVersion: 1,
      progress: { completed: 4, total: 10, percent: 40 },
      lastHeartbeatAt: '2026-07-20T10:00:00.000Z',
    };
    vi.mocked(listBookWorkflows).mockResolvedValue([running]);
    vi.mocked(getWorkflow).mockResolvedValue({
      ...running,
      phase: 'version_zero_stale',
      statusVersion: 0,
      progress: { completed: 9, total: 10, percent: 90 },
      lastHeartbeatAt: '2026-07-20T10:01:00.000Z',
    });
    render(<WorkflowsPage />);
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(screen.queryByText('version zero stale')).not.toBeInTheDocument();
    expect(screen.getAllByText(/version one current/i).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('keeps one status poll in flight and rejects an older heartbeat response', async () => {
    vi.useFakeTimers();
    const running = {
      ...(await listBookWorkflows('4'))[0]!,
      status: 'running',
      phase: 'current_phase',
      progress: { completed: 5, total: 10, percent: 50 },
      lastHeartbeatAt: '2026-07-20T10:00:00.000Z',
    };
    vi.mocked(listBookWorkflows).mockResolvedValue([running]);
    let resolvePoll!: (run: typeof running) => void;
    vi.mocked(getWorkflow).mockImplementation(
      async () =>
        new Promise<typeof running>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    render(<WorkflowsPage />);
    await act(async () => undefined);

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(getWorkflow).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getWorkflow).toHaveBeenCalledTimes(1);

    await act(async () =>
      resolvePoll({
        ...running,
        phase: 'stale_phase',
        progress: { completed: 1, total: 10, percent: 10 },
        lastHeartbeatAt: '2026-07-20T09:59:00.000Z',
      }),
    );
    expect(screen.queryByText('stale phase')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('surfaces repeated status polling failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const running = {
      ...(await listBookWorkflows('4'))[0]!,
      status: 'running',
      phase: 'drafting',
    };
    vi.mocked(listBookWorkflows).mockResolvedValue([running]);
    vi.mocked(getWorkflow).mockRejectedValue(new Error('poll unavailable'));
    render(<WorkflowsPage />);
    await act(async () => undefined);

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(getWorkflow).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(getWorkflow).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(getWorkflow).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getWorkflow).toHaveBeenCalledTimes(3);
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => alert.textContent?.includes('workflow status polling')),
    ).toBe(true);
    vi.useRealTimers();
  });

  it('does not poll a publishable candidate terminal workflow', async () => {
    vi.useFakeTimers();
    vi.mocked(listBookWorkflows).mockResolvedValue([
      {
        ...(await listBookWorkflows('4'))[0]!,
        status: 'publishable_candidate',
        phase: 'publishable_candidate',
      },
    ]);
    render(<WorkflowsPage />);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it('pauses polling while the page is hidden and resumes when visible', async () => {
    vi.useFakeTimers();
    const running = {
      ...(await listBookWorkflows('4'))[0]!,
      status: 'running',
      phase: 'drafting',
    };
    vi.mocked(listBookWorkflows).mockResolvedValue([running]);
    vi.mocked(getWorkflow).mockResolvedValue(running);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    render(<WorkflowsPage />);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(getWorkflow).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getWorkflow).toHaveBeenCalledTimes(1);
  });
});
