import { act, render, screen, waitFor, within } from '@testing-library/react';
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
    pending: undefined,
    recover: vi.fn(),
    retry: vi.fn(),
    discardRejected: vi.fn(),
  }),
}));
vi.mock('@/hooks/queries/use-analytics', () => ({ useWritingStats: () => ({ data: undefined }) }));
vi.mock('@/hooks/queries/use-recommendations', () => ({
  useRecommendations: () => ({ data: undefined }),
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
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    asChild,
    onSelect,
  }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler;
    onSelect?: () => void;
    asChild?: boolean;
  }>) =>
    asChild ? (
      <>{children}</>
    ) : (
      <button
        type="button"
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onSelect?.();
        }}
      >
        {children}
      </button>
    ),
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
  books.splice(1);
  mocks.user = 'author';
  mocks.prepare.mockResolvedValue(snapshot);
  mocks.update.mockResolvedValue({ status: 'completed' });
  mocks.remove.mockResolvedValue({ status: 'completed' });
  mocks.invalidate.mockResolvedValue(undefined);
});
it('edits only the immutable dialog-open metadata and never refreshes its revision at submission', async () => {
  render(<DashboardPage />);
  expect(
    screen.getByRole('button', { name: 'Project options for Cached title' }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Details' }));
  await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Saved dialog source'));
  expect(screen.getByLabelText('Summary')).toHaveValue('Immutable saved summary');
  await userEvent.clear(screen.getByLabelText('Title'));
  await userEvent.type(screen.getByLabelText('Title'), 'Explicit updated title');
  await userEvent.clear(screen.getByLabelText('Summary'));
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith(
      snapshot,
      expect.objectContaining({ title: 'Explicit updated title', summary: '' }),
    ),
  );
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['books', 'list', 'author'] });
});
it('prepares deletion before confirmation and submits the same owned revision snapshot', async () => {
  render(<DashboardPage />);
  await userEvent.click(screen.getByRole('button', { name: 'Delete Project' }));
  const confirmation = await screen.findByRole('dialog', { name: 'Delete Project' });
  await waitFor(() => expect(confirmation).toHaveTextContent('Saved dialog source'));
  await userEvent.click(screen.getAllByRole('button', { name: 'Delete Project' }).at(-1)!);
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(snapshot));
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
});
it('removes an owned open form immediately on logout rather than exposing it to another session', async () => {
  const { rerender } = render(<DashboardPage />);
  await userEvent.click(screen.getByRole('button', { name: 'New Project' }));
  await userEvent.type(screen.getByLabelText('Title'), 'Private unsaved title');
  mocks.user = '';
  rerender(<DashboardPage />);
  expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Authenticate');
});

it('ignores a cancelled edit source when another book opens and its preparation rejects as busy', async () => {
  books.push({ ...books[0]!, id: '2', title: 'Second selected book' });
  let resolve!: (value: BookCatalogSnapshot) => void;
  mocks.prepare
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockRejectedValueOnce(new Error('Second preparation is busy'));
  render(<DashboardPage />);
  await userEvent.click(screen.getAllByRole('button', { name: 'Edit Details' })[0]!);
  const first = await screen.findByRole('dialog', { name: 'Edit Project' });
  await userEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  await userEvent.click(screen.getAllByRole('button', { name: 'Edit Details' })[1]!);
  const second = await screen.findByRole('dialog', { name: 'Edit Project' });
  expect(await within(second).findByRole('alert')).toHaveTextContent('Second preparation is busy');
  await act(async () => {
    resolve(snapshot);
  });
  expect(within(second).getByLabelText('Title')).toHaveValue('');
  expect(within(second).getByLabelText('Summary')).toHaveValue('');
  expect(within(second).getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  expect(within(second).getByRole('alert')).toHaveTextContent('Second preparation is busy');
  expect(mocks.update).not.toHaveBeenCalled();
});
it('invalidates cancelled delete preparation so a late other-book source cannot enable deletion', async () => {
  books.push({ ...books[0]!, id: '2', title: 'Second selected book' });
  let resolve!: (value: BookCatalogSnapshot) => void;
  mocks.prepare
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockRejectedValueOnce(new Error('Second deletion preparation is busy'));
  render(<DashboardPage />);
  await userEvent.click(screen.getAllByRole('button', { name: 'Delete Project' })[0]!);
  const first = await screen.findByRole('dialog', { name: 'Delete Project' });
  await userEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  await userEvent.click(screen.getAllByRole('button', { name: 'Delete Project' })[1]!);
  const second = await screen.findByRole('dialog', { name: 'Delete Project' });
  await within(second).findByRole('alert');
  await act(async () => {
    resolve(snapshot);
  });
  expect(second).not.toHaveTextContent('Saved dialog source');
  expect(within(second).getByRole('button', { name: 'Delete Project' })).toBeDisabled();
  expect(within(second).getByRole('alert')).toHaveTextContent(
    'Second deletion preparation is busy',
  );
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('ignores a late cancelled preparation failure without overwriting the next dialog’s valid source or enabling the wrong target', async () => {
  books.push({ ...books[0]!, id: '2', title: 'Second selected book' });
  let reject!: (error: Error) => void;
  const secondSnapshot = {
    ...snapshot,
    snapshotId: 'second-snapshot',
    bookId: '2',
    book: { ...books[1]!, title: 'Second saved source' },
  };
  mocks.prepare
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce(secondSnapshot);
  render(<DashboardPage />);
  await userEvent.click(screen.getAllByRole('button', { name: 'Edit Details' })[0]!);
  await userEvent.click(
    within(await screen.findByRole('dialog', { name: 'Edit Project' })).getByRole('button', {
      name: 'Cancel',
    }),
  );
  await userEvent.click(screen.getAllByRole('button', { name: 'Edit Details' })[1]!);
  await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Second saved source'));
  await act(async () => {
    reject(new Error('Old cancelled source error'));
  });
  expect(screen.queryByText('Old cancelled source error')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith(secondSnapshot, expect.any(Object)),
  );
});
