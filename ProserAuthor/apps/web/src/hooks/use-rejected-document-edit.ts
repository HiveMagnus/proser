'use client';
import { useEffect, useRef, useState } from 'react';
import {
  deleteRejectedDocumentEdit,
  readRejectedDocumentEdit,
  writeRejectedDocumentEdit,
  type RejectedDocumentEdit,
} from '@/lib/document-rejected-edits';
import type { ProserDocument } from '@hivemagnus/proser-contracts';
export function useRejectedDocumentEdit(
  userId: string | undefined,
  bookId: string,
  kind: 'scene' | 'layout-story',
  id: string,
  base?: { revisionId: string; contentHash: string; document: ProserDocument },
) {
  const scopeKey = JSON.stringify([userId, bookId, kind, id]);
  const [loadedScope, setLoadedScope] = useState<string>();
  const epoch = useRef(0);
  const [retained, setRetained] = useState<RejectedDocumentEdit>();
  const [error, setError] = useState<string>();
  const [discardToken, setDiscardToken] = useState(0);
  const alive = useRef(false);
  const row = useRef<RejectedDocumentEdit | undefined>(undefined);
  const source = useRef(base);
  source.current = base;
  const writing = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const token = ++epoch.current;
    alive.current = true;
    row.current = undefined;
    setRetained(undefined);
    setError(undefined);
    setLoadedScope(undefined);
    if (userId)
      void readRejectedDocumentEdit(userId, bookId, { kind, id })
        .then((saved) => {
          if (alive.current && epoch.current === token && !row.current) {
            row.current = saved;
            setRetained(saved);
            setLoadedScope(scopeKey);
          }
        })
        .catch((reason) => {
          if (alive.current && epoch.current === token) {
            setLoadedScope(scopeKey);
            setError(
              reason instanceof Error ? reason.message : 'Unsupported draft could not load.',
            );
          }
        });
    return () => {
      alive.current = false;
      epoch.current = token + 1;
    };
  }, [userId, bookId, kind, id, scopeKey]);
  const reject = (nativeValue: unknown, message: string) => {
    setLoadedScope(scopeKey);
    const token = epoch.current;
    setError(message);
    const saved = source.current;
    if (!userId || !saved) {
      setError('This unsupported edit cannot be retained yet. Keep this page open.');
      return;
    }
    const next: RejectedDocumentEdit = {
      schemaVersion: 1,
      id: row.current?.id ?? crypto.randomUUID(),
      userId,
      bookId,
      scope: { kind, id },
      updatedAt: Date.now(),
      baseRevisionId: saved.revisionId,
      baseContentHash: saved.contentHash,
      editorVersion: '1.0.4-proser.3',
      canonicalBase: saved.document,
      nativeValue,
      error: message,
    };
    row.current = next;
    setRetained(next);
    writing.current = writing.current
      .catch(() => undefined)
      .then(() => writeRejectedDocumentEdit(next));
    void writing.current.catch((reason) => {
      if (alive.current && epoch.current === token)
        setError(
          reason instanceof Error
            ? reason.message
            : 'Unsupported edit recovery failed. Keep this page open.',
        );
    });
  };
  const discard = async () => {
    if (!userId) return;
    const token = epoch.current;
    await writing.current.catch(() => undefined);
    if (row.current) await deleteRejectedDocumentEdit(userId, bookId, { kind, id }, row.current.id);
    if (alive.current && epoch.current === token) {
      row.current = undefined;
      setRetained(undefined);
      setError(undefined);
      setDiscardToken((token) => token + 1);
    }
  };
  const download = () => {
    if (!retained) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(retained, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'unsupported-manuscript-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const visible = loadedScope === scopeKey;
  return {
    retained: visible ? retained : undefined,
    error: visible ? error : undefined,
    discardToken,
    reject,
    discard,
    download,
    ready: visible,
    pending: visible && Boolean(retained || error),
  };
}
