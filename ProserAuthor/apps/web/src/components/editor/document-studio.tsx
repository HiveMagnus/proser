'use client';
import { ChevronLeft, ChevronRight, Search, Settings2, RefreshCw } from 'lucide-react';
import { headerFooterForChapter } from '@/lib/document-layout-editing';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { readThread } from '@/lib/plot-thread-api';
import type {
  DocumentManifestResponse,
  StructureSnapshot,
  BookLayoutSnapshot,
  DocumentSearchHit,
} from '@hivemagnus/proser-contracts';
import { orderedSceneReferences } from '@hivemagnus/proser-contracts';
import { getDocumentManifest, getDocumentScope, getDocumentCapabilities } from '@/lib/document-api';
import { DocumentPassageWorkspace } from './document-passage-workspace';
import { DocumentPassageWindowWorkspace } from './document-passage-window-workspace';
import { DocumentNavigationGuard } from './document-navigation-guard';
import { Button } from '@/components/ui/button';
import { DocumentBookContext } from './document-book-context';
import { DocumentLayoutSettings } from './document-layout-settings';
import { DocumentBookSearch } from './document-book-search';
import { DocumentFirstScene } from './document-first-scene';

/** Structured navigation contains identities/metadata, never every scene body.
 * The current editor session alone fetches a body and owns its save journal. */
export function DocumentStudio({
  bookId,
  sceneId,
  chapterId,
  requestedEditingScope,
  title,
  route = '/m/studio',
  onDirtyChange,
  onTargetChange,
}: {
  bookId: string;
  sceneId?: string | null;
  chapterId?: string | null;
  requestedEditingScope?: string | null;
  title?: string;
  route?: '/m/studio' | '/manuscript';
  onDirtyChange?: (dirty: boolean) => void;
  onTargetChange?: (target: {
    bookId: string;
    sceneId: string | null;
    title: string | null;
  }) => void;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const scope = `${session?.user?.id ?? ''}:${bookId}`;
  const [navigation, setNavigation] = useState<{
    scope: string;
    manifest: DocumentManifestResponse;
    structure: StructureSnapshot;
    layout: BookLayoutSnapshot;
    actorId: number;
  }>();
  const [error, setError] = useState<{ scope: string; message: string }>();
  const [reload, setReload] = useState(0);
  const [bodyDirty, setBodyDirty] = useState(false);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHit, setSearchHit] = useState<DocumentSearchHit>();
  const dirty = bodyDirty || layoutDirty;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const routeEditingScope =
    requestedEditingScope === 'scene' ||
    requestedEditingScope === 'chapter' ||
    requestedEditingScope === 'book'
      ? requestedEditingScope
      : chapterId
        ? 'chapter'
        : 'scene';
  const scopeRoute = `${scope}:${requestedEditingScope ?? ''}:${chapterId ?? ''}`;
  const [scopeChoice, setScopeChoice] = useState<{
    route: string;
    value: 'scene' | 'chapter' | 'book';
  }>({ route: scopeRoute, value: routeEditingScope });
  const editingScope = scopeChoice.route === scopeRoute ? scopeChoice.value : routeEditingScope;
  useEffect(() => {
    setScopeChoice({ route: scopeRoute, value: routeEditingScope });
  }, [scopeRoute, routeEditingScope]);
  const setEditingScope = (value: 'scene' | 'chapter' | 'book') =>
    setScopeChoice({ route: scopeRoute, value });
  const routeTarget = `${scope}:${sceneId ?? ''}:${chapterId ?? ''}`;
  const [windowFocus, setWindowFocus] = useState<{ routeTarget: string; sceneId: number }>();
  const windowFocusId = windowFocus?.routeTarget === routeTarget ? windowFocus.sceneId : undefined;
  useEffect(() => {
    setWindowFocus(undefined);
  }, [routeTarget]);
  const setWindowFocusId = useCallback(
    (id: number) => {
      setWindowFocus({ routeTarget, sceneId: id });
    },
    [routeTarget],
  );
  const reportDirty = useCallback((value: boolean) => {
    setBodyDirty(value);
  }, []);
  const [pendingTarget, setPendingTarget] = useState<{ kind: 'scene' | 'chapter'; id: number }>();
  const [notice, setNotice] = useState<string>();
  const query = useSearchParams();
  const requestedThread = query.get('threadId'),
    requestedEvidence = query.get('evidenceId');
  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId || !requestedThread || !requestedEvidence) return;
    let active = true;
    void readThread(bookId, userId, Number(requestedThread))
      .then((thread) => {
        if (!active) return;
        const evidence = thread.evidence.find((item) => item.id === requestedEvidence);
        if (!evidence || evidence.stale || String(evidence.source.frame.sceneId) !== sceneId)
          throw new Error(
            'The linked excerpt changed or is unavailable. Inspect its retained quotation in Plot Threads.',
          );
        const source = evidence.source;
        setSearchHit({
          id: evidence.id,
          sceneId: source.frame.sceneId,
          sceneNumber: source.position[4]!,
          chapterId: source.frame.chapterId,
          wordCount: 0,
          sceneRevisionId: source.frame.sceneRevisionId,
          sceneContentHash: source.frame.sceneContentHash,
          projectionSha256: source.frame.sceneContentHash,
          from: 0,
          to: source.text.length,
          sourceText: source.text,
          excerpt: source.text,
          excerptFrom: 0,
          excerptTo: source.text.length,
          anchors: source.anchors,
          locations: [],
          editable: true,
        });
        setNotice(`Opened exact ${evidence.stage} evidence from Plot Threads.`);
      })
      .catch((e) => {
        if (active) setNotice(e instanceof Error ? e.message : 'Unable to open linked evidence.');
      });
    return () => {
      active = false;
    };
  }, [bookId, userId, requestedThread, requestedEvidence, sceneId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const current = navigation?.scope === scope ? navigation : undefined;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const latestAcknowledgement = useRef<string | undefined>(undefined);
  const scenes = current?.manifest.scenes.filter((item) => !item.deletedAt) ?? [];
  const acts =
    current?.structure.acts
      .filter((act) => !act.deletedAt)
      .sort((a, b) => a.actNumber - b.actNumber || a.id - b.id) ?? [];
  const chapters = acts.flatMap(
    (act) =>
      current?.structure.chapters
        .filter((chapter) => chapter.actId === act.id && !chapter.deletedAt)
        .sort((a, b) => a.chapterNumber - b.chapterNumber || a.id - b.id) ?? [],
  );
  const requestedChapter =
    editingScope === 'chapter' && chapterId
      ? chapters.find((chapter) => String(chapter.id) === chapterId)
      : undefined;
  const focusedScene =
    editingScope !== 'scene' && windowFocusId
      ? scenes.find(
          (item) =>
            item.sceneId === windowFocusId &&
            (!requestedChapter || item.chapterId === requestedChapter.id),
        )
      : undefined;
  const unavailableChapter = editingScope === 'chapter' && chapterId && !requestedChapter;
  const selected = unavailableChapter
    ? undefined
    : (focusedScene ??
      (requestedChapter
        ? (scenes.find(
            (item) => String(item.sceneId) === sceneId && item.chapterId === requestedChapter.id,
          ) ?? scenes.find((item) => item.chapterId === requestedChapter.id))
        : sceneId
          ? scenes.find((item) => String(item.sceneId) === sceneId)
          : scenes[0]));
  const chapter = requestedChapter ?? chapters.find((item) => item.id === selected?.chapterId);
  const chapterIndex = chapter ? chapters.indexOf(chapter) : -1;
  const index = selected ? scenes.indexOf(selected) : -1;
  const targetScope = current?.scope;
  const targetSceneId = selected?.sceneId;
  const targetTitle = current?.structure.book.title;
  const emptyChapterTarget = editingScope === 'chapter' && Boolean(chapter) && !selected;
  useEffect(() => {
    if (targetScope && (targetSceneId || emptyChapterTarget))
      onTargetChange?.({
        bookId,
        sceneId: targetSceneId ? String(targetSceneId) : null,
        title: targetTitle ?? null,
      });
  }, [bookId, targetScope, targetTitle, targetSceneId, emptyChapterTarget, onTargetChange]);
  const acknowledged = useCallback(
    (saved: { bookRevisionId: string }) => {
      if (current?.manifest.revisionId === saved.bookRevisionId) return;
      latestAcknowledgement.current = saved.bookRevisionId;
      const captured = scope;
      const requested = saved.bookRevisionId;
      void getDocumentManifest(bookId)
        .then((manifest) => {
          if (currentScope.current !== captured || latestAcknowledgement.current !== requested)
            return;
          const previous = navigationRef.current;
          if (!previous || previous.scope !== captured) return;
          if (
            previous.manifest.scopes?.structure.revisionId !== manifest.scopes?.structure.revisionId
          ) {
            setNotice(
              'The saved book structure changed. Reload navigation after saving this draft.',
            );
            return;
          }
          setNavigation({
            ...previous,
            manifest: {
              ...manifest,
              scenes: orderedSceneReferences(manifest.scenes, previous.structure),
            },
          });
        })
        .catch(() => {
          if (currentScope.current === captured)
            setNotice('Saved word totals could not be refreshed. Your scene save is acknowledged.');
        });
    },
    [bookId, scope, current?.manifest.revisionId],
  );
  useEffect(() => {
    if (!session?.user?.id) return;
    const controller = new AbortController();
    setNavigation((previous) => (previous?.scope === scope ? previous : undefined));
    setError(undefined);
    setPendingTarget(undefined);
    void (async () => {
      const [manifest, capabilities] = await Promise.all([
        getDocumentManifest(bookId, controller.signal),
        getDocumentCapabilities(bookId, controller.signal),
      ]);
      if (
        !capabilities.enabled ||
        capabilities.schemaVersion !== 1 ||
        capabilities.orderedPassages !== 'ordered-window-v1' ||
        capabilities.passageOperations !== 'typed-operations-v1' ||
        !Number.isSafeInteger(capabilities.actorId) ||
        capabilities.actorId < 1
      )
        throw new Error('Factory cannot authenticate this structured editing session.');
      const [structure, layout] = await Promise.all([
        getDocumentScope(bookId, 'structure', controller.signal),
        getDocumentScope(bookId, 'layout', controller.signal),
      ]);
      if (
        structure.bookRevisionId !== manifest.revisionId ||
        structure.revisionId !== manifest.scopes?.structure.revisionId ||
        structure.contentHash !== manifest.scopes?.structure.contentHash ||
        layout.bookRevisionId !== manifest.revisionId ||
        layout.revisionId !== manifest.scopes?.layout.revisionId ||
        layout.contentHash !== manifest.scopes?.layout.contentHash
      )
        throw new Error('The book changed while loading navigation. Reload its saved structure.');
      if (!controller.signal.aborted)
        setNavigation({
          scope,
          manifest: {
            ...manifest,
            scenes: orderedSceneReferences(manifest.scenes, structure.content),
          },
          structure: structure.content,
          layout: layout.content,
          actorId: capabilities.actorId,
        });
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted)
        setError({
          scope,
          message:
            failure instanceof Error ? failure.message : 'Unable to load document navigation.',
        });
    });
    return () => controller.abort();
  }, [scope, session?.user?.id, bookId, reload]);
  const sceneRoute = (id: number, mode = editingScope) => {
    const reference = scenes.find((item) => item.sceneId === id);
    const scopeQuery = mode === 'scene' ? '' : `&scope=${mode}`;
    const chapterQuery = mode === 'chapter' && reference ? `&chapterId=${reference.chapterId}` : '';
    return `${route}?bookId=${encodeURIComponent(bookId)}&sceneId=${id}${scopeQuery}${chapterQuery}`;
  };
  const navigate = (id?: number) => {
    if (!id || selected?.sceneId === id || !scenes.some((item) => item.sceneId === id)) return;
    if (dirty) {
      setPendingTarget({ kind: 'scene', id });
      return;
    }
    router.replace(sceneRoute(id));
  };
  const navigateChapter = (id?: number) => {
    if (!id || chapter?.id === id || !chapters.some((item) => item.id === id)) return;
    if (dirty) {
      setPendingTarget({ kind: 'chapter', id });
      return;
    }
    const first = scenes.find((item) => item.chapterId === id);
    const sceneQuery = first ? `&sceneId=${first.sceneId}` : '';
    router.replace(
      `${route}?bookId=${encodeURIComponent(bookId)}&scope=chapter&chapterId=${id}${sceneQuery}`,
    );
  };
  if (error?.scope === scope && !current)
    return (
      <div role="alert">
        {error.message}
        <Button type="button" onClick={() => setReload((value) => value + 1)}>
          Reload navigation
        </Button>
      </div>
    );
  if (!current) return <p role="status">Loading structured writing workspace…</p>;
  if (unavailableChapter)
    return (
      <section role="alert">
        <p>The requested chapter is unavailable in this saved manuscript.</p>
        <Button type="button" onClick={() => navigateChapter(chapters[0]?.id)}>
          Open first saved chapter
        </Button>
      </section>
    );
  if (!selected && !(editingScope === 'chapter' && chapter))
    return (
      <section>
        <h1>{current.structure.book.title ?? title ?? 'Manuscript'}</h1>
        {scenes.length ? (
          <>
            <p role="alert">The requested scene is unavailable in this saved manuscript.</p>
            <Button type="button" onClick={() => navigate(scenes[0]?.sceneId)}>
              Open first saved scene
            </Button>
          </>
        ) : (
          <DocumentFirstScene
            key={scope}
            userId={session!.user!.id!}
            bookId={bookId}
            bookTitle={current.structure.book.title}
            base={{
              bookRevisionId: current.manifest.revisionId,
              structureRevisionId: current.manifest.scopes!.structure.revisionId,
            }}
            onCreated={(target) => {
              setReload((value) => value + 1);
              router.replace(
                `${route}?bookId=${encodeURIComponent(target.bookId)}&sceneId=${encodeURIComponent(target.sceneId)}`,
              );
            }}
            onReload={() => setReload((value) => value + 1)}
          />
        )}
      </section>
    );
  const scopedScenes =
    editingScope === 'chapter' ? scenes.filter((item) => item.chapterId === chapter?.id) : scenes;
  const scopedIndex = scopedScenes.findIndex((item) => item.sceneId === selected?.sceneId);
  const windowStart = Math.floor(Math.max(0, scopedIndex) / 3) * 3;
  const windowScenes = scopedScenes.slice(windowStart, windowStart + 3);
  return (
    <section className="proser-writing-studio" aria-label="Structured writing studio">
      <DocumentNavigationGuard dirty={dirty} />
      <header className={route === '/manuscript' ? 'sr-only' : 'proser-studio-title'}>
        <h1 className="text-xl font-semibold">
          {current.structure.book.title ?? title ?? 'Manuscript'}
        </h1>
        <p className="text-sm text-text-secondary">
          {chapter?.title ?? `Chapter ${chapter?.chapterNumber ?? selected?.chapterId}`}
          {selected && ` · Scene ${selected.sceneNumber}`}
        </p>
      </header>
      <nav aria-label="Manuscript navigation" className="proser-studio-navigation">
        <label className="proser-navigation-field">
          <span>Scope</span>
          <select
            aria-label="Manuscript editing scope"
            value={editingScope}
            disabled={dirty}
            className="proser-compact-select"
            onChange={(event) => {
              const next = event.target.value as 'scene' | 'chapter' | 'book';
              const target = selected ?? scenes[0];
              if (next === 'chapter' && chapter)
                router.replace(
                  `${route}?bookId=${encodeURIComponent(bookId)}&scope=chapter&chapterId=${chapter.id}${selected ? `&sceneId=${selected.sceneId}` : ''}`,
                );
              else if (target) router.replace(sceneRoute(target.sceneId, next));
              else
                router.replace(
                  `${route}?bookId=${encodeURIComponent(bookId)}${next === 'book' ? '&scope=book' : ''}`,
                );
              setEditingScope(next);
            }}
          >
            <option value="scene">Scene</option>
            <option value="chapter">Chapter</option>
            <option value="book">Whole book</option>
          </select>
        </label>
        <Button
          variant="ghost"
          type="button"
          disabled={editingScope === 'chapter' ? chapterIndex <= 0 : index <= 0}
          onClick={() =>
            editingScope === 'chapter'
              ? navigateChapter(chapters[chapterIndex - 1]?.id)
              : navigate(scenes[index - 1]?.sceneId)
          }
          className="proser-navigation-arrow"
          aria-label={editingScope === 'chapter' ? 'Previous chapter' : 'Previous scene'}
          title={editingScope === 'chapter' ? 'Previous chapter' : 'Previous scene'}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <label className="proser-navigation-field proser-scene-picker">
          <span>{editingScope === 'chapter' ? 'Chapter' : 'Scene'}</span>
          <select
            aria-label={editingScope === 'chapter' ? 'Navigate to chapter' : 'Navigate to scene'}
            value={editingScope === 'chapter' ? (chapter?.id ?? '') : (selected?.sceneId ?? '')}
            onChange={(event) =>
              editingScope === 'chapter'
                ? navigateChapter(Number(event.target.value))
                : navigate(Number(event.target.value))
            }
            className="proser-compact-select"
          >
            {editingScope === 'chapter'
              ? chapters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title ?? `Chapter ${item.chapterNumber}`}
                    {!scenes.some((scene) => scene.chapterId === item.id) ? ' · No scenes' : ''}
                  </option>
                ))
              : scenes.map((item) => {
                  const parent = chapters.find((chapter) => chapter.id === item.chapterId);
                  return (
                    <option key={item.sceneId} value={item.sceneId}>
                      {parent?.title ?? `Chapter ${parent?.chapterNumber ?? item.chapterId}`} ·
                      Scene {item.sceneNumber}
                    </option>
                  );
                })}
          </select>
        </label>
        <Button
          variant="ghost"
          type="button"
          disabled={
            editingScope === 'chapter'
              ? chapterIndex >= chapters.length - 1
              : index >= scenes.length - 1
          }
          onClick={() =>
            editingScope === 'chapter'
              ? navigateChapter(chapters[chapterIndex + 1]?.id)
              : navigate(scenes[index + 1]?.sceneId)
          }
          className="proser-navigation-arrow"
          aria-label={editingScope === 'chapter' ? 'Next chapter' : 'Next scene'}
          title={editingScope === 'chapter' ? 'Next chapter' : 'Next scene'}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={dirty}
          onClick={() => {
            setNotice(undefined);
            setReload((value) => value + 1);
          }}
          className="proser-navigation-arrow"
          aria-label="Reload saved navigation"
          title="Refresh scene navigation"
        >
          <RefreshCw aria-hidden="true" />
        </Button>
        <span className="proser-book-word-count">
          {current.manifest.totals.wordCount.toLocaleString()} <span>book words</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          className="proser-navigation-action"
          aria-expanded={searchOpen}
          aria-controls="manuscript-book-search"
          onClick={() => setSearchOpen((value) => !value)}
        >
          <Search aria-hidden="true" /> Search book
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="proser-navigation-action"
          aria-expanded={layoutOpen}
          onClick={() => setLayoutOpen((value) => !value)}
          disabled={layoutDirty}
        >
          <Settings2 aria-hidden="true" /> Page setup
        </Button>
      </nav>
      <div id="manuscript-book-search" hidden={!searchOpen}>
        <DocumentBookSearch
          bookId={bookId}
          disabled={dirty}
          onOpen={(hit) => {
            if (dirty) return;
            setSearchHit(hit);
            setWindowFocusId(hit.sceneId);
            if (String(hit.sceneId) !== sceneId) router.replace(sceneRoute(hit.sceneId));
          }}
        />
      </div>
      {layoutOpen && session?.user?.id && (
        <DocumentLayoutSettings
          actorId={current.actorId}
          onCommentCommitted={() => setReload((value) => value + 1)}
          userId={session.user.id}
          bookId={bookId}
          chapterId={chapter?.id}
          disabled={bodyDirty}
          onDirtyChange={setLayoutDirty}
          onCommitted={() => {
            setReload((value) => value + 1);
          }}
        />
      )}
      {error?.scope === scope && (
        <div role="alert">
          {error.message}
          <Button type="button" onClick={() => setReload((value) => value + 1)}>
            Reload navigation
          </Button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {pendingTarget && (
        <section
          aria-label="Unsaved navigation"
          className="space-y-3 rounded border border-accent-500 p-3"
        >
          <p>
            This manuscript has unacknowledged work. Save or reconcile it before switching{' '}
            {pendingTarget.kind === 'chapter' ? 'chapters' : 'scenes'}.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setPendingTarget(undefined)}>
              Keep editing
            </Button>
            <Button
              type="button"
              disabled={dirty}
              onClick={() => {
                const target = pendingTarget;
                setPendingTarget(undefined);
                if (target.kind === 'chapter') navigateChapter(target.id);
                else navigate(target.id);
              }}
            >
              Open selected {pendingTarget.kind} after saving
            </Button>
          </div>
        </section>
      )}
      {!selected ? (
        <p role="status">
          This chapter has no saved scenes. Add a scene in Structure to begin writing here.
        </p>
      ) : editingScope === 'scene' ? (
        session?.user?.id ? (
          <DocumentPassageWorkspace
            key={`${scope}:${selected.sceneId}:bounded`}
            namedStyles={current.layout.styles}
            searchHit={searchHit}
            userId={session.user.id}
            bookId={bookId}
            sceneId={String(selected.sceneId)}
            actorId={current.actorId}
            bookRevisionId={current.manifest.revisionId}
            onDirtyChange={reportDirty}
            displayStories={headerFooterForChapter(current.layout, selected.chapterId)}
            onAcknowledged={(passage) => acknowledged({ bookRevisionId: passage.bookRevisionId })}
            sideContext={
              current.manifest.scopes?.canon && (
                <DocumentBookContext bookId={bookId} reference={current.manifest.scopes.canon} />
              )
            }
          />
        ) : (
          <p role="status">Authenticate to edit this manuscript.</p>
        )
      ) : (
        <>
          <nav aria-label="Editing window navigation" className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={windowStart === 0}
              onClick={() => navigate(scopedScenes[Math.max(0, windowStart - 3)]?.sceneId)}
            >
              Previous editing window
            </Button>
            <span>
              {windowStart + 1}–{windowStart + windowScenes.length} of {scopedScenes.length} scenes
            </span>
            <Button
              type="button"
              variant="ghost"
              disabled={windowStart + 3 >= scopedScenes.length}
              onClick={() => navigate(scopedScenes[windowStart + 3]?.sceneId)}
            >
              Next editing window
            </Button>
          </nav>
          {session?.user?.id ? (
            <DocumentPassageWindowWorkspace
              key={`${scope}:bounded-window:${windowScenes.map((scene) => scene.sceneId).join(',')}`}
              searchHit={searchHit}
              userId={session.user.id}
              bookId={bookId}
              references={windowScenes}
              bookRevisionId={current.manifest.revisionId}
              layout={current.layout}
              actorId={current.actorId}
              selectedSceneId={selected.sceneId}
              onActiveSceneChange={setWindowFocusId}
              onDirtyChange={reportDirty}
              onAcknowledged={(passage) => acknowledged({ bookRevisionId: passage.bookRevisionId })}
              sideContext={
                current.manifest.scopes?.canon && (
                  <DocumentBookContext bookId={bookId} reference={current.manifest.scopes.canon} />
                )
              }
            />
          ) : (
            <p role="status">Authenticate to edit this manuscript.</p>
          )}
        </>
      )}
    </section>
  );
}
