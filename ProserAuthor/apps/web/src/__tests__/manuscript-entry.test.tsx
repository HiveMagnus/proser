import { documentCapabilitiesFixture } from './document-capabilities-fixture';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ManuscriptPage from '@/app/manuscript/page';
import { getAuthoringDocumentCapabilities } from '@/lib/document-api';
const identity = vi.hoisted(() => ({ userId: 'author-one' as string | undefined }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: identity.userId ? { user: { id: identity.userId } } : null }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => <div>Legacy compatibility writer</div> }));
vi.mock('@/components/editor/manuscript-workspace', () => ({
  ManuscriptWorkspace: () => <div>Structured manuscript writer</div>,
}));
vi.mock('@/lib/document-api', () => ({ getAuthoringDocumentCapabilities: vi.fn() }));
beforeEach(() => {
  identity.userId = 'author-one';
  vi.resetAllMocks();
});
describe('desktop manuscript capability boundary', () => {
  it('waits for capability negotiation before mounting any writer', async () => {
    let resolve!: (value: ReturnType<typeof documentCapabilitiesFixture>) => void;
    vi.mocked(getAuthoringDocumentCapabilities).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<ManuscriptPage />);
    expect(screen.queryByText('Legacy compatibility writer')).not.toBeInTheDocument();
    expect(screen.queryByText('Structured manuscript writer')).not.toBeInTheDocument();
    await act(async () => {
      resolve(documentCapabilitiesFixture({ enabled: true, schemaVersion: 1 }));
    });
    expect(screen.getByText('Structured manuscript writer')).toBeInTheDocument();
    expect(screen.queryByText('Legacy compatibility writer')).not.toBeInTheDocument();
  });
  it('keeps editing unavailable when Factory document authority is inactive', async () => {
    vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ enabled: false, schemaVersion: 1 }),
    );
    render(<ManuscriptPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('document authority is inactive');
    expect(screen.queryByText('Structured manuscript writer')).not.toBeInTheDocument();
  });
  it('fails closed on a capability failure or unsupported schema', async () => {
    vi.mocked(getAuthoringDocumentCapabilities).mockRejectedValue(new Error('Factory unavailable'));
    const { unmount } = render(<ManuscriptPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Factory unavailable');
    expect(screen.queryByText('Legacy compatibility writer')).not.toBeInTheDocument();
    unmount();
    vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(
      documentCapabilitiesFixture({ enabled: true, schemaVersion: 2 }),
    );
    render(<ManuscriptPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported document schema');
    expect(screen.queryByText('Structured manuscript writer')).not.toBeInTheDocument();
  });
  it('hides the old author’s surface immediately and ignores its late capability response', async () => {
    let resolve!: (value: ReturnType<typeof documentCapabilitiesFixture>) => void;
    vi.mocked(getAuthoringDocumentCapabilities)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(documentCapabilitiesFixture({ enabled: true, schemaVersion: 1 }));
    const { rerender } = render(<ManuscriptPage />);
    identity.userId = undefined;
    rerender(<ManuscriptPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Authenticate');
    await act(async () => {
      resolve(documentCapabilitiesFixture({ enabled: false, schemaVersion: 1 }));
    });
    expect(screen.queryByText('Legacy compatibility writer')).not.toBeInTheDocument();
    identity.userId = 'author-two';
    rerender(<ManuscriptPage />);
    await waitFor(() =>
      expect(screen.getByText('Structured manuscript writer')).toBeInTheDocument(),
    );
  });
});
