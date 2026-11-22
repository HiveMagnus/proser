'use client';
import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { deleteBook, updateBook } from '@/lib/api';
import { getDocumentBookCatalogScope, recoverDocumentBookCatalog } from '@/lib/document-api';
import { BookCatalogSession } from '@/lib/document-book-catalog-session';
import {
  readBookCatalogIntent,
  writeBookCatalogIntent,
  deleteBookCatalogIntent,
} from '@/lib/document-book-catalog-journal';
export type { BookCatalogSnapshot } from '@/lib/document-book-catalog-journal';

/** Immutable dialog-open sources and same-owner recovery for metadata/delete. */
export function useDocumentBookCatalog(userId: string | undefined) {
  const session = useMemo(
    () =>
      new BookCatalogSession(userId ?? '', {
        read: readBookCatalogIntent,
        write: writeBookCatalogIntent,
        remove: deleteBookCatalogIntent,
        scope: getDocumentBookCatalogScope,
        recover: recoverDocumentBookCatalog,
        mutate: (row) =>
          row.kind === 'delete'
            ? deleteBook(row.bookId, row.preconditions, row.userId)
            : updateBook(row.bookId, row.patch!, row.preconditions, row.userId),
      }),
    [userId],
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useLayoutEffect(() => {
    session.activate();
    if (userId) void session.load().catch(() => undefined);
    return () => session.dispose();
  }, [session, userId]);
  return {
    ...state,
    prepare: (bookId: string) => session.prepare(bookId),
    update: session.update,
    remove: session.remove,
    recover: session.recover,
    retry: session.retry,
    discardRejected: session.discardRejected,
  };
}
