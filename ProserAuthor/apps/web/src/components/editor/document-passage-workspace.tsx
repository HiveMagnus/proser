'use client';
import {
  Undo2,
  Redo2,
  PanelRight,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  X,
  Check,
  Save,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CanvasDocumentEditor,
  SemanticDocument,
  paragraphSelection,
  formatDocumentSelection,
  formatDocumentParagraph,
  type DocumentSelection,
} from '@cheftaco/proser-editor';
import {
  canonicalDocument,
  visibleRun,
  type DocumentPassage,
  type DocumentView,
  type ProserDocument,
  type DocumentTargetInput,
  type DocumentPassageOperation,
  type DocumentSearchHit,
} from '@cheftaco/proser-contracts';
import { editManualParagraphText } from '../../../../../packages/editor/src/manual-review-editing';
import { useDocumentPassageSession } from '@/hooks/use-document-passage-session';
import { useRejectedDocumentEdit } from '@/hooks/use-rejected-document-edit';
import { passageHasPartialTable } from '@/lib/document-passage-document';
import { Button } from '@/components/ui/button';
import { PlotThreadCapture } from '@/components/plot/plot-thread-capture';
import { BoundedDocumentDiscussion } from './bounded-document-discussion';
import { DocumentPassageObjects } from './document-passage-objects';
import { DocumentPassageComments } from './document-passage-comments';
import { BoundedDocumentReview } from './bounded-document-review';

/** A fragment uses its original table owner and a presentation-only width.
 * Missing rows/cells remain outside this render, never fabricated documents. */
function PartialPassageTable({
  passage,
  document,
  editable,
  actorId,
  namedStyles,
  onChange,
  onSelection,
  onComposition,
  onError,
}: {
  passage: DocumentPassage;
  document: ProserDocument;
  editable: boolean;
  actorId: number;
  namedStyles?: import('@cheftaco/proser-contracts').DocumentStyleDefinitions;
  onChange(document: ProserDocument): void;
  onSelection(selection: DocumentSelection | undefined, error?: string): void;
  onComposition(pending: boolean): void;
  onError(message: string): void;
}) {
  const changeText = (blockId: string, value: string) => {
    try {
      onChange(
        editManualParagraphText(document, blockId, value, actorId, false, () =>
          crypto.randomUUID(),
        ),
      );
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : 'This paragraph edit needs reconciliation.');
      return false;
    }
  };
  return (
    <div className="space-y-4" aria-label="Ordered manuscript passage">
      {document.blocks.map((block) => {
        const render = (value: ProserDocument) => (
          <SemanticDocument
            document={value}
            namedStyles={namedStyles ?? passage.styles}
            view={passage.projection}
            editable={editable}
            onEditParagraph={changeText}
            onSelection={onSelection}
            onCompositionState={onComposition}
            onFormatSelection={(selection, patch) => {
              try {
                onChange(
                  formatDocumentSelection(
                    document,
                    selection,
                    patch,
                    () => crypto.randomUUID(),
                    actorId,
                  ),
                );
              } catch (error) {
                onError(error instanceof Error ? error.message : 'Formatting needs review.');
              }
            }}
            onFormatParagraph={(id, patch) => {
              try {
                onChange(formatDocumentParagraph(document, id, patch, actorId));
              } catch (error) {
                onError(error instanceof Error ? error.message : 'Formatting needs review.');
              }
            }}
          />
        );
        if (block.type !== 'table')
          return <div key={block.id}>{render({ ...document, blocks: [block] })}</div>;
        const source = passage.items?.find(
          (item) => item.type === 'tableSlice' && item.id === block.id,
        );
        if (source?.type !== 'tableSlice')
          return (
            <p role="alert" key={block.id}>
              The table has no ordered source. Reload this passage.
            </p>
          );
        return (
          <section
            key={block.id}
            aria-label="Manuscript table passage"
            className="overflow-x-auto space-y-2"
          >
            <p className="text-sm">
              Table rows {(source.rows[0]?.ordinal ?? -1) + 1}–
              {(source.rows.at(-1)?.ordinal ?? -1) + 1} of {source.rowCount}. Adjacent cells remain
              preserved in Factory.
            </p>
            {source.rows.map((row) => (
              <div
                key={row.id}
                role="row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: source.widths.map((width) => `${width}fr`).join(' '),
                }}
              >
                {row.cells.map((cell) => {
                  const canonicalCell = block.rows
                    .find((item) => item.id === row.id)
                    ?.cells.find((item) => item.id === cell.id);
                  if (!canonicalCell) return null;
                  const fragment = {
                    ...block,
                    widths: [source.widths[cell.columnIndex]!],
                    rows: [{ id: row.id, cells: [canonicalCell] }],
                  };
                  return (
                    <div
                      key={cell.id}
                      role="cell"
                      data-source-column={cell.columnIndex}
                      style={{ gridColumn: cell.columnIndex + 1 }}
                      className="border border-border-muted p-2 min-w-0"
                    >
                      {render({ ...document, blocks: [fragment] })}
                      {(cell.continuedBefore || cell.continuedAfter) && (
                        <p className="text-xs">Cell continued in an adjacent passage.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
export function DocumentPassageWorkspace({
  userId,
  bookId,
  sceneId,
  actorId,
  bookRevisionId,
  displayStories,
  namedStyles,
  searchHit,
  onDirtyChange,
  onAcknowledged,
  sideContext,
  active = true,
  disabled = false,
  onActivate,
  onSession,
}: {
  userId: string;
  bookId: string;
  sceneId: string;
  actorId: number;
  bookRevisionId?: string;
  displayStories?: { header?: ProserDocument; footer?: ProserDocument };
  namedStyles?: import('@cheftaco/proser-contracts').DocumentStyleDefinitions;
  searchHit?: DocumentSearchHit;
  onDirtyChange?: (dirty: boolean) => void;
  onAcknowledged?: (passage: DocumentPassage) => void;
  sideContext?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onActivate?: () => void;
  onSession?: (session: import('@/lib/document-passage-typed-session').PassageTypedSession) => void;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTab, setReviewTab] = useState<
    'discuss' | 'review' | 'comments' | 'insert' | 'context'
  >('discuss');
  const [commentPending, setCommentPending] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [tracking, setTracking] = useState(false),
    [composing, setComposing] = useState(false),
    [error, setError] = useState<string>();
  const [selection, setSelection] = useState<DocumentSelection>(),
    [selectionError, setSelectionError] = useState<string>();
  const [discussionSessionId] = useState(() => crypto.randomUUID());
  const editor = useDocumentPassageSession(userId, bookId, sceneId, {
    tracking,
    composing,
    bookRevisionId,
  });
  const { passage, document, session } = editor;
  // Canvas owns a native selection and composition session. Selection/status
  // renders must not replace its page settings and recreate that session.
  const pageSettings = passage?.layout;
  const displayLayout = useMemo(
    () => (pageSettings ? { ...pageSettings, header: [], footer: [] } : undefined),
    [pageSettings],
  );
  useEffect(() => onSession?.(session), [session, passage, document, editor.state, onSession]);
  const rejected = useRejectedDocumentEdit(
    userId,
    bookId,
    'scene',
    sceneId,
    passage && document
      ? { revisionId: passage.sceneRevisionId, contentHash: passage.contentHash, document }
      : undefined,
  );
  const dirty =
    editor.state !== 'saved' || composing || rejected.pending || commentPending || reviewPending;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const acknowledged = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (editor.state === 'saved' && passage && acknowledged.current !== passage.sceneRevisionId) {
      acknowledged.current = passage.sceneRevisionId;
      onAcknowledged?.(passage);
    }
  }, [editor.state, passage, onAcknowledged]);
  const previous = useRef<DocumentPassage['cursor'][]>([]);
  const report = (failure: unknown) =>
    setError(
      failure instanceof Error ? failure.message : 'Unable to complete this manuscript action.',
    );
  const change = (value: ProserDocument) => {
    try {
      session.edit(value);
      setError(undefined);
      if (session.getSnapshot().structuralFlight) void session.save(tracking).catch(report);
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : 'This native edit cannot be represented safely.';
      rejected.reject(value, message);
      setError(message);
    }
  };
  const currentOps = (() => {
    try {
      return session.localOperations();
    } catch {
      return undefined;
    }
  })();
  const displayedTargets: DocumentTargetInput[] =
    passage && document
      ? passage.paragraphs.flatMap((scope) => {
          const paragraph = document.blocks
            .flatMap((block) =>
              block.type === 'paragraph'
                ? [block]
                : block.type === 'table'
                  ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
                  : [],
            )
            .find((item) => item.id === scope.paragraph.id);
          if (!paragraph) return [];
          const sourceText = paragraph.runs
            .filter((run) => visibleRun(run, document.changes, 'final'))
            .map((run) => (run.inlineImage ? '\ufffc' : run.text))
            .join('');
          return [
            {
              blockId: paragraph.id,
              from: scope.offset,
              to: scope.offset + sourceText.length,
              sourceText,
            },
          ];
        })
      : [];
  const canonicalSelection =
    selection && passage
      ? {
          ...selection,
          targets: selection.targets.map((target) => {
            const scope = passage.paragraphs.find((item) => item.paragraph.id === target.blockId);
            if (!scope) throw new Error('Selection left this bounded passage.');
            return { ...target, from: target.from + scope.offset, to: target.to + scope.offset };
          }),
        }
      : undefined;
  const focus =
    passage && document && editor.focusBlockId
      ? (() => {
          const paragraph = document.blocks
            .flatMap((block) =>
              block.type === 'paragraph'
                ? [block]
                : block.type === 'table'
                  ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
                  : [],
            )
            .find((item) => item.id === editor.focusBlockId);
          if (!paragraph) return undefined;
          return paragraphSelection(
            document,
            paragraph.id,
            0,
            0,
            paragraph.runs
              .filter((run) => visibleRun(run, document.changes, 'final'))
              .map((run) => run.text)
              .join(''),
            true,
          );
        })()
      : undefined;
  const focusedHit = useRef<string | undefined>(undefined);
  const [searchSelection, setSearchSelection] = useState<DocumentSelection>();
  useEffect(() => {
    if (!searchHit || !passage || editor.state !== 'saved' || focusedHit.current === searchHit.id)
      return;
    if (
      searchHit.sceneId !== passage.sceneId ||
      searchHit.sceneRevisionId !== passage.sceneRevisionId ||
      searchHit.sceneContentHash !== passage.contentHash
    ) {
      setSelectionError('The searched scene changed. Run the search again.');
      focusedHit.current = searchHit.id;
      return;
    }
    const anchor = searchHit.anchors[0];
    if (!anchor) {
      setSelectionError('This search result has no stable document anchor.');
      return;
    }
    focusedHit.current = searchHit.id;
    void session
      .load({
        bookRevisionId: passage.bookRevisionId,
        maxCharacters: Math.min(32768, Math.max(16000, searchHit.sourceText.length + 64)),
        anchorBlockId: anchor.blockId,
        anchorRunId: anchor.runId,
        anchorOffset: anchor.start,
      })
      .then(() => {
        const latest = session.getSnapshot();
        if (
          !latest.passage ||
          !latest.document ||
          latest.passage.sceneRevisionId !== searchHit.sceneRevisionId
        )
          return;
        try {
          const scopes = searchHit.anchors.map((point) => {
            const fragment = latest.passage!.paragraphs.find(
                (item) => item.paragraph.id === point.blockId,
              ),
              source = fragment?.runs.find((item) => item.runId === point.runId);
            if (!fragment || !source || point.start < source.from || point.end > source.to)
              throw new Error(
                'The complete search range crosses this bounded passage. Open adjacent content before selecting it.',
              );
            let start = 0;
            for (const run of fragment.paragraph.runs) {
              if (run.id === point.runId) break;
              start += run.inlineImage ? 1 : run.text.length;
            }
            const value = fragment.paragraph.runs
              .map((run) => (run.inlineImage ? '\ufffc' : run.text))
              .join('');
            const from = start + point.start - source.from,
              to = start + point.end - source.from;
            if (value.slice(from, to) !== point.sourceText)
              throw new Error('The searched source changed. Run the search again.');
            return paragraphSelection(latest.document!, point.blockId, from, to, value);
          });
          const first = scopes[0];
          if (!first) throw new Error('The search range is not editable.');
          if (
            scopes.some(
              (item) =>
                !item || canonicalDocument(item.container) !== canonicalDocument(first.container),
            )
          )
            throw new Error('This search range crosses protected containers.');
          const targets = scopes.flatMap((item) => item?.targets ?? []),
            runs = scopes.flatMap((item) => item?.runs ?? []);
          setSearchSelection({ ...first, targets, runs });
        } catch (failure) {
          setSelectionError(
            failure instanceof Error ? failure.message : 'The search range is stale.',
          );
        }
      })
      .catch(report);
  }, [searchHit, passage, editor.state, session]);
  const writeBlocked =
    disabled ||
    commentPending ||
    reviewPending ||
    !active ||
    ['loading', 'conflict', 'recoverable', 'failed'].includes(editor.state) ||
    Boolean(editor.structuralFlight) ||
    Boolean(editor.recovery) ||
    rejected.pending;
  const readonly = writeBlocked || passage?.projection !== 'final';
  const reviewDisabled =
    writeBlocked ||
    composing ||
    editor.state !== 'saved' ||
    !['final', 'markup'].includes(passage?.projection ?? '');
  const canResolveChange = (id: string) =>
    !reviewDisabled && !!passage?.changeSummaries?.some((change) => change.id === id);
  const view = async (projection: DocumentView) => {
    try {
      await editor.flush();
      const cursor = passage?.cursor;
      const markupTransition = projection === 'markup' || passage?.projection === 'markup';
      await session.load({
        projection,
        // Markup can show both sides of a tracked replacement, with different offsets.
        cursor:
          cursor && markupTransition
            ? { paragraph: cursor.paragraph, item: cursor.item, offset: 0 }
            : cursor,
      });
      setSelection(undefined);
    } catch (failure) {
      report(failure);
    }
  };
  const operate = async (operations: DocumentPassageOperation[]) => {
    try {
      await session.operate(operations, tracking);
      setSelection(undefined);
    } catch (failure) {
      report(failure);
    }
  };
  const resolveTrackedChange = async (id: string, decision: 'accepted' | 'rejected') => {
    const summary = passage?.changeSummaries?.find((item) => item.id === id);
    if (!summary || reviewDisabled) return;
    await operate([
      {
        id: crypto.randomUUID(),
        kind: 'resolve-change',
        changeId: id,
        changeHash: summary.recordHash,
        targetHash: summary.targetHash,
        decision,
      },
    ]);
  };
  const insertToolbarTable = async (target: DocumentSelection) => {
    try {
      if (readonly || composing || tracking)
        throw new Error('Finish the current edit and turn off tracking before inserting a table.');
      if (target.container.tableId)
        throw new Error(
          'Place the caret in a paragraph outside the table to insert another table.',
        );
      const blockId = target.targets[0]?.blockId;
      if (!blockId) throw new Error('Place the caret in the paragraph before the new table.');
      await editor.flush();
      const current = session.getSnapshot().passage;
      const item = current?.items?.find(
        (value) =>
          value.type === 'paragraph' &&
          current.paragraphs[value.paragraphIndex]?.paragraph.id === blockId,
      );
      if (!item)
        throw new Error(
          'The selected paragraph changed. Select it again before inserting a table.',
        );
      await session.operate(
        [
          {
            id: crypto.randomUUID(),
            kind: 'insert-table',
            placement: item.placement.after,
            widths: [200, 200],
            rows: 2,
          },
        ],
        false,
      );
      setSelection(undefined);
    } catch (failure) {
      report(failure);
    }
  };
  return (
    <section
      className="proser-document-workspace"
      data-scene-id={sceneId}
      data-bounded-scene
      aria-label="Bounded scene workspace"
    >
      <div className="proser-document-status">
        <span
          role="status"
          aria-live="polite"
          className="proser-save-state"
          data-state={editor.state}
        >
          {editor.state === 'saved' && !composing && <Check aria-hidden="true" />}
          {!editor.online && dirty
            ? 'Offline · retained changes'
            : {
                loading: 'Loading passage…',
                saved: composing ? 'Composing text…' : 'Saved',
                unsaved: 'Unsaved changes',
                saving: 'Saving…',
                recoverable: 'Recoverable save',
                conflict: 'Save conflict',
                failed: 'Save failed',
                inactive: 'Signed out',
              }[editor.state]}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="proser-save-button"
          disabled={
            readonly ||
            composing ||
            !editor.online ||
            editor.state === 'saving' ||
            (!dirty && editor.state === 'saved')
          }
          onClick={() => void session.save(tracking).catch(report)}
        >
          <Save aria-hidden="true" /> Save changes
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={readonly || composing || !editor.canUndo}
          size="icon"
          className="proser-status-icon"
          aria-label="Undo saved operation"
          title="Undo last edit"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void session.undoRevision().catch(report)}
        >
          <Undo2 aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={readonly || composing || !editor.canRedo}
          size="icon"
          className="proser-status-icon"
          aria-label="Redo saved operation"
          title="Redo last edit"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void session.redoRevision().catch(report)}
        >
          <Redo2 aria-hidden="true" />
        </Button>
        <label className="proser-review-view">
          <span>Review view</span>
          <select
            aria-label="Passage review view"
            className="proser-compact-select"
            value={passage?.projection ?? 'final'}
            disabled={dirty || composing}
            onChange={(event) => void view(event.target.value as DocumentView)}
          >
            <option value="final">Working text</option>
            <option value="original">Original</option>
            <option value="markup">Markup</option>
          </select>
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="proser-review-toggle"
          aria-expanded={reviewOpen}
          aria-controls={`manuscript-review-${sceneId}`}
          onClick={() => setReviewOpen((value) => !value)}
        >
          <PanelRight aria-hidden="true" /> Review panel
        </Button>
      </div>
      {(error || editor.error) && <p role="alert">{error ?? editor.error}</p>}
      {editor.state === 'failed' && (
        <Button
          type="button"
          onClick={() => void (document ? session.retryStorage() : session.load()).catch(report)}
        >
          {document ? 'Retry draft storage' : 'Reload passage'}
        </Button>
      )}
      {editor.recovery && (
        <aside aria-label="Passage draft recovery" className="rounded border p-3 space-x-3">
          <p>Unacknowledged work is retained for this authenticated account and scene.</p>
          {editor.recovery.document && editor.recovery.passage.projection === 'final' && (
            <Button type="button" onClick={() => void session.restoreLocalDraft().catch(report)}>
              Restore retained draft
            </Button>
          )}
          {editor.recovery.pending ? (
            <Button type="button" onClick={() => void session.recover().catch(report)}>
              Recover original operation
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void session.discard().catch(report)}
            >
              Discard retained draft
            </Button>
          )}
        </aside>
      )}
      {editor.state === 'recoverable' && !editor.recovery && (
        <aside aria-label="Recover passage save" className="rounded border p-3 space-x-3">
          <p>Recover the exact operation before retrying.</p>
          <Button type="button" onClick={() => void session.recover().catch(report)}>
            Check original receipt
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void session.recover(true).catch(report)}
          >
            Retry retained operation
          </Button>
        </aside>
      )}
      {editor.state === 'conflict' && (
        <aside aria-label="Passage save conflict" className="rounded border p-3">
          <p>
            Your draft remains retained with its original revision. Download it before reconciling
            changed targets.
          </p>
          <Button
            type="button"
            onClick={() => {
              const value = { passage, document };
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(value)], { type: 'application/json' }),
              );
              const anchor = window.document.createElement('a');
              anchor.href = url;
              anchor.download = 'manuscript-passage-draft.json';
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          >
            Download retained passage
          </Button>
          <Button type="button" onClick={() => void session.recover().catch(report)}>
            Recover acknowledged operation
          </Button>
          <Button type="button" onClick={() => void session.inspectConflict().catch(report)}>
            Compare saved passage
          </Button>
          {editor.currentSaved && (
            <>
              <SemanticDocument
                document={editor.currentSaved.document}
                namedStyles={namedStyles ?? editor.currentSaved.passage.styles}
              />
              <Button type="button" onClick={() => void session.useSavedVersion().catch(report)}>
                Use saved passage and discard retained draft
              </Button>
            </>
          )}
        </aside>
      )}
      {rejected.pending && (
        <aside aria-label="Unsupported passage edit" className="rounded border p-3">
          <p role="alert">{rejected.error}</p>
          <Button type="button" onClick={rejected.download}>
            Download unsupported draft
          </Button>
          <Button type="button" variant="secondary" onClick={() => void rejected.discard()}>
            Discard unsupported edit
          </Button>
        </aside>
      )}
      {passage && document && (
        <>
          <nav aria-label="Scene passage navigation" className="proser-passage-navigation">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Previous passage"
              disabled={dirty || !previous.current.length}
              onClick={() => {
                const cursor = previous.current.pop();
                if (cursor) void session.navigate(cursor).catch(report);
              }}
            >
              <ChevronLeft aria-hidden="true" /> Earlier text
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Go to scene end"
              disabled={dirty}
              onClick={() => {
                previous.current.push(structuredClone(passage.cursor));
                void session
                  .load({
                    edge: 'last',
                    bookRevisionId: passage.bookRevisionId,
                    projection: passage.projection,
                  })
                  .catch(report);
              }}
            >
              <ChevronsRight aria-hidden="true" /> Scene end
            </Button>
            <span className="text-sm">
              {passage.paragraphs.length}{' '}
              {passage.paragraphs.length === 1 ? 'paragraph' : 'paragraphs'} shown
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Next passage"
              disabled={dirty || !passage.next}
              onClick={() => {
                previous.current.push(structuredClone(passage.cursor));
                void session.navigate(passage.next).catch(report);
              }}
            >
              Later text <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
          {!active && (
            <Button type="button" onClick={onActivate}>
              Edit this scene
            </Button>
          )}
          <div
            className={
              active ? `proser-writing-desk${reviewOpen ? ' proser-writing-desk--review' : ''}` : ''
            }
          >
            <div className="min-w-0">
              {passageHasPartialTable(passage) ? (
                <PartialPassageTable
                  passage={passage}
                  document={document}
                  actorId={actorId}
                  namedStyles={namedStyles}
                  editable={!readonly}
                  onChange={change}
                  onSelection={(value, reason) => {
                    setSelection(value);
                    setSelectionError(reason);
                  }}
                  onComposition={setComposing}
                  onError={setError}
                />
              ) : active ? (
                <CanvasDocumentEditor
                  document={document}
                  actorId={actorId}
                  showHistoryControls={false}
                  onInsertTable={insertToolbarTable}
                  showReviewControl={false}
                  editable={!readonly}
                  view={passage.projection}
                  onViewChange={(value) => void view(value)}
                  tracking={tracking}
                  onTrackingChange={setTracking}
                  namedStyles={namedStyles ?? passage.styles}
                  initialSelection={searchSelection ?? focus}
                  displayLayout={displayLayout}
                  displayStories={displayStories}
                  mobile={
                    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
                  }
                  onChange={change}
                  onError={setError}
                  onRejectedEdit={rejected.reject}
                  discardRejectedToken={rejected.discardToken}
                  onCompositionState={setComposing}
                  onDocumentSelection={(value, reason) => {
                    setSelection(value);
                    setSelectionError(reason);
                  }}
                  onUndo={() => void session.undoRevision().catch(report)}
                  onRedo={() => void session.redoRevision().catch(report)}
                  canUndo={editor.canUndo}
                  canRedo={editor.canRedo}
                  canResolveChange={canResolveChange}
                  onResolveChange={resolveTrackedChange}
                />
              ) : (
                <SemanticDocument
                  document={document}
                  view={passage.projection}
                  namedStyles={namedStyles ?? passage.styles}
                />
              )}
              {active && (
                <PlotThreadCapture
                  key={`${userId}:${bookId}:${sceneId}`}
                  userId={userId}
                  bookId={bookId}
                  selection={canonicalSelection}
                  flush={editor.flush}
                  disabled={
                    readonly ||
                    composing ||
                    editor.state === 'saving' ||
                    (tracking && Boolean(currentOps))
                  }
                />
              )}
            </div>
            {active && (
              <aside
                id={`manuscript-review-${sceneId}`}
                hidden={!reviewOpen}
                className="proser-review-panel"
              >
                <div className="proser-review-heading">
                  <h2>Manuscript tools</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Close review panel"
                    onClick={() => setReviewOpen(false)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <div role="tablist" aria-label="Manuscript tools" className="proser-review-tabs">
                  {(['discuss', 'review', 'comments', 'insert', 'context'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={reviewTab === tab}
                      tabIndex={reviewTab === tab ? 0 : -1}
                      onKeyDown={(event) => {
                        const tabs = [
                          'discuss',
                          'review',
                          'comments',
                          'insert',
                          'context',
                        ] as const;
                        const index = tabs.indexOf(tab);
                        const next =
                          event.key === 'ArrowRight'
                            ? (index + 1) % tabs.length
                            : event.key === 'ArrowLeft'
                              ? (index + tabs.length - 1) % tabs.length
                              : event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? tabs.length - 1
                                  : undefined;
                        if (next === undefined) return;
                        const nextTab = tabs[next];
                        if (!nextTab) return;
                        event.preventDefault();
                        setReviewTab(nextTab);
                        const buttons =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          );
                        buttons?.[next]?.focus();
                      }}
                      aria-controls={`manuscript-${sceneId}-${tab}`}
                      id={`manuscript-${sceneId}-tab-${tab}`}
                      onClick={() => setReviewTab(tab)}
                    >
                      {
                        {
                          discuss: 'Discuss',
                          review: 'Review',
                          comments: 'Comments',
                          insert: 'Insert',
                          context: 'Context',
                        }[tab]
                      }
                    </button>
                  ))}
                </div>
                <div
                  role="tabpanel"
                  id={`manuscript-${sceneId}-discuss`}
                  aria-labelledby={`manuscript-${sceneId}-tab-discuss`}
                  hidden={reviewTab !== 'discuss'}
                >
                  {tracking && currentOps && (
                    <p className="text-sm">
                      Save tracked edits before preparing discussion context.
                    </p>
                  )}
                  <BoundedDocumentDiscussion
                    passage={passage}
                    targets={displayedTargets}
                    selection={canonicalSelection}
                    selectionError={selectionError}
                    localOperations={currentOps}
                    sessionId={discussionSessionId}
                    draftKey={canonicalDocument({ document, source: passage.windowHash })}
                    flush={editor.flush}
                    retainLocalOperations={(local) => session.retainLocalOperations(local)}
                    refresh={async (receipt, beforeSceneRevisionId) => {
                      const committed = await session.acknowledgeExternalApplication(
                        receipt,
                        beforeSceneRevisionId,
                      );
                      setSelection(undefined);
                      onAcknowledged?.(committed);
                    }}
                    disabled={
                      readonly ||
                      composing ||
                      editor.state === 'saving' ||
                      (tracking && Boolean(currentOps))
                    }
                  />
                </div>
                <div
                  role="tabpanel"
                  id={`manuscript-${sceneId}-review`}
                  aria-labelledby={`manuscript-${sceneId}-tab-review`}
                  hidden={reviewTab !== 'review'}
                >
                  {!!passage.changeSummaries?.length && (
                    <section
                      aria-label="Passage review changes"
                      className="space-y-2 rounded border p-3"
                    >
                      <h2 className="font-semibold">Review changes</h2>
                      {passage.changeSummaries.map((change) => (
                        <div key={change.id}>
                          <p>
                            {change.authorName} · {change.kind} · {change.status}
                          </p>
                          {change.status === 'pending' && (
                            <>
                              <Button
                                type="button"
                                disabled={reviewDisabled}
                                onClick={() => void resolveTrackedChange(change.id, 'accepted')}
                              >
                                Accept
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={reviewDisabled}
                                onClick={() => void resolveTrackedChange(change.id, 'rejected')}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                        </div>
                      ))}
                    </section>
                  )}
                  <BoundedDocumentReview
                    bookId={bookId}
                    sceneId={sceneId}
                    session={session}
                    tracking={tracking}
                    disabled={readonly || composing || editor.state === 'saving'}
                    onPendingChange={setReviewPending}
                    onExternalApplied={async (current) => {
                      setSelection(undefined);
                      onAcknowledged?.(current);
                    }}
                  />
                </div>
                <div
                  role="tabpanel"
                  id={`manuscript-${sceneId}-comments`}
                  aria-labelledby={`manuscript-${sceneId}-tab-comments`}
                  hidden={reviewTab !== 'comments'}
                >
                  <DocumentPassageComments
                    userId={userId}
                    bookId={bookId}
                    passage={passage}
                    selection={selection}
                    disabled={readonly || composing || editor.state === 'saving'}
                    flush={editor.flush}
                    onPendingChange={setCommentPending}
                    onCommitted={async (current) => {
                      const previous = session.getSnapshot().passage;
                      if (!previous)
                        throw new Error(
                          'The current passage is unavailable. Recover the comment operation.',
                        );
                      session.adoptScopedPassage(current, previous.sceneRevisionId, 'comment');
                      setSelection(undefined);
                    }}
                  />
                </div>
                <div
                  role="tabpanel"
                  id={`manuscript-${sceneId}-insert`}
                  aria-labelledby={`manuscript-${sceneId}-tab-insert`}
                  hidden={reviewTab !== 'insert'}
                >
                  <DocumentPassageObjects
                    bookId={bookId}
                    passage={passage}
                    disabled={dirty || composing || readonly}
                    onOperations={operate}
                  />
                </div>
                <div
                  role="tabpanel"
                  id={`manuscript-${sceneId}-context`}
                  aria-labelledby={`manuscript-${sceneId}-tab-context`}
                  hidden={reviewTab !== 'context'}
                >
                  {sideContext}
                </div>
              </aside>
            )}
          </div>
        </>
      )}
    </section>
  );
}
