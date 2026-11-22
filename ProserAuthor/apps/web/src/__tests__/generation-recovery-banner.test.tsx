import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationRecoveryBanner } from '../components/layout/generation-recovery-banner';
import {
  cancelGenerationOperation,
  getGenerationArtifact,
  lookupGenerationOperation,
} from '../lib/api';

vi.mock('../lib/api', () => ({
  lookupGenerationOperation: vi.fn(),
  getGenerationArtifact: vi.fn(),
  cancelGenerationOperation: vi.fn(),
}));

const operation = {
  operationId: 'operation-1',
  idempotencyKey: 'retained-key',
  requestHash: 'a'.repeat(64),
  route: 'generate.prose',
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  latestCursor: 3,
};

describe('GenerationRecoveryBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      'proser:generation:retained-key',
      JSON.stringify({
        version: 1,
        idempotencyKey: 'retained-key',
        request: { bookId: 42, prompt: 'retained prompt' },
        state: 'detached',
        operationId: operation.operationId,
        operationStatus: operation.status,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now(),
      }),
    );
    vi.mocked(lookupGenerationOperation).mockResolvedValue(operation);
    vi.mocked(getGenerationArtifact).mockReset();
    vi.mocked(cancelGenerationOperation).mockResolvedValue({
      ...operation,
      status: 'cancelled',
    });
  });

  it('visibly distinguishes abandoning observation from cancelling Factory work', async () => {
    render(<GenerationRecoveryBanner />);

    expect(await screen.findByText('Background generations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop tracking' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel generation' })).toBeInTheDocument();
    expect(screen.getByText(/Stopping tracking does not cancel Factory work/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
    await waitFor(() =>
      expect(cancelGenerationOperation).toHaveBeenCalledWith(operation.operationId),
    );
    await waitFor(() =>
      expect(window.sessionStorage.getItem('proser:generation:retained-key')).toContain(
        '"state":"cancelled"',
      ),
    );
    expect(await screen.findByText('Generation was cancelled.')).toBeInTheDocument();
  });

  it('recovers and verifies a completed artifact into the generation inbox', async () => {
    const artifactHash = 'bf0a1fe677ec6ec08318bd4913c4d8f89cbca99f967a2e147fec686bd9cd37f0';
    const completed = { ...operation, status: 'completed' as const, artifactHash };
    vi.mocked(lookupGenerationOperation).mockResolvedValue(completed);
    vi.mocked(getGenerationArtifact).mockResolvedValue({
      operation: completed,
      artifact: 'completed prose',
    });

    render(<GenerationRecoveryBanner />);

    expect(await screen.findByText('Completed generation inbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy result' })).toBeInTheDocument();
    expect(screen.getByText(/completed while this page was away/i)).toBeInTheDocument();
    expect(window.sessionStorage.getItem('proser:generation:retained-key')).toContain(
      '"state":"completed"',
    );
  });

  it('pauses reconciliation while the browser is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    render(<GenerationRecoveryBanner />);

    expect(await screen.findByText('Background generations')).toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(lookupGenerationOperation).not.toHaveBeenCalled();
  });
});
