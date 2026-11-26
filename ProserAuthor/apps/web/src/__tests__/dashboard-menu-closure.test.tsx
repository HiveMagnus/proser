import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/page';
import type { BookCatalogSnapshot } from '@/lib/document-book-catalog-journal';
const mocks = vi.hoisted(() => ({
  user: 'author',
  prepare: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
  mutate: vi.fn(),
  discard: vi.fn(),
  pending: undefined as import('@/lib/document-book-catalog-journal').BookCatalogIntent | undefined,
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mocks.user ? { user: { id: mocks.user } } : null }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock('@/hooks/queries/use-books', () => ({
  bookKeys: { list: (user: string) => ['books', 'list', user] },
  useBooks: () => ({ data: books, isLoading: false }),
  useCreateBook: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
    creation: { ready: true, busy: false },
    recoverCreation: vi.fn(),
    retryCreation: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-document-book-catalog', () => ({
  useDocumentBookCatalog: () => ({
    prepare: mocks.prepare,
    update: mocks.update,
    remove: mocks.remove,
    busy: false,
    pending: mocks.pending,
    recover: vi.fn(),
    retry: vi.fn(),
    discardRejected: mocks.discard,
  }),
}));
vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({
    activeBookId: '1',
    activeBookTitle: 'Cached title',
    setActiveBookId: vi.fn(),
    setActiveBookTitle: vi.fn(),
  }),
}));
vi.mock('@/components/motion/primitives', () => ({
  PageTransition: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  FadeIn: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  AnimatedNumber: ({ value }: { value: number }) => <span>{value}</span>,
  ProgressRing: () => null,
}));
const books = [
  {
    id: '1',
    title: 'Cached title',
    genre: 'fantasy',
    summary: 'Cached summary',
    updatedAt: '2026-10-07T00:00:00Z',
  },
];
const snapshot: BookCatalogSnapshot = {
  snapshotId: 'frozen-snapshot',
  userId: 'author',
  bookId: '1',
  book: { ...books[0]!, title: 'Saved dialog source', summary: 'Immutable saved summary' },
  bookRevisionId: 'book-original',
  structureRevisionId: 'structure-original',
  sourceBook: { title: 'Saved dialog source' } as BookCatalogSnapshot['sourceBook'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = 'author';
  mocks.pending = undefined;
  mocks.prepare.mockResolvedValue(snapshot);
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.discard.mockImplementation(async () => {
    mocks.pending = undefined;
  });
});
it('closes the actual project menu when editing and restores dashboard accessibility after rejected-change discard', async () => {
  mocks.update.mockImplementation(async () => {
    mocks.pending = {
      schemaVersion: 1,
      userId: 'author',
      bookId: '1',
      version: 'v1',
      updatedAt: Date.now(),
      operationId: 'stale-update',
      kind: 'update',
      status: 'rejected',
      snapshot,
      patch: { title: 'Updated title' },
      preconditions: {
        operationId: 'stale-update',
        expectedRevisionId: 'book-original',
        expectedScopes: { structure: 'structure-original' },
      },
    };
    throw new Error('Saved source changed (412)');
  });
  render(<DashboardPage />);
  await userEvent.click(screen.getByRole('button', { name: 'Project options for Cached title' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit Details' }));
  await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Saved dialog source'));
  expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('Title'));
  await userEvent.type(screen.getByLabelText('Title'), 'Updated title');
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Discard rejected project change' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Edit Project' })).not.toBeInTheDocument(),
  );
  const options = screen.getByRole('button', { name: 'Project options for Cached title' });
  expect(options.closest('[aria-hidden="true"]')).toBeNull();
  await userEvent.click(options);
  expect(await screen.findByRole('menuitem', { name: 'Delete Project' })).toBeInTheDocument();
});
it('closes the actual project menu for delete confirmation and restores controls on cancellation', async () => {
  render(<DashboardPage />);
  await userEvent.click(screen.getByRole('button', { name: 'Project options for Cached title' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete Project' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Project' });
  await waitFor(() => expect(dialog).toHaveTextContent('Saved dialog source'));
  expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Delete Project' })).not.toBeInTheDocument(),
  );
  expect(
    screen
      .getByRole('button', { name: 'Project options for Cached title' })
      .closest('[aria-hidden="true"]'),
  ).toBeNull();
  expect(mocks.remove).not.toHaveBeenCalled();
});
