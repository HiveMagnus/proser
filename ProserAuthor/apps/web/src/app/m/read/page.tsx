'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';

import { MobileArticle, normalizeProseText } from '@/components/mobile/mobile-article';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBooks } from '@/hooks/queries/use-books';
import { useMobileState } from '@/contexts/mobile-state-context';
import { useWorkspace } from '@/contexts/workspace-context';
import { getStructure, listImages, type ActRecord, type ImageAssetRecord } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSession } from 'next-auth/react';
import { getDocumentCapabilities } from '@/lib/document-api';
import { DocumentReader } from '@/components/mobile/document-reader';

type ReadMode = 'scene' | 'chapter' | 'full';

function findSceneContext(acts: ActRecord[], sceneId: string | null) {
  if (!sceneId) return null;
  for (const act of acts) {
    for (const chapter of act.chapters) {
      const scene = chapter.scenes.find((candidate) => candidate.id === sceneId);
      if (scene) return { act, chapter, scene };
    }
  }
  return null;
}

function flattenScenes(acts: ActRecord[]) {
  return acts.flatMap((act) =>
    act.chapters.flatMap((chapter) => chapter.scenes.map((scene) => ({ act, chapter, scene }))),
  );
}

function findFirstScene(acts: ActRecord[]) {
  for (const act of acts) {
    for (const chapter of act.chapters) {
      const scene = chapter.scenes[0];
      if (scene) return { act, chapter, scene };
    }
  }
  return null;
}

export default function MobileReadPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-[length:--text-sm] text-text-secondary">
          <Loader2 className="size-4 animate-spin" />
          Loading reader...
        </div>
      }
    >
      <MobileReadContent />
    </Suspense>
  );
}

function MobileReadContent() {
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const { lastBookId, lastSceneId } = useMobileState();
  const { activeBookId, activeSceneId } = useWorkspace();
  const { data: books = [] } = useBooks();
  const bookId = searchParams.get('bookId') ?? lastBookId ?? activeBookId;
  const sceneId =
    searchParams.get('sceneId') ??
    (lastBookId === bookId ? lastSceneId : null) ??
    (activeBookId === bookId ? activeSceneId : null);
  const scope = `${session?.user?.id ?? ''}:${bookId ?? ''}`;
  const [capability, setCapability] = useState<{ scope: string; enabled: boolean }>();
  const [failure, setFailure] = useState<{ scope: string; message: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!bookId || !session?.user?.id) return;
    const controller = new AbortController();
    setCapability(undefined);
    setFailure(undefined);
    void getDocumentCapabilities(bookId, controller.signal)
      .then((value) => {
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
  if (status === 'loading') return <p role="status">Loading reader session…</p>;
  if (!session?.user?.id) return <p role="status">Sign in to read your manuscript.</p>;
  if (!bookId) return <LegacyMobileReadContent />;
  if (failure?.scope === scope)
    return (
      <div role="alert">
        {failure.message}
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </button>
      </div>
    );
  if (capability?.scope !== scope) return <p role="status">Loading reader capabilities…</p>;
  return capability.enabled ? (
    <DocumentReader
      key={scope}
      bookId={bookId}
      sceneId={sceneId}
      title={books.find((book) => book.id === bookId)?.title}
    />
  ) : (
    <LegacyMobileReadContent />
  );
}

function LegacyMobileReadContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: books = [] } = useBooks();
  const { lastBookId, lastSceneId, setLastDraftTarget } = useMobileState();
  const {
    activeBookId,
    activeSceneId,
    setActiveBookId,
    setActiveBookTitle,
    setActiveSceneId,
    setActiveSurface,
  } = useWorkspace();

  const selectedBookId = searchParams.get('bookId') ?? lastBookId ?? activeBookId;
  const selectedSceneId =
    searchParams.get('sceneId') ??
    (lastBookId === selectedBookId ? lastSceneId : null) ??
    (activeBookId === selectedBookId ? activeSceneId : null);

  const [acts, setActs] = useState<ActRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ReadMode>('scene');
  const [sceneImage, setSceneImage] = useState<ImageAssetRecord | null>(null);

  const currentBook = books.find((book) => book.id === selectedBookId) ?? null;
  const currentContext = useMemo(
    () => findSceneContext(acts, selectedSceneId),
    [acts, selectedSceneId],
  );
  const sceneList = useMemo(() => flattenScenes(acts), [acts]);
  const currentSceneIndex = useMemo(
    () => sceneList.findIndex((entry) => entry.scene.id === currentContext?.scene.id),
    [currentContext?.scene.id, sceneList],
  );

  useEffect(() => {
    if (!selectedBookId) {
      setActs([]);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void getStructure(selectedBookId, { includeProse: true })
      .then((response) => {
        if (!active) return;
        setActs(response.data.acts);
      })
      .catch(() => {
        if (!active) return;
        setActs([]);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedBookId]);

  useEffect(() => {
    if (!selectedBookId || loading || currentContext || acts.length === 0) return;

    const fallback = findFirstScene(acts);
    if (!fallback) return;

    router.replace(
      `/m/read?bookId=${encodeURIComponent(selectedBookId)}&sceneId=${encodeURIComponent(fallback.scene.id)}`,
    );
  }, [acts, currentContext, loading, router, selectedBookId]);

  useEffect(() => {
    if (!selectedBookId || !currentContext || loading) return;

    const routeBookId = searchParams.get('bookId');
    const routeSceneId = searchParams.get('sceneId');
    if (routeBookId === selectedBookId && routeSceneId === currentContext.scene.id) return;

    const targetUrl = `/m/read?bookId=${encodeURIComponent(selectedBookId)}&sceneId=${encodeURIComponent(currentContext.scene.id)}`;
    window.history.replaceState(window.history.state, '', targetUrl);
  }, [currentContext, loading, searchParams, selectedBookId]);

  useEffect(() => {
    if (!selectedBookId || !currentContext) return;
    setActiveBookId(selectedBookId);
    setActiveSceneId(currentContext.scene.id);
    setActiveSurface('manuscript');
    setLastDraftTarget(selectedBookId, currentContext.scene.id);
    if (currentBook?.title) {
      setActiveBookTitle(currentBook.title);
    }
  }, [
    currentBook?.title,
    currentContext,
    selectedBookId,
    setActiveBookId,
    setActiveBookTitle,
    setActiveSceneId,
    setActiveSurface,
    setLastDraftTarget,
  ]);

  // Load scene image
  useEffect(() => {
    if (!selectedBookId || !currentContext) {
      setSceneImage(null);
      return;
    }
    let cancelled = false;
    void listImages({
      bookId: selectedBookId,
      entityType: 'scene',
      entityId: currentContext.scene.id,
      limit: 1,
    })
      .then((result) => {
        if (!cancelled) setSceneImage(result.items[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setSceneImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBookId, currentContext?.scene.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function goToScene(nextSceneId: string) {
    if (!selectedBookId) return;
    router.replace(
      `/m/read?bookId=${encodeURIComponent(selectedBookId)}&sceneId=${encodeURIComponent(nextSceneId)}`,
    );
  }

  const sceneText =
    normalizeProseText(currentContext?.scene.prose) ||
    currentContext?.scene.outline ||
    currentContext?.scene.summary ||
    '';
  const chapterText = (currentContext?.chapter.scenes ?? [])
    .map(
      (scene) =>
        `${scene.summary || scene.outline || `Scene ${scene.sceneNumber}`}\n\n${normalizeProseText(scene.prose) || scene.outline || ''}`,
    )
    .join('\n\n');
  const fullText = sceneList
    .map(
      (entry) =>
        `${entry.chapter.title || `Chapter ${entry.chapter.chapterNumber}`}: ${entry.scene.summary || entry.scene.outline || `Scene ${entry.scene.sceneNumber}`}\n\n${normalizeProseText(entry.scene.prose) || entry.scene.outline || ''}`,
    )
    .join('\n\n');

  const readerText =
    viewMode === 'scene' ? sceneText : viewMode === 'chapter' ? chapterText : fullText;

  if (!selectedBookId || !selectedSceneId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing to read yet</CardTitle>
          <CardDescription>Open a draft in the mobile studio first.</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href="/m"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-[--radius-md] bg-accent-500 px-4 text-[length:--text-sm] font-medium text-white transition-colors hover:bg-accent-600"
          >
            <ArrowLeft className="mr-2 size-4" />
            Back To Home
          </a>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-[length:--text-sm] text-text-secondary">
        <Loader2 className="size-4 animate-spin" />
        Loading reader...
      </div>
    );
  }

  if (!currentContext) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>This scene is unavailable</CardTitle>
          <CardDescription>Return to the studio and pick another scene.</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href="/m/studio"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-[--radius-md] bg-accent-500 px-4 text-[length:--text-sm] font-medium text-white transition-colors hover:bg-accent-600"
          >
            <ArrowLeft className="mr-2 size-4" />
            Back To Studio
          </a>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <p className="text-[length:--text-xs] uppercase tracking-[0.18em] text-text-muted">Read</p>
        <h1 className="text-[length:--text-2xl] font-semibold">
          {currentContext.scene.summary || currentContext.scene.outline || 'Current scene'}
        </h1>
        <p className="text-[length:--text-sm] text-text-secondary">
          {currentBook?.title || 'Selected project'} ·{' '}
          {currentContext.chapter.title || `Chapter ${currentContext.chapter.chapterNumber}`}
        </p>
      </section>

      <div className="sticky top-0 z-20 -mx-4 border-b border-border-muted bg-surface-base/95 px-4 py-2 backdrop-blur-md">
        <div className="mx-auto flex max-w-md items-center gap-2">
          <div className="flex items-center gap-1">
            {(
              [
                { id: 'scene', label: 'Scene' },
                { id: 'chapter', label: 'Ch' },
                { id: 'full', label: 'Full' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setViewMode(item.id)}
                className={cn(
                  'rounded-[--radius-md] px-2.5 py-1 text-[length:--text-xs] font-medium transition-colors',
                  viewMode === item.id
                    ? 'bg-accent-500 text-white'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Badge variant="info" className="text-[length:--text-[10px]] px-1.5 py-0.5">
            {currentSceneIndex + 1}/{sceneList.length}
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                const previous = sceneList[currentSceneIndex - 1];
                if (previous) goToScene(previous.scene.id);
              }}
              disabled={currentSceneIndex <= 0}
              className="flex size-7 items-center justify-center rounded-[--radius-md] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-40"
              aria-label="Previous scene"
            >
              <ArrowLeft className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                const next = sceneList[currentSceneIndex + 1];
                if (next) goToScene(next.scene.id);
              }}
              disabled={currentSceneIndex < 0 || currentSceneIndex >= sceneList.length - 1}
              className="flex size-7 items-center justify-center rounded-[--radius-md] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-40"
              aria-label="Next scene"
            >
              <ArrowRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {sceneImage && viewMode === 'scene' && (
        <div className="mobile-img-reveal overflow-hidden rounded-[--radius-lg]">
          <img
            src={`/api${sceneImage.url}`}
            alt={sceneImage.prompt || 'Scene illustration'}
            className="w-full object-cover"
            loading="lazy"
          />
        </div>
      )}

      <MobileArticle prose={readerText} />
    </div>
  );
}
