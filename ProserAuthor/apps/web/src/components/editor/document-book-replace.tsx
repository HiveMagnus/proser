'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  DocumentReplaceApplyReceipt,
  DocumentReplaceMatch,
  DocumentReplacePreviewResponse,
  DocumentReplaceSkipReason,
} from '@hivemagnus/proser-contracts';
import {
  applyDocumentReplace,
  previewDocumentReplace,
  undoDocumentReplace,
} from '@/lib/document-api';

const skipLabels: Record<DocumentReplaceSkipReason, string> = {
  formatting: 'crosses formatting',
  boundary: 'crosses a paragraph or object',
  'tracked-change': 'inside a tracked change',
  unsupported: 'cannot be replaced here',
};
const message = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

/** Find and replace across the saved manuscript. The writer previews every
 * match, unticks any to keep, and applies the rest as one saved revision. */
export function DocumentBookReplace({
  bookId,
  disabled,
  onCommitted,
}: {
  bookId: string;
  disabled?: boolean;
  onCommitted: () => void;
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [preview, setPreview] = useState<DocumentReplacePreviewResponse>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [receipt, setReceipt] = useState<DocumentReplaceApplyReceipt>();
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // One operation ID per preview, so retrying a lost acknowledgement returns
  // the original receipt instead of replacing twice.
  const operation = useRef<string | undefined>(undefined);
  const undoOperation = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), [bookId]);
  const reset = () => {
    abort.current?.abort();
    setPreview(undefined);
    setSelected(new Set());
    setError(undefined);
    setBusy(false);
  };
  const runPreview = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(undefined);
    setReceipt(undefined);
    setUndone(false);
    try {
      const next = await previewDocumentReplace(
        bookId,
        { q: query, replacement, caseSensitive: sensitive },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      operation.current = crypto.randomUUID();
      setPreview(next);
      setSelected(new Set(next.matches.filter((match) => match.replaceable).map((m) => m.id)));
    } catch (reason) {
      if (!controller.signal.aborted) setError(message(reason, 'Unable to preview replacements.'));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || !operation.current) return;
    const matches = preview.matches.filter((match) => selected.has(match.id));
    if (!matches.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await applyDocumentReplace(bookId, {
        schemaVersion: 1,
        operationId: operation.current,
        expectedRevisionId: preview.sourceBookRevisionId,
        q: preview.query,
        replacement: preview.replacement,
        caseSensitive: preview.caseSensitive,
        matches: matches.map(({ sceneId, sceneRevisionId, from, to }) => ({
          sceneId,
          sceneRevisionId,
          from,
          to,
        })),
      });
      setReceipt(next);
      setPreview(undefined);
      setSelected(new Set());
      undoOperation.current = crypto.randomUUID();
      onCommitted();
    } catch (reason) {
      setError(message(reason, 'Unable to replace. Preview again and retry.'));
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!receipt || !undoOperation.current) return;
    setBusy(true);
    setError(undefined);
    try {
      await undoDocumentReplace(bookId, receipt, undoOperation.current);
      setUndone(true);
      onCommitted();
    } catch (reason) {
      setError(
        message(
          reason,
          'Unable to undo. The manuscript may have changed since the replace; restore an earlier revision instead.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const toggle = (match: DocumentReplaceMatch, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(match.id);
      else next.delete(match.id);
      return next;
    });
  const replaceable = preview?.matches.filter((match) => match.replaceable) ?? [];
  return (
    <section aria-label="Find and replace in saved manuscript" className="proser-book-search">
      <form
        className="proser-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runPreview();
        }}
      >
        <label className="proser-search-query">
          <span>Find in whole book</span>
          <input
            type="search"
            value={query}
            maxLength={500}
            onChange={(event) => {
              setQuery(event.target.value);
              reset();
            }}
          />
        </label>
        <label className="proser-search-query">
          <span>Replace with</span>
          <input
            type="text"
            value={replacement}
            maxLength={4096}
            onChange={(event) => {
              setReplacement(event.target.value);
              reset();
            }}
          />
        </label>
        <label className="proser-search-case">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(event) => {
              setSensitive(event.target.checked);
              reset();
            }}
          />
          Match case
        </label>
        <button className="proser-search-submit" type="submit" disabled={!query || busy}>
          Preview replacements
        </button>
      </form>
      {disabled && <p role="status">Save your changes before replacing across the book.</p>}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Working on the saved manuscript…</p>}
      {receipt && (
        <div role="status">
          <p>
            {undone
              ? 'Replace undone. The manuscript is back to the revision before it.'
              : `Replaced ${receipt.replacedCount} ${receipt.replacedCount === 1 ? 'match' : 'matches'} in ${receipt.scenes.length} ${receipt.scenes.length === 1 ? 'scene' : 'scenes'} as one saved revision.`}
          </p>
          {!undone && (
            <button type="button" disabled={busy || disabled} onClick={() => void undo()}>
              Undo replace
            </button>
          )}
        </div>
      )}
      {preview && (
        <>
          <p>
            {preview.matches.length
              ? `${preview.matches.length} ${preview.matches.length === 1 ? 'match' : 'matches'} in ${preview.sceneCount} ${preview.sceneCount === 1 ? 'scene' : 'scenes'}. ${selected.size} selected.`
              : 'No matches.'}
          </p>
          {preview.truncated && (
            <p role="status">
              Showing the first matches only. Replace these, then preview again for the rest.
            </p>
          )}
          {replaceable.length > 1 && (
            <p>
              <button
                type="button"
                onClick={() => setSelected(new Set(replaceable.map((match) => match.id)))}
              >
                Select all
              </button>{' '}
              <button type="button" onClick={() => setSelected(new Set())}>
                Select none
              </button>
            </p>
          )}
          <ol className="proser-replace-matches">
            {preview.matches.map((match) => (
              <li key={match.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(match.id)}
                    disabled={!match.replaceable}
                    onChange={(event) => toggle(match, event.target.checked)}
                  />
                  <span>
                    Scene {match.sceneNumber}:{' '}
                    {match.excerpt.slice(0, match.from - match.excerptFrom)}
                    <del>{match.sourceText}</del>
                    <ins>{preview.replacement}</ins>
                    {match.excerpt.slice(match.to - match.excerptFrom)}
                  </span>
                </label>
                {!match.replaceable && match.reason && (
                  <p>Skipped: this match {skipLabels[match.reason]}.</p>
                )}
              </li>
            ))}
          </ol>
          {preview.matches.length > 0 && (
            <button
              className="proser-search-submit"
              type="button"
              disabled={busy || disabled || !selected.size}
              onClick={() => void apply()}
            >
              Replace {selected.size} selected
            </button>
          )}
        </>
      )}
    </section>
  );
}
