'use client';
import { useEffect, useState } from 'react';
import type {
  DocumentPassage,
  DocumentPassageCursor,
  DocumentTargetInput,
  PlotThreadEvidenceInput,
  PlotThreadStage,
  SceneDocumentReference,
} from '@hivemagnus/proser-contracts';
import { orderedSceneReferences, visibleRun } from '@hivemagnus/proser-contracts';
import { getDocumentManifest, getDocumentScope } from '@/lib/document-api';
import { plotRequest } from '@/lib/plot-thread-api';
import { Button } from '@/components/ui/button';
export function PlotThreadEvidencePicker({
  bookId,
  userId,
  stage,
  disabled,
  onAdd,
  onCancel,
}: {
  bookId: string;
  userId: string;
  stage: PlotThreadStage;
  disabled: boolean;
  onAdd(
    input: Omit<PlotThreadEvidenceInput, 'operationId' | 'expectedVersion' | 'replacesEvidenceId'>,
  ): Promise<void>;
  onCancel(): void;
}) {
  const [scenes, setScenes] = useState<SceneDocumentReference[]>([]);
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [revision, setRevision] = useState<string>();
  const [sceneId, setSceneId] = useState('');
  const [passage, setPassage] = useState<DocumentPassage>();
  const [cursor, setCursor] = useState<DocumentPassageCursor>();
  const [previous, setPrevious] = useState<DocumentPassageCursor[]>([]);
  const [target, setTarget] = useState<DocumentTargetInput>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setRevision(undefined);
    setScenes([]);
    setSceneId('');
    setPassage(undefined);
    setTarget(undefined);
    setCursor(undefined);
    setPrevious([]);
    void Promise.all([getDocumentManifest(bookId), getDocumentScope(bookId, 'structure')])
      .then(([manifest, structure]) => {
        if (!active) return;
        if (manifest.revisionId !== structure.bookRevisionId)
          throw new Error('Manuscript changed while loading. Reload saved scenes.');
        setRevision(manifest.revisionId);
        setScenes(
          orderedSceneReferences(manifest.scenes, structure.content).filter(
            (scene) => !scene.deletedAt,
          ),
        );
        const names: Record<number, string> = {};
        for (const scene of structure.content.scenes) {
          const chapter = structure.content.chapters.find((c) => c.id === scene.chapterId);
          const act = structure.content.acts.find((a) => a.id === chapter?.actId);
          names[scene.id] =
            `Act ${act?.actNumber} · Chapter ${chapter?.chapterNumber} · Scene ${scene.sceneNumber}${chapter?.title ? ': ' + chapter.title : ''}`;
        }
        setLabels(names);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load saved scenes.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bookId, reload]);
  useEffect(() => {
    if (!sceneId || !revision) return;
    let active = true;
    setLoading(true);
    setPassage(undefined);
    setTarget(undefined);
    setError(undefined);
    const query = new URLSearchParams({
      bookRevisionId: revision,
      maxCharacters: '8000',
      maxParagraphs: '12',
      projection: 'final',
    });
    if (cursor) {
      query.set('paragraph', String(cursor.paragraph));
      query.set('offset', String(cursor.offset));
      if (cursor.item !== undefined) query.set('item', String(cursor.item));
      if (cursor.run !== undefined) query.set('run', String(cursor.run));
    }
    void plotRequest<DocumentPassage>(
      `/api/books/${bookId}/scenes/${sceneId}/document-passages?${query}`,
      userId,
    )
      .then((row) => {
        if (active) setPassage(row);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load saved passage.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bookId, userId, sceneId, revision, cursor, reload]);
  return (
    <section
      aria-label={`Link ${stage} excerpt`}
      className="space-y-3 rounded border border-accent-500/40 p-4"
    >
      <h4 className="font-semibold">Link {stage} from a saved scene</h4>
      <label className="block">
        Scene
        <select
          aria-label="Scene"
          className="mt-1 w-full rounded border bg-surface-raised p-2"
          value={sceneId}
          disabled={disabled || loading}
          onChange={(e) => {
            setSceneId(e.target.value);
            setCursor(undefined);
            setPrevious([]);
          }}
        >
          <option value="">Choose a saved scene</option>
          {scenes.map((scene) => (
            <option key={scene.sceneId} value={scene.sceneId}>
              {labels[scene.sceneId]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-text-secondary">
        Select text in a saved passage below, or use a whole paragraph. The quoted text is saved
        with its scene revision.
      </p>
      {loading && <p role="status">Loading saved passage…</p>}
      {error && <p role="alert">{error}</p>}
      <Button
        type="button"
        variant="ghost"
        disabled={disabled || loading}
        onClick={() => {
          setTarget(undefined);
          setReload((n) => n + 1);
        }}
      >
        Reload saved scenes
      </Button>
      {passage?.paragraphs.map((item, index) => {
        const text = item.paragraph.runs
          .filter((run) => visibleRun(run, passage.changes, 'final'))
          .map((run) => (run.inlineImage ? '\ufffc' : run.text))
          .join('');
        const choose = (from: number, to: number) => {
          if (to > from)
            setTarget({
              blockId: item.paragraph.id,
              from: item.offset + from,
              to: item.offset + to,
              sourceText: text.slice(from, to),
            });
        };
        return (
          <div key={`${item.paragraph.id}:${item.offset}`} className="space-y-1">
            <label className="block text-sm">
              Saved paragraph {index + 1}
              <textarea
                aria-label={`Saved paragraph ${index + 1}`}
                readOnly
                value={text}
                rows={Math.min(8, Math.max(3, Math.ceil(text.length / 100)))}
                className="mt-1 w-full resize-y rounded border bg-surface-sunken p-3 font-serif"
                onSelect={(e) =>
                  choose(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)
                }
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || !text.trim()}
              onClick={() => choose(0, text.length)}
            >
              Use paragraph {index + 1}
            </Button>
          </div>
        );
      })}
      {sceneId && passage && !passage.paragraphs.length && <p>No saved text in this passage.</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || loading || !previous.length}
          onClick={() => {
            setCursor(previous.at(-1));
            setPrevious((rows) => rows.slice(0, -1));
          }}
        >
          Previous passage
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || loading || !passage?.next}
          onClick={() => {
            if (passage?.next) {
              setPrevious((rows) => [...rows, passage.cursor]);
              setCursor(passage.next);
            }
          }}
        >
          Next passage
        </Button>
      </div>
      {target && (
        <blockquote
          className="whitespace-pre-wrap break-words border-l-2 border-accent-500 pl-3"
          aria-label="Selected evidence excerpt"
        >
          {target.sourceText}
        </blockquote>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={disabled || loading || !target || !passage}
          onClick={() => {
            if (target && passage)
              void onAdd({
                stage,
                sceneId: passage.sceneId,
                expectedRevisionId: passage.bookRevisionId,
                expectedSceneRevisionId: passage.sceneRevisionId,
                expectedContentHash: passage.contentHash,
                targets: [target],
              }).catch((e) =>
                setError(e instanceof Error ? e.message : 'Unable to link evidence.'),
              );
          }}
        >
          Save linked excerpt
        </Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
          Cancel linking
        </Button>
      </div>
    </section>
  );
}
