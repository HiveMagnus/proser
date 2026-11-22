'use client';
import { useEffect, useRef, useState } from 'react';
import type { DocumentQuickDraftReceipt } from '@cheftaco/proser-contracts';
import { createBook } from '@/lib/api';
import {
  createDocumentQuickDraft,
  getDocumentManifest,
  recoverDocumentBookCreation,
  recoverDocumentQuickDraft,
  DocumentRequestError,
} from '@/lib/document-api';

import {
  readQuickDraftIntent,
  writeQuickDraftIntent,
  deleteQuickDraftIntent,
  type QuickDraftRequest,
  type QuickDraftIntent as Intent,
} from '@/lib/document-quick-drafts';
export type { QuickDraftRequest } from '@/lib/document-quick-drafts';
export interface QuickDraftTarget {
  bookId: string;
  sceneId: string;
  bookTitle?: string | null;
  outline: string;
}
/** Retains the exact transactional intent after lost acknowledgements. Recovery
 * performs GETs only; an explicit continuation reuses the original operation. */
export function useDocumentQuickDraft(userId?: string) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const intent = useRef<Intent | undefined>(undefined);
  const [pending, setPending] = useState<{
    userId: string;
    operationId: string;
    retryAllowed: boolean;
    rejected?: boolean;
  }>();
  const [journalError, setJournalError] = useState<{ userId: string; message: string }>();
  useEffect(() => {
    if (!userId) return;
    setJournalError(undefined);
    let active = true;
    void readQuickDraftIntent(userId)
      .then((row) => {
        if (!active || currentUser.current !== userId || intent.current?.userId === userId) return;
        intent.current = row;
        setPending(
          row
            ? {
                userId,
                operationId: row.draft?.operationId ?? row.creationId,
                retryAllowed: row.retryAllowed,
                rejected: row.rejected,
              }
            : undefined,
        );
      })
      .catch((error: unknown) => {
        if (active && currentUser.current === userId)
          setJournalError({
            userId,
            message: error instanceof Error ? error.message : 'Unable to open operation recovery.',
          });
      });
    return () => {
      active = false;
    };
  }, [userId]);
  const visiblePending = pending?.userId === userId ? pending : undefined;
  const owned = (row: Intent) => {
    if (!alive.current || !userId || currentUser.current !== row.userId)
      throw new Error('Authenticate as the same author before recovering this draft.');
  };
  const update = (row: Intent) => {
    if (currentUser.current === row.userId)
      setPending({
        userId: row.userId,
        operationId: row.draft?.operationId ?? row.creationId,
        retryAllowed: row.retryAllowed,
        rejected: row.rejected,
      });
  };
  const finish = async (
    row: Intent,
    receipt: DocumentQuickDraftReceipt,
  ): Promise<QuickDraftTarget> => {
    owned(row);
    if (
      receipt.kind !== 'catalog' ||
      receipt.status !== 'completed' ||
      receipt.operationId !== row.draft?.operationId ||
      receipt.result.command !== 'quick-draft' ||
      !receipt.manifest.scenes.some(
        (scene) => scene.sceneId === receipt.result.sceneId && !scene.deletedAt,
      )
    )
      throw new Error('The recovered operation does not identify the original quick draft.');
    await deleteQuickDraftIntent(row.userId, row.creationId);
    owned(row);
    if (intent.current === row) intent.current = undefined;
    setPending(undefined);
    return {
      bookId: row.bookId!,
      sceneId: String(receipt.result.sceneId),
      bookTitle: row.bookTitle,
      outline: row.request.outline,
    };
  };
  const perform = async (row: Intent): Promise<QuickDraftTarget> => {
    owned(row);
    row.retryAllowed = false;
    update(row);
    if (!row.bookId) {
      if (!row.request.newBook) throw new Error('Choose a book before creating this draft.');
      row.creationSent = true;
      await writeQuickDraftIntent(row);
      owned(row);
      const created = await createBook(
        { ...row.request.newBook, operationId: row.creationId },
        row.userId,
      );
      owned(row);
      row.bookId = created.data.id;
      row.bookTitle = created.data.title;
      await writeQuickDraftIntent(row);
      owned(row);
    }
    owned(row);
    if (!row.draft) {
      const manifest = row.request.base ? undefined : await getDocumentManifest(row.bookId);
      owned(row);
      const revisionId = row.request.base?.bookRevisionId ?? manifest?.revisionId;
      const structureRevisionId =
        row.request.base?.structureRevisionId ?? manifest?.scopes?.structure.revisionId;
      if (!revisionId || !structureRevisionId)
        throw new Error('The book does not advertise a supported structure revision.');
      row.draft = {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevisionId: revisionId,
        expectedScopes: { structure: structureRevisionId },
        summary: row.request.summary,
        outline: row.request.outline,
      };
      update(row);
    }
    owned(row);
    row.draftSent = true;
    await writeQuickDraftIntent(row);
    owned(row);
    try {
      return await finish(row, await createDocumentQuickDraft(row.bookId, row.draft));
    } catch (error) {
      if (error instanceof DocumentRequestError && [400, 412, 413, 422].includes(error.status)) {
        owned(row);
        row.rejected = true;
        await writeQuickDraftIntent(row);
        owned(row);
        update(row);
      }
      throw error;
    }
  };
  const create = async (request: QuickDraftRequest) => {
    if (!userId) throw new Error('Authenticate before creating a draft.');
    const capturedRequest = structuredClone(request);
    const retained = await readQuickDraftIntent(userId);
    if (currentUser.current !== userId)
      throw new Error('Authenticate as the same author before creating this draft.');
    if (retained && intent.current?.userId !== userId) {
      intent.current = retained;
      update(retained);
    }
    if (intent.current?.userId === userId)
      throw new Error('Recover the pending quick draft before creating another.');
    const row: Intent = {
      userId,
      request: capturedRequest,
      creationId: crypto.randomUUID(),
      bookId: request.bookId,
      bookTitle: request.bookTitle,
      creationSent: false,
      draftSent: false,
      retryAllowed: false,
    };
    intent.current = row;
    try {
      await writeQuickDraftIntent(row);
    } catch (error) {
      const retained = await readQuickDraftIntent(userId).catch(() => undefined);
      owned(row);
      if (retained) {
        intent.current = retained;
        update(retained);
      }
      throw error;
    }
    owned(row);
    update(row);
    return perform(row);
  };
  const recover = async (): Promise<QuickDraftTarget | undefined> => {
    const row = intent.current;
    if (!row || row.userId !== userId)
      throw new Error('No pending quick draft is available for this author.');
    owned(row);
    try {
      if (!row.bookId && row.creationSent) {
        const receipt = await recoverDocumentBookCreation(row.creationId, row.userId);
        owned(row);
        if (receipt.operationId !== row.creationId || receipt.status !== 'completed')
          throw new Error('Unexpected book creation receipt.');
        row.bookId = String(receipt.bookId);
        row.bookTitle = receipt.title;
      }
      if (row.draftSent && row.bookId && row.draft)
        return finish(row, await recoverDocumentQuickDraft(row.bookId, row.draft.operationId));
      row.retryAllowed = true;
      await writeQuickDraftIntent(row);
      owned(row);
      update(row);
      return undefined;
    } catch (error) {
      if (error instanceof DocumentRequestError && error.status === 404) {
        row.retryAllowed = true;
        await writeQuickDraftIntent(row);
        owned(row);
        update(row);
      }
      throw error;
    }
  };
  const retry = async () => {
    const row = intent.current;
    if (!row || row.userId !== userId || !row.retryAllowed)
      throw new Error('Recover the original operation before continuing it.');
    return perform(row);
  };
  const discardRejected = async () => {
    const row = intent.current;
    if (!row || row.userId !== userId || !row.rejected)
      throw new Error(
        'Only an explicitly rejected request can be discarded here. Recover uncertain operations first.',
      );
    owned(row);
    await deleteQuickDraftIntent(row.userId, row.creationId);
    owned(row);
    if (intent.current === row) intent.current = undefined;
    setPending(undefined);
  };
  return {
    create,
    recover,
    retry,
    discardRejected,
    pending: visiblePending,
    journalError: journalError && journalError.userId === userId ? journalError.message : undefined,
  };
}
