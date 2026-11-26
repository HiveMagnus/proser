'use client';
import { useEffect } from 'react';
import {
  CanvasDocumentEditor,
  type DocumentSelection,
  type ProserDocument,
  type DocumentLayout,
} from '@hivemagnus/proser-editor';
import type { BookLayoutSnapshot } from '@hivemagnus/proser-contracts';
import { useRejectedDocumentEdit } from '@/hooks/use-rejected-document-edit';
import { DocumentImagePicker } from './document-image-picker';
export function DocumentLayoutStoryEditor({
  userId,
  bookId,
  storyId,
  document,
  actorId,
  displayLayout,
  namedStyles,
  source,
  disabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onChange,
  onResolveChange,
  onCompositionState,
  onSelection,
  onError,
  onRejectedPending,
}: {
  userId: string;
  bookId: string;
  storyId: string;
  document: ProserDocument;
  actorId?: number;
  displayLayout: DocumentLayout;
  namedStyles: BookLayoutSnapshot['styles'];
  source?: { revisionId: string; contentHash: string };
  disabled?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onChange: (document: ProserDocument) => void;
  onResolveChange: (id: string, status: 'accepted' | 'rejected') => Promise<void>;
  onCompositionState: (pending: boolean) => void;
  onSelection: (selection: DocumentSelection | undefined) => void;
  onError: (message: string) => void;
  onRejectedPending: (storyId: string, pending: boolean) => void;
}) {
  const rejected = useRejectedDocumentEdit(
    userId,
    bookId,
    'layout-story',
    storyId,
    source && { ...source, document },
  );
  useEffect(() => {
    onRejectedPending(storyId, rejected.pending);
  }, [storyId, rejected.pending, onRejectedPending]);
  return (
    <>
      {rejected.pending && (
        <aside aria-label="Unsupported story edit">
          <p role="alert">
            {rejected.error ??
              'An unsupported story draft is retained for this account. Factory has not saved the native draft.'}
          </p>
          {rejected.retained?.nativeValue != null && (
            <button type="button" onClick={rejected.download}>
              Download unsupported draft
            </button>
          )}
          <button type="button" onClick={() => void rejected.discard()}>
            Discard unsupported edit
          </button>
        </aside>
      )}
      <CanvasDocumentEditor
        document={document}
        actorId={actorId}
        editable={!disabled}
        displayLayout={displayLayout}
        namedStyles={namedStyles}
        onChange={onChange}
        onResolveChange={onResolveChange}
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onCompositionState={onCompositionState}
        onDocumentSelection={onSelection}
        onError={onError}
        onRejectedEdit={rejected.reject}
        discardRejectedToken={rejected.discardToken}
      />
      <DocumentImagePicker
        bookId={bookId}
        document={document}
        disabled={disabled || rejected.pending}
        onChange={onChange}
      />
    </>
  );
}
