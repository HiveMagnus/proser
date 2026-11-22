'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDocumentQuickDraft, type QuickDraftTarget } from '@/hooks/use-document-quick-draft';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { DocumentNavigationGuard } from './document-navigation-guard';

/** Ordinary owned scene creation, using the same durable operation as Mobile
 * Quick Draft. An inline form remains usable with a hardware or phone keyboard. */
export function DocumentFirstScene({
  userId,
  bookId,
  bookTitle,
  base,
  onCreated,
  onReload,
}: {
  userId: string;
  bookId: string;
  bookTitle: string | null;
  base: { bookRevisionId: string; structureRevisionId: string };
  onCreated: (target: QuickDraftTarget) => void;
  onReload: () => void;
}) {
  const creation = useDocumentQuickDraft(userId);
  const [title, setTitle] = useState('Opening scene');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState<QuickDraftTarget>();
  const notified = useRef<QuickDraftTarget | undefined>(undefined);
  const dirty = !target && (busy || !!creation.pending || title !== 'Opening scene' || !!brief);
  useEffect(() => {
    if (target && notified.current !== target) {
      notified.current = target;
      onCreated(target);
    }
  }, [target, onCreated]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const perform = async (action: () => Promise<QuickDraftTarget | undefined>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      if (result) setTarget(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to create the scene.');
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || creation.pending) return;
    void perform(() =>
      creation.create({
        bookId,
        bookTitle,
        base,
        summary: title.trim(),
        outline: brief,
      }),
    );
  };
  return (
    <section
      aria-label="Create first scene"
      className="mx-auto max-w-xl space-y-4 rounded-lg border border-border-muted bg-surface-raised p-5"
    >
      <DocumentNavigationGuard dirty={dirty} />
      <div className="space-y-1">
        <h2 className="font-[--font-display] text-xl font-semibold">Start your manuscript</h2>
        <p className="text-sm text-text-secondary">Name your opening scene, then begin writing.</p>
      </div>
      {creation.pending && (
        <aside
          aria-label="Scene creation recovery"
          className="space-y-2 rounded border border-border-muted p-3"
        >
          <p>
            A scene creation is pending for this author. Recover its original result before starting
            another.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void perform(creation.recover)}>
              Recover original scene creation
            </Button>
            {creation.pending.retryAllowed && (
              <Button type="button" disabled={busy} onClick={() => void perform(creation.retry)}>
                Continue original scene creation
              </Button>
            )}
            {creation.pending.rejected && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await creation.discardRejected();
                    onReload();
                    return undefined;
                  })
                }
              >
                Discard rejected scene creation
              </Button>
            )}
          </div>
        </aside>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="first-scene-title" className="text-sm font-medium">
            Scene title
          </label>
          <Input
            id="first-scene-title"
            autoFocus
            required
            className="text-[16px]"
            value={title}
            disabled={busy || !!creation.pending}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="first-scene-brief" className="text-sm font-medium">
            Scene brief (optional)
          </label>
          <Textarea
            id="first-scene-brief"
            rows={3}
            className="text-[16px]"
            value={brief}
            disabled={busy || !!creation.pending}
            onChange={(event) => setBrief(event.target.value)}
          />
        </div>
        {(error || creation.journalError) && <p role="alert">{error || creation.journalError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !!creation.pending || !title.trim()}>
            {busy ? 'Creating scene…' : 'Create scene and start writing'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !!creation.pending}
            onClick={onReload}
          >
            Reload saved navigation
          </Button>
        </div>
      </form>
    </section>
  );
}
