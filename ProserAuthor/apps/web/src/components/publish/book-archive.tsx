'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  bookArchiveUrl,
  importBookArchive,
  type BookArchiveImportReceipt,
} from '@/lib/publication-api';

/** Download the whole book as one portable archive, or import an archive from
 * another Proser installation as a new book. Import never changes this book. */
export function BookArchive({
  bookId,
  disabled,
  signal,
  onImported,
}: {
  bookId: string | null;
  disabled: boolean;
  signal: AbortSignal;
  onImported?: (bookId: string, title: string | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<BookArchiveImportReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = (next: File) => {
    setFile(next);
    setOperation(crypto.randomUUID());
    setReceipt(null);
    setError(null);
  };
  const run = async () => {
    if (!file || !operation) return;
    setBusy(true);
    setError(null);
    try {
      setReceipt(await importBookArchive(file, operation, signal));
    } catch (failure) {
      if (!signal.aborted)
        setError(failure instanceof Error ? failure.message : 'The book archive import failed.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const losses = receipt?.losses;
  return (
    <section
      className="space-y-4 rounded-lg border border-border-default p-5"
      aria-labelledby="book-archive-heading"
    >
      <h2 id="book-archive-heading" className="text-xl font-semibold">
        Book archive
      </h2>
      <p className="text-sm text-text-secondary">
        A book archive holds the whole book: every scene with its formatting, open comments and
        pending changes, the codex, notes, plot threads, goals, layout and images. Use it to move a
        book to another Proser installation or keep a complete copy. It holds the current version
        only, not earlier revisions.
      </p>
      {bookId && (
        <a className="text-accent-400 underline" href={bookArchiveUrl(bookId)} download>
          Download book archive
        </a>
      )}
      <label className="grid gap-2">
        Import a book archive as a new book
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={disabled || busy}
          onChange={(event) => {
            const next = event.target.files?.[0];
            if (next) start(next);
            event.target.value = '';
          }}
        />
      </label>
      {file && !receipt && (
        <div className="space-y-2">
          <p className="text-sm">
            {file.name} will become a new book. No existing book is changed.
          </p>
          <Button disabled={disabled || busy} onClick={() => void run()}>
            {busy ? 'Importing…' : error ? 'Retry import' : 'Import as new book'}
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded border border-red-500 p-4">
          {error}
        </div>
      )}
      {receipt && losses && (
        <div className="space-y-2" role="status">
          <p>
            Imported &ldquo;{receipt.title || 'Untitled book'}&rdquo;:{' '}
            {receipt.counts.wordCount.toLocaleString()} words in {receipt.counts.chapters} chapters
            and {receipt.counts.scenes} scenes, {receipt.counts.codex} codex entries,{' '}
            {receipt.counts.notes} notes and {receipt.counts.images} images.
          </p>
          {(losses.resolvedReviewFolded > 0 ||
            losses.commentsDropped > 0 ||
            losses.plainTextFallbacks > 0) && (
            <ul className="list-inside list-disc text-sm">
              {losses.resolvedReviewFolded > 0 && (
                <li>
                  Accepted and rejected changes were applied to the text in{' '}
                  {losses.resolvedReviewFolded} scenes or stories.
                </li>
              )}
              {losses.commentsDropped > 0 && (
                <li>{losses.commentsDropped} resolved or detached comments were not imported.</li>
              )}
              {losses.plainTextFallbacks > 0 && (
                <li>
                  {losses.plainTextFallbacks} scenes or stories were imported as plain text because
                  their formatting could not be checked.
                </li>
              )}
            </ul>
          )}
          {onImported && (
            <Button onClick={() => onImported(String(receipt.bookId), receipt.title)}>
              Open the new book
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
