'use client';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import type {
  DocumentPublicationCapabilities,
  DocumentPublicationJob,
  DocumentPublicationFormat,
  DocumentPublicationMode,
  DocumentPublicationPreset,
  DocumentDocxImportPreview,
} from '@hivemagnus/proser-contracts';
import { useWorkspace } from '@/contexts/workspace-context';
import { Button } from '@/components/ui/button';
import { TextManuscriptImport } from '@/components/publish/text-manuscript-import';
import { getDocumentManifest } from '@/lib/document-api';
import {
  getPublicationCapabilities,
  createPublication,
  getPublication,
  listPublications,
  resumePublication,
  cancelPublication,
  previewDocx,
  commitDocx,
} from '@/lib/publication-api';

export default function PublishPage() {
  const { activeBookId } = useWorkspace();
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return (
    <PublicationWorkspace
      key={`${userId}:${activeBookId}`}
      bookId={activeBookId ? String(activeBookId) : null}
      authenticated={!!userId}
    />
  );
}
function PublicationWorkspace({
  bookId,
  authenticated,
}: {
  bookId: string | null;
  authenticated: boolean;
}) {
  const [capabilities, setCapabilities] = useState<DocumentPublicationCapabilities | null>(null);
  const [format, setFormat] = useState<DocumentPublicationFormat>('docx');
  const [mode, setMode] = useState<DocumentPublicationMode>('final');
  const [preset, setPreset] = useState<DocumentPublicationPreset>('saved');
  const [jobs, setJobs] = useState<DocumentPublicationJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentDocxImportPreview | null>(null);
  const [scopes, setScopes] = useState<{ structure: string; canon: string; layout: string } | null>(
    null,
  );
  const [consent, setConsent] = useState(false);
  const [importOperation, setImportOperation] = useState<string | null>(null);
  const [importComplete, setImportComplete] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [controller] = useState(() => new AbortController());
  const remember = (job: DocumentPublicationJob) =>
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
  useEffect(() => {
    if (!bookId || !authenticated) return;
    void Promise.all([
      getPublicationCapabilities(bookId, controller.signal),
      listPublications(bookId, controller.signal),
    ])
      .then(([capabilities, page]) => {
        if (!controller.signal.aborted) {
          setCapabilities(capabilities);
          setJobs(page.jobs);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Publication is unavailable.');
      });
    return () => controller.abort();
  }, [bookId, authenticated, controller]);
  useEffect(() => {
    if (!bookId || !jobs.some((job) => ['pending', 'running'].includes(job.status))) return;
    const timer = setInterval(() => {
      void Promise.all(
        jobs
          .filter((job) => ['pending', 'running'].includes(job.status))
          .map((job) => getPublication(bookId, job.id, controller.signal)),
      )
        .then((updated) => {
          if (!controller.signal.aborted) for (const job of updated) remember(job);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setError(
              error instanceof Error ? error.message : 'Unable to recover publication status.',
            );
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [bookId, jobs, controller]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Publication action failed.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function publish() {
    if (!bookId) return;
    await action(async () => {
      const head = await getDocumentManifest(bookId, controller.signal);
      const operationId = crypto.randomUUID();
      try {
        remember(
          await createPublication(
            bookId,
            { operationId, expectedRevisionId: head.revisionId, options: { format, mode, preset } },
            controller.signal,
          ),
        );
      } catch (error) {
        setError(
          `Publication request ${operationId} was interrupted. Recover this exact job before retrying.`,
        );
        try {
          remember(await getPublication(bookId, operationId, controller.signal));
        } catch {
          throw error;
        }
      }
    });
  }
  async function upload(file: File) {
    if (!bookId) return;
    await action(async () => {
      const head = await getDocumentManifest(bookId, controller.signal);
      if (!head.scopes) throw new Error('Complete document scopes are required for import.');
      const value = await previewDocx(bookId, file, head.revisionId, controller.signal);
      setPreview(value);
      setScopes({
        structure: head.scopes.structure.revisionId,
        canon: head.scopes.canon.revisionId,
        layout: head.scopes.layout.revisionId,
      });
      setConsent(false);
      setImportOperation(crypto.randomUUID());
      setImportComplete(false);
    });
  }
  if (!authenticated) return <p>Sign in to access publication artifacts.</p>;
  if (!bookId) return <p>Select a book to prepare an export or import a manuscript.</p>;
  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-12">
      <header>
        <h1 className="text-3xl font-semibold text-text-primary">Publish Center</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Export an exact saved revision. Final-text exports preserve the manuscript’s review state.
        </p>
      </header>
      {error && (
        <div role="alert" className="rounded border border-red-500 p-4">
          {error}
        </div>
      )}
      <section
        className="space-y-4 rounded-lg border border-border-default bg-surface-raised p-5"
        aria-labelledby="publication-heading"
      >
        <h2 id="publication-heading" className="text-xl font-semibold">
          Create an export
        </h2>
        {!capabilities ? (
          <p>Checking Factory publication capabilities…</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="grid gap-2">
                Format
                <select
                  aria-label="Export format"
                  className="rounded border bg-surface-sunken p-2"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as DocumentPublicationFormat)}
                >
                  {capabilities.formats.map((item) => (
                    <option key={item.format} value={item.format} disabled={!item.available}>
                      {item.format.toUpperCase()}
                      {!item.available ? ' — unavailable' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2">
                Review view
                <select
                  aria-label="Review view"
                  className="rounded border bg-surface-sunken p-2"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as DocumentPublicationMode)}
                >
                  {capabilities.modes.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === 'retain-review'
                        ? 'Retain review markup'
                        : mode === 'original'
                          ? 'Original text'
                          : 'Final text'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2">
                Layout
                <select
                  aria-label="Publication preset"
                  className="rounded border bg-surface-sunken p-2"
                  value={preset}
                  onChange={(event) => setPreset(event.target.value as DocumentPublicationPreset)}
                >
                  {capabilities.presets.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset === 'saved'
                        ? 'Saved layout'
                        : preset === 'print-book'
                          ? 'Print book'
                          : 'Submission manuscript'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-sm text-text-muted">
              {capabilities.formats.find((item) => item.format === format)?.reason ??
                `${format.toUpperCase()} review representation: ${capabilities.formats.find((item) => item.format === format)?.review}. Fidelity and source evidence are stored with every artifact.`}
            </p>
            <Button
              disabled={
                busy || !capabilities.formats.find((item) => item.format === format)?.available
              }
              onClick={() => void publish()}
            >
              {busy ? 'Working…' : 'Create export'}
            </Button>
          </>
        )}
      </section>
      <section className="space-y-4" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-xl font-semibold">
          Publication history
        </h2>
        {jobs.length === 0 ? (
          <p className="text-text-secondary">No retained publication jobs for this book.</p>
        ) : (
          jobs.map((job) => (
            <article key={job.id} className="space-y-2 rounded-lg border border-border-default p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <strong>
                  {job.options.format.toUpperCase()} · {job.options.mode}
                </strong>
                <span role="status">{job.status}</span>
              </div>
              <p className="break-all text-xs text-text-muted">
                Job {job.id} · Source revision {job.sourceRevisionId}
              </p>
              {job.errorMessage && <p role="alert">{job.errorMessage}</p>}
              {job.fidelity &&
                (job.fidelity.losses.length > 0 || job.fidelity.fontSubstitutions.length > 0) && (
                  <div className="space-y-2 text-sm" aria-label="Artifact fidelity report">
                    <strong>Artifact fidelity</strong>
                    <ul className="list-inside list-disc">
                      {job.fidelity.losses.map((loss, index) => (
                        <li key={`loss-${index}`}>{loss}</li>
                      ))}
                      {job.fidelity.fontSubstitutions.map(({ requested, actual }) => (
                        <li key={requested}>
                          Font {requested} rendered as {actual}.
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              <div className="flex flex-wrap gap-3">
                {job.downloadPath && (
                  <a className="text-accent-400 underline" href={job.downloadPath} download>
                    Download artifact
                  </a>
                )}
                {job.reviewSidecarPath && job.options.mode === 'retain-review' && (
                  <a className="text-accent-400 underline" href={job.reviewSidecarPath} download>
                    Download review sidecar
                  </a>
                )}
                {['failed', 'pending', 'running'].includes(job.status) && (
                  <Button
                    disabled={busy}
                    variant="secondary"
                    onClick={() =>
                      void action(async () => {
                        remember(await resumePublication(bookId, job.id, controller.signal));
                      })
                    }
                  >
                    Recover / resume job
                  </Button>
                )}
                {['pending', 'running'].includes(job.status) && (
                  <Button
                    disabled={busy}
                    variant="secondary"
                    onClick={() =>
                      void action(async () => {
                        remember(await cancelPublication(bookId, job.id, controller.signal));
                      })
                    }
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </article>
          ))
        )}
        {nextCursor && (
          <Button
            disabled={busy}
            variant="secondary"
            onClick={() =>
              void action(async () => {
                const page = await listPublications(bookId, controller.signal, nextCursor);
                setJobs((current) => [
                  ...current,
                  ...page.jobs.filter((job) => !current.some((item) => item.id === job.id)),
                ]);
                setNextCursor(page.nextCursor);
              })
            }
          >
            Older jobs
          </Button>
        )}
      </section>
      <section
        className="space-y-4 rounded-lg border border-border-default p-5"
        aria-labelledby="import-heading"
      >
        <h2 id="import-heading" className="text-xl font-semibold">
          Import a DOCX manuscript
        </h2>
        <p className="text-sm text-text-secondary">
          Factory preserves the exact original before conversion. Review chapter mapping and
          identified losses before appending new chapters.
        </p>
        <label className="grid gap-2">
          Choose DOCX file
          <input
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={busy || !capabilities}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
        </label>
        {preview && (
          <div className="space-y-3">
            <p>
              {preview.report.wordCount.toLocaleString()} words · {preview.mapping.length} proposed
              chapters
            </p>
            <ol className="list-inside list-decimal">
              {preview.mapping.map((item) => (
                <li key={item.chapterIndex}>{item.title}</li>
              ))}
            </ol>
            <p className="break-all text-xs">Preserved original {preview.originalId}</p>
            <a
              className="text-accent-400 underline"
              href={`/api/books/${bookId}/import-originals/${preview.originalId}/content`}
              download
            >
              Download exact original
            </a>
            <h3 className="font-semibold">Conversion fidelity</h3>
            {preview.report.losses.length ? (
              <ul className="list-inside list-disc">
                {preview.report.losses.map((loss) => (
                  <li key={loss.code}>
                    {loss.message} ({loss.count})
                  </li>
                ))}
              </ul>
            ) : (
              <p>No unsupported features were detected by this conversion.</p>
            )}
            <p className="text-sm text-text-muted">Microsoft Word acceptance remains unverified.</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={consent}
                disabled={importComplete}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                I reviewed this chapter mapping and consent to the listed conversion losses.
                Preserve the original and append these chapters.
              </span>
            </label>
            <Button
              disabled={!consent || busy || !scopes || !importOperation || importComplete}
              onClick={() =>
                void action(async () => {
                  await commitDocx(bookId, preview, scopes!, importOperation!, controller.signal);
                  setImportComplete(true);
                })
              }
            >
              {importComplete ? 'Import committed' : 'Commit reviewed import'}
            </Button>
            {importOperation && (
              <p className="break-all text-xs text-text-muted">
                Import operation {importOperation}. An interrupted commit must retry this exact
                operation.
              </p>
            )}
          </div>
        )}
      </section>
      <TextManuscriptImport
        bookId={bookId}
        disabled={busy || !capabilities}
        signal={controller.signal}
      />
    </div>
  );
}
