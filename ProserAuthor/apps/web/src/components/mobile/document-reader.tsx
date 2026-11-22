'use client';
import { useEffect, useMemo, useState } from 'react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import { useSession } from 'next-auth/react';
import { SemanticDocument, type DocumentManifestResponse } from '@cheftaco/proser-editor';
import type { DocumentStyleDefinitions } from '@cheftaco/proser-contracts';
import {
  getDocumentManifest,
  getDocumentScope,
  getSceneDocument,
  type SavedSceneDocument,
} from '@/lib/document-api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const fonts = ['Georgia', 'Arial', 'Times New Roman'];
const defaults = { font: 'Georgia', size: 18 };
export const readerPreferenceKey = (userId: string) =>
  JSON.stringify(['proser-reader-preferences-v1', userId]);
function readPreferences(userId: string) {
  try {
    const value = JSON.parse(localStorage.getItem(readerPreferenceKey(userId)) ?? 'null');
    if (
      value?.schemaVersion === 1 &&
      value.userId === userId &&
      fonts.includes(value.font) &&
      Number.isInteger(value.size) &&
      value.size >= 14 &&
      value.size <= 28
    )
      return { font: value.font as string, size: value.size as number };
  } catch {
    // Reading remains available when browser storage is unavailable.
  }
  return defaults;
}

/** Keep at most three scene bodies in memory, even in chapter/book reading. */
export function DocumentReader({
  bookId,
  sceneId,
  title,
}: {
  bookId: string;
  sceneId?: string | null;
  title?: string;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const identity = session?.user?.id;
  const scope = `${identity ?? ''}:${bookId}`;
  const [manifest, setManifest] = useState<{
    scope: string;
    value: DocumentManifestResponse;
    styles?: DocumentStyleDefinitions;
  }>();
  const [loaded, setLoaded] = useState<{ key: string; documents: SavedSceneDocument[] }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<'scene' | 'chapter' | 'book'>('scene');
  const [preferences, setPreferences] = useState<{ userId: string; font: string; size: number }>();
  const typography = preferences && preferences.userId === identity ? preferences : defaults;
  useEffect(() => {
    setPreferences(identity ? { userId: identity, ...readPreferences(identity) } : undefined);
  }, [identity]);
  const setTypography = (patch: Partial<typeof defaults>) => {
    if (!identity) return;
    const next = { userId: identity, ...typography, ...patch };
    setPreferences(next);
    try {
      localStorage.setItem(
        readerPreferenceKey(identity),
        JSON.stringify({ schemaVersion: 1, ...next }),
      );
    } catch {
      // Keep the current reading preference even if it cannot be retained.
    }
  };
  const current = manifest?.scope === scope ? manifest.value : undefined;
  const activeScenes = useMemo(
    () => current?.scenes.filter((item) => !item.deletedAt) ?? [],
    [current],
  );
  const selected = sceneId
    ? activeScenes.find((item) => String(item.sceneId) === sceneId)
    : activeScenes[0];
  const scenes = !selected
    ? []
    : mode === 'scene'
      ? [selected]
      : mode === 'chapter'
        ? activeScenes.filter((item) => item.chapterId === selected?.chapterId)
        : activeScenes;
  const size = mode === 'scene' ? 1 : 3;
  const start =
    Math.floor(
      Math.max(
        0,
        scenes.findIndex((item) => item.sceneId === selected?.sceneId),
      ) / size,
    ) * size;
  const windowScenes = scenes.slice(start, start + size);
  const windowKey = `${scope}:${current?.revisionId ?? ''}:${mode}:${windowScenes.map((item) => item.revisionId).join(':')}`;
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    setManifest(undefined);
    setLoaded(undefined);
    setFailure(undefined);
    void getDocumentManifest(bookId, controller.signal)
      .then(async (value) => {
        const layout = value.scopes?.layout
          ? await getDocumentScope(bookId, 'layout', controller.signal)
          : undefined;
        if (
          layout &&
          (layout.revisionId !== value.scopes?.layout.revisionId ||
            layout.contentHash !== value.scopes?.layout.contentHash)
        )
          throw new Error('The book layout changed while loading. Reload its saved revision.');
        if (!controller.signal.aborted)
          setManifest({ scope, value, styles: layout?.content.styles });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure({
            key: scope,
            message:
              error instanceof Error ? error.message : 'Unable to load the document manifest.',
          });
      });
    return () => controller.abort();
  }, [bookId, identity, scope, refresh]);
  useEffect(() => {
    if (!current || !windowScenes.length || !identity) return;
    const controller = new AbortController();
    setLoaded(undefined);
    void Promise.all(
      windowScenes.map(async (reference) => {
        const value = await getSceneDocument(bookId, String(reference.sceneId), controller.signal);
        if (
          value.revisionId !== reference.revisionId ||
          value.contentHash !== reference.contentHash
        )
          throw new Error(
            'The book changed while loading. Reload its saved revision before reading.',
          );
        return value;
      }),
    )
      .then((documents) => {
        if (!controller.signal.aborted) {
          setLoaded({ key: windowKey, documents });
          setFailure(undefined);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure({
            key: windowKey,
            message: error instanceof Error ? error.message : 'Unable to load these scenes.',
          });
      });
    return () => controller.abort();
    // The key contains every identity/revision determining this bounded window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, identity]);
  const go = (id?: number) => {
    if (id) router.replace(`/m/read?bookId=${encodeURIComponent(bookId)}&sceneId=${id}`);
  };
  const error = failure?.key === scope || failure?.key === windowKey ? failure.message : undefined;
  return (
    <section className="space-y-4" aria-label="Document reader">
      <h1 className="text-2xl font-semibold">{title ?? 'Saved manuscript'}</h1>
      <div
        aria-label="Reading controls"
        className="space-y-3 rounded-[--radius-lg] border border-border-muted bg-surface-raised/60 p-3"
      >
        <div role="group" aria-label="Reading scope" className="flex gap-1">
          {(['scene', 'chapter', 'book'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              variant="ghost"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'min-h-11 flex-1 rounded-[--radius-md] border border-transparent px-2',
                mode === value && 'border-accent-500/30 bg-accent-500/10 text-accent-500',
              )}
            >
              {value === 'book' ? 'Full book' : value === 'chapter' ? 'Chapter' : 'Scene'}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <label className="space-y-1 text-xs text-text-secondary">
            Reading font{' '}
            <select
              value={typography.font}
              onChange={(event) => setTypography({ font: event.target.value })}
              disabled={!identity}
              className="block min-h-11 w-full rounded-[--radius-md] border border-border-muted bg-surface-base px-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent-500"
            >
              {fonts.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-text-secondary">
            Reading size{' '}
            <input
              type="range"
              min="14"
              max="28"
              value={typography.size}
              aria-valuetext={`${typography.size} pixels`}
              onChange={(event) => setTypography({ size: Number(event.target.value) })}
              disabled={!identity}
              className="block min-h-11 w-full accent-accent-500 focus-visible:outline-2 focus-visible:outline-accent-500"
            />
          </label>
        </div>
      </div>
      <nav
        aria-label="Reader navigation"
        className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-y border-border-muted py-2"
      >
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-2 text-sm"
          disabled={
            !selected || (mode === 'scene' ? activeScenes.indexOf(selected) <= 0 : start === 0)
          }
          onClick={() =>
            go(
              mode === 'scene'
                ? activeScenes[activeScenes.indexOf(selected!) - 1]?.sceneId
                : scenes[Math.max(0, start - size)]?.sceneId,
            )
          }
        >
          Previous {mode === 'scene' ? 'scene' : 'page'}
        </Button>
        <span
          className="max-w-28 text-center text-xs leading-5 text-text-secondary"
          aria-live="polite"
        >
          {current && !selected
            ? activeScenes.length
              ? 'Scene unavailable'
              : 'No saved scenes'
            : current
              ? `${current.totals.wordCount.toLocaleString()} words · ${mode === 'scene' ? `Scene ${activeScenes.indexOf(selected!) + 1}/${activeScenes.length}` : `${start + 1}–${Math.min(start + size, scenes.length)} of ${scenes.length} scenes`}`
              : 'Loading manifest…'}
        </span>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-2 text-sm"
          disabled={
            !selected ||
            (mode === 'scene'
              ? !selected || activeScenes.indexOf(selected) >= activeScenes.length - 1
              : start + size >= scenes.length)
          }
          onClick={() =>
            go(
              mode === 'scene'
                ? activeScenes[activeScenes.indexOf(selected!) + 1]?.sceneId
                : scenes[start + size]?.sceneId,
            )
          }
        >
          Next {mode === 'scene' ? 'scene' : 'page'}
        </Button>
      </nav>
      {error ? (
        <div role="alert">
          {error}
          <Button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
            className="mt-3 min-h-11"
          >
            Reload saved revision
          </Button>
        </div>
      ) : !identity ? (
        <p role="status">Sign in to read this document.</p>
      ) : current && sceneId && !selected ? (
        <p role="status">This saved scene is unavailable. Choose another scene in the studio.</p>
      ) : !current || (windowScenes.length && loaded?.key !== windowKey) ? (
        <p role="status">Loading saved scenes…</p>
      ) : !scenes.length ? (
        <p>This manuscript has no scenes.</p>
      ) : (
        loaded?.key === windowKey &&
        loaded.documents.map((value) => (
          <section key={value.sceneId} aria-label={`Scene ${value.sceneId}`}>
            <SemanticDocument
              document={value.document}
              namedStyles={manifest?.styles}
              typography={typography}
            />
          </section>
        ))
      )}
    </section>
  );
}
