'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBooks } from '@/hooks/queries/use-books';
import { useMobileState } from '@/contexts/mobile-state-context';
import { useWorkspace } from '@/contexts/workspace-context';
import { getDocumentCapabilities, getAuthoringDocumentCapabilities } from '@/lib/document-api';
import { DocumentStudio } from '@/components/editor/document-studio';
export default function MobileStudioPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-[length:--text-sm] text-text-secondary">
          <Loader2 className="size-4 animate-spin" />
          Loading studio...
        </div>
      }
    >
      <MobileStudioContent />
    </Suspense>
  );
}

function MobileStudioContent() {
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const { lastBookId, lastSceneId, setLastDraftTarget } = useMobileState();
  const { activeBookId, activeSceneId, setActiveBook, setActiveSceneId, setActiveSurface } =
    useWorkspace();
  const { data: books = [] } = useBooks();
  const bookId = searchParams.get('bookId') ?? lastBookId ?? activeBookId ?? books[0]?.id;
  const sceneId =
    searchParams.get('sceneId') ??
    (!searchParams.get('chapterId') && bookId === lastBookId ? lastSceneId : undefined) ??
    (!searchParams.get('chapterId') && bookId === activeBookId ? activeSceneId : undefined);
  const updateTarget = useCallback(
    (target: { bookId: string; sceneId: string | null; title: string | null }) => {
      setActiveBook(target.bookId, target.title);
      setActiveSceneId(target.sceneId);
      setActiveSurface('manuscript');
      setLastDraftTarget(target.bookId, target.sceneId);
    },
    [setActiveBook, setActiveSceneId, setActiveSurface, setLastDraftTarget],
  );
  const scope = `${session?.user?.id ?? ''}:${bookId ?? ''}`;
  const [capability, setCapability] = useState<{ scope: string; enabled: boolean }>();
  const [failure, setFailure] = useState<{ scope: string; message: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!session?.user?.id) return;
    const controller = new AbortController();
    setCapability(undefined);
    setFailure(undefined);
    void (
      bookId
        ? getDocumentCapabilities(bookId, controller.signal)
        : getAuthoringDocumentCapabilities(controller.signal)
    )
      .then((value) => {
        if (
          value.schemaVersion !== 1 ||
          (value.enabled &&
            (value.orderedPassages !== 'ordered-window-v1' ||
              value.passageOperations !== 'typed-operations-v1'))
        )
          throw new Error(
            'This Factory document schema is unsupported. Update Author before editing.',
          );
        if (!controller.signal.aborted) setCapability({ scope, enabled: value.enabled });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure({
            scope,
            message:
              error instanceof Error ? error.message : 'Unable to check document capabilities.',
          });
      });
    return () => controller.abort();
  }, [bookId, session?.user?.id, scope, retry]);
  if (status === 'loading') return <p role="status">Loading studio session…</p>;
  if (!session?.user?.id) return <p role="status">Sign in to edit your manuscript.</p>;
  if (failure?.scope === scope)
    return (
      <div role="alert">
        {failure.message}
        <Button type="button" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </Button>
      </div>
    );
  if (capability?.scope !== scope) return <p role="status">Loading studio capabilities…</p>;
  if (!bookId)
    return capability.enabled ? (
      <p>Create or choose a book before opening the structured studio.</p>
    ) : (
      <p role="alert">
        Manuscript editing is unavailable while Factory document authority is inactive.
      </p>
    );
  return capability.enabled ? (
    <DocumentStudio
      key={scope}
      bookId={bookId}
      sceneId={sceneId}
      chapterId={searchParams.get('chapterId')}
      requestedEditingScope={searchParams.get('scope')}
      title={books.find((book) => book.id === bookId)?.title}
      onTargetChange={updateTarget}
    />
  ) : (
    <p role="alert">
      Manuscript editing is unavailable while Factory document authority is inactive.
    </p>
  );
}
