'use client';
import { useEffect, useRef, useState } from 'react';
import type { DocumentSearchHit, DocumentSearchResponse } from '@cheftaco/proser-contracts';
import {
  searchDocumentBook,
  recoverDocumentSearchIndex,
  DocumentRequestError,
} from '@/lib/document-api';
export function DocumentBookSearch({
  bookId,
  disabled,
  onOpen,
}: {
  bookId: string;
  disabled?: boolean;
  onOpen: (hit: DocumentSearchHit) => void;
}) {
  const [query, setQuery] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [result, setResult] = useState<DocumentSearchResponse>();
  const [indexMissing, setIndexMissing] = useState(false);
  const [recovery, setRecovery] =
    useState<import('@cheftaco/proser-contracts').DocumentSearchIndexRecoveryResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      abort.current?.abort();
    },
    [bookId],
  );
  const search = async (cursor?: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const token = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await searchDocumentBook(
        bookId,
        { q: query, caseSensitive: sensitive, limit: 20, ...(cursor ? { cursor } : {}) },
        controller.signal,
      );
      if (!controller.signal.aborted && token === generation.current) {
        setResult(next);
        setIndexMissing(false);
      }
    } catch (reason) {
      if (!controller.signal.aborted && token === generation.current) {
        setIndexMissing(
          reason instanceof DocumentRequestError &&
            reason.code === 'DOCUMENT_SEARCH_INDEX_INCOMPLETE',
        );
        setError(reason instanceof Error ? reason.message : 'Book search failed.');
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };
  const repairIndex = async () => {
    const token = ++generation.current;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const next = await recoverDocumentSearchIndex(
        bookId,
        { limit: 8, ...(recovery?.nextAfter ? { after: recovery.nextAfter } : {}) },
        controller.signal,
      );
      if (!controller.signal.aborted && token === generation.current) {
        setRecovery(next);
        if (next.complete) setIndexMissing(false);
      }
    } catch (reason) {
      if (!controller.signal.aborted && token === generation.current)
        setError(reason instanceof Error ? reason.message : 'Search recovery failed.');
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Search saved manuscript" className="proser-book-search">
      <form
        className="proser-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="proser-search-query">
          <span>Search whole book</span>
          <input
            type="search"
            placeholder="Find a word or phrase…"
            value={query}
            maxLength={500}
            onChange={(event) => {
              setQuery(event.target.value);
              setResult(undefined);
              abort.current?.abort();
              generation.current++;
              setBusy(false);
            }}
          />
        </label>
        <label className="proser-search-case">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(event) => {
              setSensitive(event.target.checked);
              setResult(undefined);
              abort.current?.abort();
              generation.current++;
              setBusy(false);
            }}
          />
          Match case
        </label>
        <button className="proser-search-submit" type="submit" disabled={!query || busy}>
          Search saved text
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {(indexMissing || recovery?.nextAfter) && (
        <button type="button" disabled={busy} onClick={() => void repairIndex()}>
          {recovery?.nextAfter ? 'Continue search recovery' : 'Recover saved search index'}
        </button>
      )}
      {recovery && (
        <p role="status">
          {recovery.complete
            ? 'Search is ready. Search saved text again.'
            : `Verified ${recovery.verified} saved scene indexes. Continue recovery to finish.`}
        </p>
      )}
      {busy && <p role="status">Searching saved scenes…</p>}
      {result && (
        <>
          <p>Saved revision: {result.sourceBookRevisionId}</p>
          {result.stale && (
            <p role="status">
              The manuscript changed after this search. Refresh before selecting a result.
            </p>
          )}
          {result.hits.map((hit) => (
            <article key={hit.id}>
              <p>{hit.excerpt}</p>
              <button type="button" disabled={disabled || result.stale} onClick={() => onOpen(hit)}>
                Open scene {hit.sceneId} match
              </button>
            </article>
          ))}
          {!result.hits.length && (
            <p>
              {result.complete
                ? 'No matches.'
                : 'No matches in this portion of the saved manuscript.'}
            </p>
          )}
          {result.nextCursor && (
            <button type="button" disabled={busy} onClick={() => void search(result.nextCursor)}>
              Next search results
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void search()}>
            Refresh search
          </button>
        </>
      )}
    </section>
  );
}
