import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EditorialPage from '@/app/editorial/page';
import EditorialRunPage from '@/app/editorial/runs/[runId]/page';
import EditorialQualityLabPage from '@/app/editorial/quality-lab/page';
import MobileEditorialPage from '@/app/m/editorial/page';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import {
  getEditorialRun,
  getEditorialSummary,
  listBookEditorialRuns,
  listEditorialBenchmarks,
  listEditorialPasses,
  listEditorialProposals,
  startEditorialBenchmark,
  type EditorialPassPack,
} from '@/lib/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ runId: '11111111-1111-4111-8111-111111111111' }),
  usePathname: () => '/editorial',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/motion/primitives', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: vi.fn() }));
vi.mock('@/hooks/queries/use-books', () => ({ useBooks: vi.fn() }));
vi.mock('@/lib/api', () => ({
  activateEditorialProfile: vi.fn(),
  applyEditorialProposal: vi.fn(),
  createEditorialProfile: vi.fn(),
  getEditorialProposal: vi.fn(),
  getEditorialRun: vi.fn(),
  getEditorialSummary: vi.fn(),
  listBookEditorialRuns: vi.fn(),
  listEditorialBenchmarks: vi.fn(),
  listEditorialPasses: vi.fn(),
  listEditorialProfiles: vi.fn(),
  listEditorialProposals: vi.fn(),
  recordEditorialPreference: vi.fn(),
  resolveEditorialProfile: vi.fn(),
  startEditorialBenchmark: vi.fn(),
  startEditorialOptimize: vi.fn(),
  undoEditorialProposal: vi.fn(),
}));

const pass: EditorialPassPack = {
  key: 'line_edit_safe' as const,
  version: '1.0.0',
  displayName: 'Safe line edit',
  description: 'Localized clarity and cadence improvements.',
  supportedScopes: ['book', 'act', 'chapter', 'scene'],
  defaultAutonomy: 'safe_auto' as const,
  allowedRisk: ['low'],
  mayChange: ['wording'],
  mustPreserve: ['canon', 'voice'],
  defaultBudget: {
    maxChangedWordsPercentPerScene: 10,
    maxChangedWordsPercentTotal: 8,
    maxProposals: 50,
    maxCandidatesPerProposal: 2,
    maxInferenceTokens: 100_000,
    maxJudgeEscalations: 1,
  },
};

const summary = {
  runId: '11111111-1111-4111-8111-111111111111',
  status: 'completed' as const,
  outcome: 'completed_with_skips' as const,
  bookId: 4,
  scope: { type: 'scene' as const, id: 9 },
  sourceRevisionId: '22222222-2222-4222-8222-222222222222',
  resultRevisionId: null,
  passPack: { key: 'line_edit_safe' as const, version: '1.0.0' },
  policyVersion: 'editorial-policy-v1',
  profile: { id: null, version: '1.0.0', hash: 'abc' },
  counts: {
    scopesReviewed: 1,
    findingsCreated: 2,
    proposalsGenerated: 1,
    proposalsApplied: 0,
    originalWins: 1,
    noClearWinner: 0,
    skipped: 1,
    verificationPassed: 0,
    verificationFailed: 0,
  },
  change: { changedWords: 0, changedWordsPercent: 0 },
  quality: { hardInvariantsPassed: true, judgeAgreementRate: 1, styleDriftWithinProfile: true },
  unresolved: { count: 1, topCategories: ['repetition'] },
};

describe('editorial Author surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useBooks).mockReturnValue({
      data: [{ id: '4', title: 'The Glass Orchard' }],
      isLoading: false,
    } as ReturnType<typeof useBooks>);
    vi.mocked(useWorkspace).mockReturnValue({
      activeBookId: '4',
      activeBookTitle: 'The Glass Orchard',
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
    vi.mocked(listEditorialPasses).mockResolvedValue([pass]);
    vi.mocked(listBookEditorialRuns).mockResolvedValue([]);
    vi.mocked(getEditorialRun).mockResolvedValue({
      workflowRunId: summary.runId,
      status: 'completed',
      outcome: summary.outcome,
      evidenceSummary: summary,
      workflowRun: {
        status: 'completed',
        phase: 'completed',
        progress: { percent: 100 },
        lastHeartbeatAt: null,
        failureReason: null,
      },
    });
    vi.mocked(getEditorialSummary).mockResolvedValue(summary);
    vi.mocked(listEditorialProposals).mockResolvedValue({
      items: [
        {
          id: 'proposal-1',
          scopeType: 'scene',
          scopeId: 9,
          passKey: 'line_edit_safe',
          passVersion: '1.0.0',
          risk: 'low',
          confidence: 0.84,
          status: 'skipped',
          skipReason: 'original_wins',
          originalText: 'The original.',
          verificationStatus: 'not_applied',
        },
      ],
      nextCursor: null,
    });
    vi.mocked(listEditorialBenchmarks).mockResolvedValue([]);
  });

  it('renders pass discovery, launch safety, profiles, and Quality Lab without checkpoint controls', async () => {
    render(<EditorialPage />);
    expect((await screen.findAllByText('Safe line edit')).length).toBeGreaterThan(0);
    expect(screen.getByText(/No checkpoint is created/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Profiles/ })).toHaveAttribute(
      'href',
      '/editorial/profiles',
    );
    expect(screen.getByRole('link', { name: /Quality Lab/ })).toHaveAttribute(
      'href',
      '/editorial/quality-lab',
    );
    expect(
      screen.queryByRole('button', { name: /approve|resume|checkpoint/i }),
    ).not.toBeInTheDocument();
  });

  it('shows terminal progress, evidence, skipped proposals, and before/after affordances', async () => {
    render(<EditorialRunPage />);
    expect(await screen.findByText('completed with skips')).toBeInTheDocument();
    expect(await screen.findByText('Before / after evidence')).toBeInTheDocument();
    expect(screen.getByText(/original wins/i)).toBeInTheDocument();
    expect(screen.getByText('Hard invariants')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /approve|resume|checkpoint/i }),
    ).not.toBeInTheDocument();
  });

  it('runs and refreshes deterministic Quality Lab evidence', async () => {
    vi.mocked(startEditorialBenchmark).mockResolvedValue({
      id: 'benchmark-1',
      suiteKey: 'editorial-deterministic',
      suiteVersion: '1.0.0',
      status: 'completed',
    });
    render(<EditorialQualityLabPage />);
    await userEvent.click(screen.getByRole('button', { name: /Run deterministic suite/ }));
    await waitFor(() =>
      expect(startEditorialBenchmark).toHaveBeenCalledWith(
        { suiteKey: 'editorial-deterministic', maximumCases: 20, live: false },
        expect.any(String),
      ),
    );
    expect(screen.getByText('Hard invariants')).toBeInTheDocument();
  });

  it('provides a compact mobile editorial launch and no approval gate', async () => {
    render(<MobileEditorialPage />);
    expect(await screen.findByText('Revision folio')).toBeInTheDocument();
    expect(screen.getByText(/No approval queue/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start pass/ })).toBeEnabled();
    expect(screen.queryByText(/checkpoint approval/i)).not.toBeInTheDocument();
  });
});
