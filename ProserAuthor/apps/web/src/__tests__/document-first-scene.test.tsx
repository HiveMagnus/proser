import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DocumentFirstScene } from '@/components/editor/document-first-scene';
const creation = vi.hoisted(() => ({
  create: vi.fn(),
  recover: vi.fn(),
  retry: vi.fn(),
  discardRejected: vi.fn(),
  pending: undefined as
    undefined | { userId: string; operationId: string; retryAllowed: boolean; rejected?: boolean },
  journalError: undefined,
}));
vi.mock('@/hooks/use-document-quick-draft', () => ({ useDocumentQuickDraft: () => creation }));
vi.mock('@/components/editor/document-navigation-guard', () => ({
  DocumentNavigationGuard: () => null,
}));
const base = { bookRevisionId: 'displayed-book', structureRevisionId: 'displayed-structure' };
beforeEach(() => {
  vi.resetAllMocks();
  creation.pending = undefined;
});
it('starts a scene through the durable service using the displayed book and scope revisions', async () => {
  const onCreated = vi.fn();
  const target = { bookId: '7', sceneId: '80', bookTitle: 'Owned book', outline: 'Brief\n\nkept.' };
  creation.create.mockResolvedValue(target);
  render(
    <DocumentFirstScene
      userId="author"
      bookId="7"
      bookTitle="Owned book"
      base={base}
      onCreated={onCreated}
      onReload={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('Scene title'), { target: { value: 'Opening chapter' } });
  fireEvent.change(screen.getByLabelText('Scene brief (optional)'), {
    target: { value: target.outline },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create scene and start writing' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(target));
  expect(creation.create).toHaveBeenCalledExactlyOnceWith({
    bookId: '7',
    bookTitle: 'Owned book',
    base,
    summary: 'Opening chapter',
    outline: target.outline,
  });
});
it('recovers the original scene target rather than guessing a target in the currently open book', async () => {
  creation.pending = { userId: 'author', operationId: 'original', retryAllowed: false };
  const target = { bookId: 'original-book', sceneId: '81', outline: '' };
  creation.recover.mockResolvedValue(target);
  const onCreated = vi.fn();
  render(
    <DocumentFirstScene
      userId="author"
      bookId="different-book"
      bookTitle="Other book"
      base={base}
      onCreated={onCreated}
      onReload={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Create scene and start writing' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Continue original scene creation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Recover original scene creation' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(target));
  expect(creation.create).not.toHaveBeenCalled();
});
it('keeps a failed scene creation visible without navigating or automatically replaying it', async () => {
  creation.create.mockRejectedValue(new Error('Scene source changed.'));
  const onCreated = vi.fn();
  render(
    <DocumentFirstScene
      userId="author"
      bookId="7"
      bookTitle="Owned book"
      base={base}
      onCreated={onCreated}
      onReload={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create scene and start writing' }));
  await screen.findByRole('alert');
  expect(onCreated).not.toHaveBeenCalled();
  expect(creation.create).toHaveBeenCalledOnce();
  expect(creation.retry).not.toHaveBeenCalled();
});
