import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignDetail } from '@cheftaco/proser-contracts';
import { CampaignWorkflow } from '@/components/campaigns/campaign-workflow';
const campaignId = '5d16eb2b-f8c9-48c9-a68d-4cdfc216f823';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  dispatch: vi.fn(),
  error: vi.fn(),
  replace: vi.fn(),
  manifest: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'author' } } }) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams('bookId=7&campaignId=5d16eb2b-f8c9-48c9-a68d-4cdfc216f823'),
}));
vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ activeBookId: '7', setActiveBookId: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-books', () => ({
  useBooks: () => ({ data: [{ id: '7', title: 'Test manuscript' }] }),
}));
vi.mock('@/hooks/use-protected-router', () => ({
  useProtectedRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/lib/document-history-navigation', () => ({
  registerDocumentNavigationFence: () => () => undefined,
}));
vi.mock('@/lib/campaign-api', () => ({ campaignRequest: mocks.request }));
vi.mock('@/lib/document-api', () => ({ getDocumentManifest: mocks.manifest }));
vi.mock('@/hooks/use-campaign-actions', () => ({
  useCampaignActions: () => ({
    ready: true,
    blocked: false,
    busy: false,
    dispatch: mocks.dispatch,
    setError: mocks.error,
  }),
}));
const original: CampaignDetail = {
  campaign: {
    id: campaignId,
    bookId: 7,
    version: 1,
    goal: 'Original objective',
    preset: 'antagonist',
    constraints: { facts: [], voice: [] },
    confirmed: false,
    status: 'active',
  },
  plans: [],
  verifications: [],
  complete: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.manifest.mockResolvedValue({ revisionId: 'a70d016e-6273-4d02-a0a2-bcfb694444a1' });
});
describe('campaign status polling', () => {
  it('keeps Refresh enabled and focused during a background read', async () => {
    vi.useFakeTimers();
    const running: CampaignDetail = {
      ...original,
      plans: [
        {
          id: 'plan',
          campaignId,
          runId: 'run',
          campaignVersion: 1,
          bookRevisionId: 'revision',
          stale: false,
          approved: false,
          workflowStatus: 'running',
          decisions: [],
        },
      ],
    };
    let finishPoll!: (value: CampaignDetail) => void;
    const poll = new Promise<CampaignDetail>((resolve) => {
      finishPoll = resolve;
    });
    mocks.request
      .mockResolvedValueOnce([original.campaign])
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(poll);
    try {
      await act(async () => render(<CampaignWorkflow />));
      const refresh = screen.getByRole('button', { name: 'Refresh saved campaign' });
      refresh.focus();
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(mocks.request).toHaveBeenCalledTimes(3);
      expect(refresh).toBeEnabled();
      expect(refresh).not.toHaveAttribute('aria-disabled');
      expect(refresh).toHaveFocus();
      expect(screen.queryByText('Updating saved campaign…')).toBeNull();
      expect(screen.getByRole('button', { name: 'Scan whole manuscript' })).toBeDisabled();

      await act(async () => finishPoll(original));
      expect(refresh).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Scan whole manuscript' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('campaign metadata acknowledgment adoption', () => {
  it('blocks analysis until the acknowledged campaign version has finished loading', async () => {
    let loadCount = 0;
    let finishReload!: (value: CampaignDetail) => void;
    const delayed = new Promise<CampaignDetail>((resolve) => {
      finishReload = resolve;
    });
    mocks.request.mockImplementation((path: string) =>
      path.endsWith('/' + campaignId)
        ? ++loadCount === 1
          ? Promise.resolve(original)
          : delayed
        : Promise.resolve([original.campaign]),
    );
    mocks.dispatch.mockResolvedValue({ campaignId, version: 2 });
    render(<CampaignWorkflow />);
    await waitFor(() =>
      expect(screen.getByLabelText('Revision goal')).toHaveValue('Original objective'),
    );
    fireEvent.change(screen.getByLabelText('Revision goal'), {
      target: { value: 'Strengthen the antagonist' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save confirmed protections and goal' }));
    await waitFor(() => expect(loadCount).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name: 'Scan whole manuscript' })).toBeDisabled();
    expect(screen.getByText('Updating saved campaign…')).toBeInTheDocument();
    await act(async () =>
      finishReload({
        ...original,
        campaign: { ...original.campaign, version: 2, goal: 'Strengthen the antagonist' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Scan whole manuscript' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Scan whole manuscript' }));
    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          path: expect.stringContaining('/analyses'),
          body: expect.objectContaining({ expectedVersion: 2 }),
        }),
      ),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
