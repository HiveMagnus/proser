'use client';
import { useState } from 'react';
import type { DocumentTextImportPreview } from '@hivemagnus/proser-contracts';
import { Button } from '@/components/ui/button';
import { getDocumentManifest } from '@/lib/document-api';
import { commitTextManuscript, previewTextManuscript } from '@/lib/publication-api';

/** Import a Markdown or plain-text manuscript. Factory keeps the exact file,
 * proposes a part/chapter/scene mapping and lists what the conversion changes;
 * nothing is appended until the writer consents to that exact report. */
export function TextManuscriptImport({
  bookId,
  disabled,
  signal,
}: {
  bookId: string;
  disabled: boolean;
  signal: AbortSignal;
}) {
  const [preview, setPreview] = useState<DocumentTextImportPreview | null>(null);
  const [scopes, setScopes] = useState<{ structure: string; canon: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (!signal.aborted)
        setError(failure instanceof Error ? failure.message : 'The manuscript import failed.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  const upload = (file: File) =>
    action(async () => {
      const head = await getDocumentManifest(bookId, signal);
      if (!head.scopes) throw new Error('Complete document scopes are required for import.');
      const value = await previewTextManuscript(bookId, file, head.revisionId, signal);
      setPreview(value);
      setScopes({
        structure: head.scopes.structure.revisionId,
        canon: head.scopes.canon.revisionId,
      });
      setConsent(false);
      setOperation(crypto.randomUUID());
      setComplete(false);
    });
  return (
    <section
      className="space-y-4 rounded-lg border border-border-default p-5"
      aria-labelledby="text-import-heading"
    >
      <h2 id="text-import-heading" className="text-xl font-semibold">
        Import a Markdown or text manuscript
      </h2>
      <p className="text-sm text-text-secondary">
        Chapter headings (such as &ldquo;## Chapter 1&rdquo; or a &ldquo;Chapter One&rdquo; line)
        start chapters, and scene-break lines such as *** start scenes. Factory keeps the exact
        file. Review the mapping before appending these chapters to the book.
      </p>
      <label className="grid gap-2">
        Choose .md or .txt file
        <input
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = '';
          }}
        />
      </label>
      {error && (
        <div role="alert" className="rounded border border-red-500 p-4">
          {error}
        </div>
      )}
      {preview && (
        <div className="space-y-3">
          <p>
            {preview.report.wordCount.toLocaleString()} words · {preview.report.chapterCount}{' '}
            chapters · {preview.report.sceneCount} scenes
            {preview.report.actCount > 1 ? ` in ${preview.report.actCount} parts` : ''}
          </p>
          <ol className="list-inside list-decimal space-y-1" aria-label="Proposed chapters">
            {preview.mapping.acts.map((act, actIndex) =>
              act.chapters.map((chapter, chapterIndex) => (
                <li key={`${actIndex}:${chapterIndex}`}>
                  {preview.mapping.acts.length > 1 && act.title ? `${act.title} — ` : ''}
                  {chapter.title || 'Untitled chapter'}
                  {chapter.scenes.length > 1 ? ` (${chapter.scenes.length} scenes)` : ''}
                </li>
              )),
            )}
          </ol>
          <p className="break-all text-xs">Preserved original {preview.originalId}</p>
          <a
            className="text-accent-400 underline"
            href={`/api/books/${bookId}/import-originals/${preview.originalId}/content`}
            download
          >
            Download exact original
          </a>
          <h3 className="font-semibold">Conversion changes</h3>
          <ul className="list-inside list-disc">
            {preview.report.losses.map((loss) => (
              <li key={loss.code}>
                {loss.message}
                {loss.count ? ` (${loss.count})` : ''}
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={consent}
              disabled={complete}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I reviewed this chapter mapping and consent to the listed conversion changes. Keep the
              original and append these chapters.
            </span>
          </label>
          <Button
            disabled={!consent || busy || !scopes || !operation || complete}
            onClick={() =>
              void action(async () => {
                await commitTextManuscript(bookId, preview, scopes!, operation!, signal);
                setComplete(true);
              })
            }
          >
            {complete ? 'Import committed' : 'Commit reviewed import'}
          </Button>
          {operation && (
            <p className="break-all text-xs text-text-muted">
              Import operation {operation}. An interrupted commit must retry this exact operation.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
