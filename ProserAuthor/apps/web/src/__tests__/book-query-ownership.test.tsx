import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBooks } from '@/hooks/queries/use-books';
import { listBooks } from '@/lib/api';
const identity = vi.hoisted(() => ({ userId: 'author-one' as string | undefined }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: identity.userId ? { user: { id: identity.userId } } : null }),
}));
vi.mock('@/lib/api', () => ({ listBooks: vi.fn() }));
beforeEach(() => {
  identity.userId = 'author-one';
  vi.resetAllMocks();
});
const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useBooks(), { wrapper }) };
};
describe('book query ownership', () => {
  it('hides cached books immediately when a different author authenticates or logs out', async () => {
    vi.mocked(listBooks).mockResolvedValue({ data: [{ id: '1', title: 'Private first book' }] });
    const { result, rerender, client } = setup();
    await waitFor(() => expect(result.current.data?.[0]?.title).toBe('Private first book'));
    let complete!: (value: Awaited<ReturnType<typeof listBooks>>) => void;
    vi.mocked(listBooks).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    identity.userId = 'author-two';
    rerender();
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      complete({ data: [{ id: '2', title: 'Second author book' }] });
    });
    await waitFor(() => expect(result.current.data?.[0]?.title).toBe('Second author book'));
    identity.userId = undefined;
    rerender();
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
    client.clear();
  });
  it('keeps a late first-author response out of the current author’s cache', async () => {
    let complete!: (value: Awaited<ReturnType<typeof listBooks>>) => void;
    vi.mocked(listBooks)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({ data: [{ id: '2', title: 'Second author book' }] });
    const { result, rerender, client } = setup();
    identity.userId = 'author-two';
    rerender();
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('2'));
    await act(async () => {
      complete({ data: [{ id: '1', title: 'Private delayed book' }] });
    });
    expect(result.current.data?.[0]?.id).toBe('2');
    client.clear();
  });
});
