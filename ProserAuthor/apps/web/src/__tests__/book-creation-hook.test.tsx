import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useBookCreation } from '@/hooks/use-book-creation';
import { documentCapabilitiesFixture } from './document-capabilities-fixture';
import { getAuthoringDocumentCapabilities } from '@/lib/document-api';
import { createBook } from '@/lib/api';
import * as journal from '@/lib/book-creation-intent';
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  createBook: vi.fn(),
}));
vi.mock('@/lib/document-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/document-api')>('@/lib/document-api')),
  getAuthoringDocumentCapabilities: vi.fn(),
}));
vi.mock('@/lib/book-creation-intent', async () => ({
  ...(await vi.importActual<typeof import('@/lib/book-creation-intent')>(
    '@/lib/book-creation-intent',
  )),
  readBookCreationIntent: vi.fn(),
  writeBookCreationIntent: vi.fn(),
  deleteBookCreationIntent: vi.fn(),
}));
let pending: journal.BookCreationIntent | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  pending = undefined;
  vi.mocked(getAuthoringDocumentCapabilities).mockResolvedValue(documentCapabilitiesFixture());
  vi.mocked(journal.readBookCreationIntent).mockImplementation(async (user) =>
    pending?.userId === user ? structuredClone(pending) : undefined,
  );
  vi.mocked(journal.writeBookCreationIntent).mockImplementation(async (row) => {
    pending = structuredClone(row);
  });
  vi.mocked(journal.deleteBookCreationIntent).mockResolvedValue(undefined);
});
it('hides owned recovery on logout/account switch and suppresses a retired session even after the original account returns', async () => {
  let done!: (value: Awaited<ReturnType<typeof createBook>>) => void;
  vi.mocked(createBook).mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const { result, rerender } = renderHook(({ user }) => useBookCreation(user), {
    initialProps: { user: 'first' as string | undefined },
  });
  await waitFor(() => expect(result.current.ready).toBe(true));
  let action!: Promise<unknown>;
  await act(async () => {
    action = result.current.session!.create({ title: 'Owned original' });
  });
  await waitFor(() => expect(createBook).toHaveBeenCalledTimes(1));
  expect(result.current.pending?.request.title).toBe('Owned original');
  rerender({ user: undefined });
  expect(result.current.pending).toBeUndefined();
  rerender({ user: 'second' });
  expect(result.current.pending).toBeUndefined();
  rerender({ user: 'first' });
  await waitFor(() => expect(result.current.pending?.request.title).toBe('Owned original'));
  await act(async () => {
    done({ data: { id: '2', title: 'Owned original' } });
    await expect(action).rejects.toThrow('same author');
  });
  expect(journal.deleteBookCreationIntent).not.toHaveBeenCalled();
  expect(result.current.pending?.request.title).toBe('Owned original');
});
