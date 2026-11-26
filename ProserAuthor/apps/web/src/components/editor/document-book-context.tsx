'use client';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import type { CanonSnapshot, ScopeReference } from '@hivemagnus/proser-contracts';
import { getDocumentScope } from '@/lib/document-api';
import { Button } from '@/components/ui/button';

/** Read-only saved context shares the manuscript's immutable canon reference. */
export function DocumentBookContext({
  bookId,
  reference,
}: {
  bookId: string;
  reference: ScopeReference;
}) {
  const { data: session } = useSession();
  const scope = `${session?.user?.id ?? ''}:${bookId}:${reference.revisionId}:${reference.contentHash}`;
  const [saved, setSaved] = useState<{ scope: string; canon: CanonSnapshot }>();
  const [error, setError] = useState<{ scope: string; message: string }>();
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!session?.user?.id) return;
    const controller = new AbortController();
    setError(undefined);
    setPage(0);
    setSearch('');
    void getDocumentScope(bookId, 'canon', controller.signal)
      .then((row) => {
        if (row.revisionId !== reference.revisionId || row.contentHash !== reference.contentHash)
          throw new Error('Book context changed. Reload saved navigation before using it.');
        if (!controller.signal.aborted) setSaved({ scope, canon: row.content });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError({
            scope,
            message:
              failure instanceof Error ? failure.message : 'Unable to load saved book context.',
          });
      });
    return () => controller.abort();
  }, [bookId, reference.revisionId, reference.contentHash, scope, session?.user?.id, reload]);
  const current = saved?.scope === scope ? saved : undefined;
  const entries =
    current?.canon.entries.filter(
      (entry) =>
        !entry.deletedAt &&
        `${entry.entryName}\n${entry.entryDescription ?? ''}\n${entry.attributes ?? ''}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    ) ?? [];
  const visible = entries.slice(page * 25, (page + 1) * 25);
  return (
    <details
      aria-label="Saved book context"
      className="rounded border border-border-muted bg-surface-raised/60 p-4"
    >
      <summary className="cursor-pointer text-lg font-semibold">Book context</summary>
      <div className="mt-3 space-y-3">
        {error?.scope === scope ? (
          <div role="alert">
            <p>{error.message}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setReload((value) => value + 1)}
            >
              Retry book context
            </Button>
          </div>
        ) : !current ? (
          <p role="status">Loading saved codex…</p>
        ) : (
          <>
            <label className="block text-sm">
              Search saved codex
              <input
                aria-label="Search saved codex"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
                className="mt-1 block min-h-11 w-full rounded border border-border-muted bg-surface-base px-3"
              />
            </label>
            <p className="text-sm text-text-secondary">
              {entries.length} saved entries. This panel is read-only.
            </p>
            {visible.map((entry) => (
              <details key={entry.id} className="border-b border-border-muted py-2">
                <summary className="cursor-pointer">
                  {entry.entryName}{' '}
                  <span className="text-xs text-text-secondary">{entry.entryType}</span>
                </summary>
                <p className="whitespace-pre-wrap py-2">{entry.entryDescription}</p>
                {entry.attributes && (
                  <p className="whitespace-pre-wrap break-words text-sm">{entry.attributes}</p>
                )}
              </details>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={!page}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous entries
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={(page + 1) * 25 >= entries.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next entries
              </Button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
