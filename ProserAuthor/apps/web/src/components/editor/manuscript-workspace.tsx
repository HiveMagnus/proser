'use client';
import { useCallback, useEffect, useState } from 'react';
import { Focus, TextCursorInput } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import { useBooks } from '@/hooks/queries/use-books';
import { useWorkspace } from '@/contexts/workspace-context';
import { DocumentStudio } from './document-studio';
import { Button } from '@/components/ui/button';
import { centerCaret, setWritingView, useWritingView } from '@/lib/writing-view';

export function ManuscriptWorkspace() {
  const router = useRouter();
  const query = useSearchParams();
  const {
    activeBookId,
    activeSceneId,
    setActiveBook,
    setActiveBookId,
    setActiveSceneId,
    setActiveSurface,
  } = useWorkspace();
  const { data: books = [], isLoading, error } = useBooks();
  const bookId = query.get('bookId') ?? activeBookId ?? books[0]?.id;
  const sceneId =
    query.get('sceneId') ??
    (!query.get('chapterId') && activeBookId === bookId ? activeSceneId : undefined);
  const view = useWritingView();
  const [dirty, setDirty] = useState(false);
  const [pendingBook, setPendingBook] = useState<string>();
  const acknowledgeDirty = useCallback((value: boolean) => setDirty(value), []);
  const updateTarget = useCallback(
    (target: { bookId: string; sceneId: string | null; title: string | null }) => {
      setActiveBook(target.bookId, target.title);
      setActiveSceneId(target.sceneId);
      setActiveSurface('manuscript');
    },
    [setActiveBook, setActiveSceneId, setActiveSurface],
  );
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setWritingView({ focus: !view.focus });
      }
    };
    document.addEventListener('keydown', toggle);
    return () => document.removeEventListener('keydown', toggle);
  }, [view.focus]);
  useEffect(() => {
    if (!view.typewriter) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => centerCaret());
    };
    for (const type of ['keyup', 'input', 'selectionchange', 'mouseup'] as const)
      document.addEventListener(type, follow, true);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of ['keyup', 'input', 'selectionchange', 'mouseup'] as const)
        document.removeEventListener(type, follow, true);
    };
  }, [view.typewriter]);
  const navigate = (id: string) => {
    if (id === bookId) return;
    if (dirty) {
      setPendingBook(id);
      return;
    }
    setActiveBookId(id);
    setActiveSceneId(null);
    setActiveSurface('manuscript');
    router.replace(`/manuscript?bookId=${encodeURIComponent(id)}`);
  };
  if (error) return <p role="alert">{error.message}</p>;
  if (isLoading) return <p role="status">Loading your manuscripts…</p>;
  return (
    <section aria-label="Manuscript workspace" className="proser-manuscript-workspace">
      <header className="proser-manuscript-heading">
        <label className="proser-book-picker">
          <span>Manuscript</span>
          <select
            aria-label="Choose manuscript book"
            value={bookId ?? ''}
            onChange={(event) => navigate(event.target.value)}
            className="proser-book-select"
          >
            {!bookId && <option value="">Choose a book</option>}
            {bookId && !books.some((book) => book.id === bookId) && (
              <option value={bookId}>Selected manuscript</option>
            )}
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </select>
        </label>
        <div className="proser-writing-view" role="group" aria-label="Writing view">
          <Button
            type="button"
            size="sm"
            variant={view.focus ? 'primary' : 'secondary'}
            aria-pressed={view.focus}
            title="Hide everything but the manuscript (Ctrl+Shift+F)"
            onClick={() => setWritingView({ focus: !view.focus })}
          >
            <Focus className="mr-1.5 size-3.5" aria-hidden="true" />
            {view.focus ? 'Exit focus' : 'Focus'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={view.typewriter ? 'primary' : 'secondary'}
            aria-pressed={view.typewriter}
            title="Keep the line you are typing in the middle of the screen"
            onClick={() => setWritingView({ typewriter: !view.typewriter })}
          >
            <TextCursorInput className="mr-1.5 size-3.5" aria-hidden="true" />
            Typewriter
          </Button>
        </div>
      </header>
      {pendingBook && (
        <section
          aria-label="Unsaved book navigation"
          className="space-y-2 rounded border border-accent-500 p-3"
        >
          <p>Save or reconcile the current scene before opening another book.</p>
          <Button type="button" variant="secondary" onClick={() => setPendingBook(undefined)}>
            Keep editing
          </Button>
          <Button
            type="button"
            disabled={dirty}
            onClick={() => {
              const id = pendingBook;
              setPendingBook(undefined);
              navigate(id);
            }}
          >
            Open selected book after saving
          </Button>
        </section>
      )}
      {bookId ? (
        <DocumentStudio
          key={bookId}
          bookId={bookId}
          sceneId={sceneId}
          chapterId={query.get('chapterId')}
          requestedEditingScope={query.get('scope')}
          route="/manuscript"
          onDirtyChange={acknowledgeDirty}
          onTargetChange={updateTarget}
        />
      ) : (
        <p>Create a book to begin a manuscript.</p>
      )}
    </section>
  );
}
