'use client';

import * as React from 'react';
import { signOut, useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LocalDraft } from '@/lib/local-writing-data';

// Loaded on first use, so the draft scanner stays out of the shared page bundle.
const localWritingData = () => import('@/lib/local-writing-data');

const SIGN_IN = { callbackUrl: '/auth/signin' };

/**
 * Sign out, first checking this browser for drafts Proser has not saved. When
 * there are any, the writer can download them, remove them from the device or
 * keep them for the next sign-in.
 */
export function useSignOutWithLocalDrafts() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? '';
  const [drafts, setDrafts] = React.useState<LocalDraft[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const requestSignOut = React.useCallback(async () => {
    setError('');
    let found: LocalDraft[] = [];
    if (userId) {
      try {
        found = await (await localWritingData()).listLocalDrafts(userId);
      } catch {
        /* Without readable local storage there is nothing to protect. */
      }
    }
    if (found.length === 0) {
      await signOut(SIGN_IN);
      return;
    }
    setDrafts(found);
  }, [userId]);

  const removeAndSignOut = React.useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await (await localWritingData()).clearLocalWritingData();
      await signOut(SIGN_IN);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The local drafts could not be removed.',
      );
      setBusy(false);
    }
  }, []);

  const dialog = (
    <Dialog
      open={drafts !== null}
      onOpenChange={(open) => (!open && !busy ? setDrafts(null) : null)}
    >
      <DialogContent aria-describedby="sign-out-local-drafts">
        <DialogHeader>
          <DialogTitle>Drafts are still in this browser</DialogTitle>
          <DialogDescription id="sign-out-local-drafts">
            {drafts?.length === 1
              ? '1 scene has changes that Proser has not saved yet.'
              : `${drafts?.length ?? 0} scenes have changes that Proser has not saved yet.`}{' '}
            They stay in this browser after you sign out. On a shared device, download them and
            remove them.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 overflow-auto text-[length:--text-sm] text-text-secondary">
          {drafts?.map((draft) => (
            <li key={draft.key}>
              Book {draft.bookId}, scene {draft.sceneId}
              {draft.unsent ? ' (save not confirmed)' : ''} —{' '}
              {new Date(draft.updatedAt).toLocaleString()}
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="text-[length:--text-sm] text-red-300">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (drafts) void localWritingData().then((data) => data.downloadLocalDrafts(drafts));
            }}
          >
            Download drafts
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void signOut(SIGN_IN)}>
            Keep them and sign out
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void removeAndSignOut()}>
            Remove them and sign out
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { requestSignOut, dialog };
}
