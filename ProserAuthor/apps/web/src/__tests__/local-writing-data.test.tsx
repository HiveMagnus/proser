import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { documentFromText } from '@hivemagnus/proser-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeIndexedDB } from './fake-indexeddb';

const signOutMock = vi.hoisted(() => vi.fn());
vi.mock('next-auth/react', () => ({
  signOut: signOutMock,
  useSession: () => ({ data: { user: { id: 'writer-1' } } }),
}));

import { useSignOutWithLocalDrafts } from '@/components/layout/sign-out-dialog';
import {
  documentDraftKey,
  documentDraftStore,
  readDocumentDraft,
  writeDocumentDraft,
  type DocumentDraft,
} from '@/lib/document-drafts';
import { listLocalDrafts, localDraftsExport, localDraftsFromRows } from '@/lib/local-writing-data';

let sequence = 0;
const text = (value: string) => documentFromText(value, () => `fixture-${++sequence}`);
const draft = (overrides: Partial<DocumentDraft> = {}): DocumentDraft => ({
  key: documentDraftKey('writer-1', '7', '3'),
  userId: 'writer-1',
  bookId: '7',
  sceneId: '3',
  baseRevisionId: 'scene-1',
  baseBookRevisionId: 'book-1',
  document: text('The lighthouse keeper counted the ships.'),
  updatedAt: Date.now(),
  ...overrides,
});
const DAY = 24 * 60 * 60 * 1000;

function SignOutProbe() {
  const { requestSignOut, dialog } = useSignOutWithLocalDrafts();
  return (
    <>
      <button onClick={() => void requestSignOut()}>Sign out</button>
      {dialog}
    </>
  );
}

describe('local drafts', () => {
  beforeEach(() => {
    installFakeIndexedDB();
    signOutMock.mockReset();
  });

  it('lists only this writer’s scene and passage drafts, newest first, with their text', () => {
    const rows = [
      draft({ updatedAt: 10 }),
      draft({ key: documentDraftKey('writer-2', '7', '3'), userId: 'writer-2' }),
      {
        key: JSON.stringify(['passage-v1', 'writer-1', '8', '4']),
        userId: 'writer-1',
        bookId: '8',
        sceneId: '4',
        updatedAt: 20,
        drafts: [{ blockId: 'b', runId: 'r', text: 'A passage edit.' }],
        pending: { kind: 'commit' },
      },
      { key: JSON.stringify(['comment-v1', 'writer-1', '7']), userId: 'writer-1' },
      { key: 'not json' },
    ];
    const drafts = localDraftsFromRows(rows, 'writer-1');
    expect(drafts.map((item) => [item.kind, item.bookId, item.unsent, item.text])).toEqual([
      ['passage', '8', true, 'A passage edit.'],
      ['scene', '7', false, 'The lighthouse keeper counted the ships.'],
    ]);
    const exported = localDraftsExport(drafts, new Date('2026-11-26T00:00:00Z'));
    expect(exported).toContain('## Book 8, scene 4');
    expect(exported).toContain('(save not confirmed by Proser)');
    expect(exported).toContain('The lighthouse keeper counted the ships.');
  });

  it('keeps an old draft whose save Factory never confirmed, and drops other old drafts', async () => {
    const pendingSave = { operationId: 'op-1' } as unknown as DocumentDraft['pendingSave'];
    await writeDocumentDraft(draft({ updatedAt: Date.now() - 31 * DAY, pendingSave }));
    expect((await readDocumentDraft('writer-1', '7', '3'))?.pendingSave).toEqual(pendingSave);

    await writeDocumentDraft(
      draft({
        sceneId: '4',
        key: documentDraftKey('writer-1', '7', '4'),
        updatedAt: Date.now() - 31 * DAY,
      }),
    );
    expect(await readDocumentDraft('writer-1', '7', '4')).toBeUndefined();
    expect(
      await documentDraftStore('readonly', (table) =>
        table.get(documentDraftKey('writer-1', '7', '4')),
      ),
    ).toBeUndefined();
  });

  it('signs straight out when nothing is waiting in the browser', async () => {
    render(<SignOutProbe />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/auth/signin' }));
    expect(screen.queryByText(/Drafts are still in this browser/)).not.toBeInTheDocument();
  });

  it('warns about unsaved drafts and can remove them before signing out', async () => {
    await writeDocumentDraft(draft());
    const user = userEvent.setup();
    render(<SignOutProbe />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(/Drafts are still in this browser/)).toBeInTheDocument();
    expect(
      screen.getByText(/1 scene has changes that Proser has not saved yet/),
    ).toBeInTheDocument();
    expect(signOutMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove them and sign out' }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(await listLocalDrafts('writer-1')).toEqual([]);
  });

  it('can keep the drafts for the next sign-in', async () => {
    await writeDocumentDraft(draft());
    const user = userEvent.setup();
    render(<SignOutProbe />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(await screen.findByRole('button', { name: 'Keep them and sign out' }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(await listLocalDrafts('writer-1')).toHaveLength(1);
  });
});
