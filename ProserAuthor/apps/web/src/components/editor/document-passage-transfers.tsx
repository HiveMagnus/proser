'use client';
import { useEffect, useRef, useState, useMemo } from 'react';
import {
  canonicalDocument,
  type DocumentPassage,
  type DocumentPassageRequest,
  type PassageScopeSource,
  type PassageScopeTransfer,
  type PassageScopeRestore,
  type PassageScopeReceipt,
  type SceneDocumentReference,
  type DocumentPassageReceipt,
  type DocumentPassageBookAcknowledgement,
  type DocumentPassageBookCommit,
} from '@cheftaco/proser-contracts';
import type { PassageTypedSession } from '@/lib/document-passage-typed-session';
import { passageParagraphSource, passageRunSource } from '@/lib/document-passage-document';
import { DocumentRequestError, requestDocumentResource } from '@/lib/document-api';
import {
  readPassageScopeJournal,
  writePassageScopeJournal,
  passageScopeJournalKey,
  type PassageScopeJournal,
} from '@/lib/document-passage-scope-journal';
import { SemanticDocument } from '@cheftaco/proser-editor';
import {
  adjacentPassageSelection,
  type AdjacentPassageRange,
} from '@/lib/document-adjacent-selection';
import { passageDocument } from '@/lib/document-passage-document';
import { Button } from '@/components/ui/button';
const sourceDescriptor = (passage: DocumentPassage): PassageScopeSource => {
  if (passage.projection !== 'final')
    throw new Error(
      'Switch both affected scenes to the working/final view before transferring content.',
    );
  if (!passage.sourceFrame) throw new Error('This passage has no owned source frame.');
  return {
    sceneId: passage.sceneId,
    expectedSceneRevisionId: passage.sceneRevisionId,
    sourceFrame: passage.sourceFrame,
    windowHash: passage.windowHash,
    window: {
      cursor: passage.cursor,
      maxCharacters: 8000,
      maxParagraphs: 24,
      maxRuns: 256,
      projection: 'final',
      reviewOffset: passage.reviewOffset,
    },
  };
};
async function boundaryHash(leftHash: string, rightHash: string) {
  const bytes = new TextEncoder().encode(canonicalDocument({ leftHash, rightHash }));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}
/** Commands disclose their complete scope while transporting only stable IDs.
 * One durable operation commits/restores both scopes atomically in Factory. */
export function DocumentPassageTransfers({
  userId,
  bookId,
  references,
  sessions,
  revision,
  disabled,
  onDirtyChange,
  onAcknowledged,
}: {
  userId: string;
  bookId: string;
  references: SceneDocumentReference[];
  sessions: Map<number, PassageTypedSession>;
  revision: number;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onAcknowledged?: (passage: DocumentPassage) => void;
}) {
  const [sourceId, setSourceId] = useState(references[0]?.sceneId),
    [destinationId, setDestinationId] = useState(references[1]?.sceneId);
  const [blocks, setBlocks] = useState<string[]>([]),
    [placement, setPlacement] = useState<'start' | 'end'>('end'),
    [paragraphId, setParagraphId] = useState(''),
    [caret, setCaret] = useState<number>();
  const preview = useRef<HTMLElement>(null);
  const [adjacentRanges, setAdjacentRanges] = useState<AdjacentPassageRange[]>([]);
  const [firstPart, setFirstPart] = useState(''),
    [secondPart, setSecondPart] = useState('');
  const [tracking, setTracking] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [journal, setJournal] = useState<PassageScopeJournal>(),
    [ready, setReady] = useState(false);
  const alive = useRef(true),
    row = useRef<PassageScopeJournal | undefined>(undefined),
    chain = useRef(Promise.resolve());
  const sceneIdKey = references.map((reference) => reference.sceneId).join(',');
  const sceneIds = useMemo(() => sceneIdKey.split(',').map(Number), [sceneIdKey]);
  const scope = passageScopeJournalKey(userId, bookId, sceneIds);
  useEffect(() => {
    alive.current = true;
    row.current = undefined;
    setReady(false);
    void readPassageScopeJournal(userId, bookId, sceneIds)
      .then((value) => {
        if (alive.current) {
          row.current = value;
          setJournal(value);
          setReady(true);
        }
      })
      .catch((failure) => {
        if (alive.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to read the scoped operation journal.',
          );
      });
    return () => {
      alive.current = false;
    };
  }, [scope, userId, bookId, sceneIds]);
  useEffect(
    () => onDirtyChange(Boolean(busy || journal?.pending)),
    [busy, journal?.pending, onDirtyChange],
  );
  const source = sessions.get(sourceId ?? 0)?.getSnapshot().passage;
  const destination = sessions.get(destinationId ?? 0)?.getSnapshot().passage;
  const selected =
    source?.paragraphs.find((item) => item.paragraph.id === paragraphId) ?? source?.paragraphs[0];
  const text =
    selected?.paragraph.runs.map((run) => (run.inlineImage ? '\ufffc' : run.text)).join('') ?? '';
  const loadExcerpt = async (
    sceneId: number | undefined,
    position: 'next' | 'beginning' | 'end',
  ) => {
    setError(undefined);
    setBusy(true);
    try {
      const editor = sessions.get(sceneId ?? 0);
      if (!editor) throw new Error('Load this scene before navigating its excerpts.');
      const saved = await editor.flush();
      const request: DocumentPassageRequest = {
        bookRevisionId: saved.bookRevisionId,
        maxCharacters: 8000,
        maxParagraphs: 24,
        maxRuns: 256,
        projection: 'final',
      };
      if (position === 'next') {
        if (!saved.next) throw new Error('This excerpt has no next passage.');
        request.cursor = saved.next;
      } else if (position === 'end') request.edge = 'last';
      else request.cursor = { item: 0, paragraph: 0, offset: 0 };
      setAdjacentRanges([]);
      setBlocks([]);
      setParagraphId('');
      setCaret(undefined);
      await editor.load(request);
      const loaded = editor.getSnapshot();
      if (loaded.state !== 'saved')
        throw new Error(loaded.error ?? 'Save or recover the loaded excerpt before continuing.');
      if (preview.current) preview.current.scrollTop = 0;
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : 'Unable to load the scene excerpt.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  // revision is the parent subscription signal; selections always use live snapshots.
  void revision;
  const persist = (next: PassageScopeJournal, acknowledgedOperationId?: string) => {
    chain.current = chain.current.then(async () => {
      await writePassageScopeJournal(next, row.current?.version, acknowledgedOperationId);
      if (alive.current) {
        row.current = next;
        setJournal(next);
      }
    });
    return chain.current;
  };
  const currentPair = async () => {
    if (!sourceId || !destinationId || sourceId === destinationId)
      throw new Error('Choose two different scenes.');
    const first = sessions.get(sourceId),
      second = sessions.get(destinationId);
    if (!first || !second) throw new Error('Both scene passages must be loaded.');
    await first.flush();
    await second.flush();
    const left = first.getSnapshot().passage!,
      right = second.getSnapshot().passage!;
    if (left.bookRevisionId !== right.bookRevisionId)
      throw new Error(
        'The scene passages have different book revisions. Reload the saved window before transferring content.',
      );
    return { left, right };
  };
  const normalizedReceipt = (
    raw: PassageScopeReceipt | DocumentPassageReceipt<DocumentPassageBookAcknowledgement>,
    intent: NonNullable<PassageScopeJournal['pending']>,
  ): PassageScopeReceipt => {
    if (intent.kind !== 'edit') return raw as PassageScopeReceipt;
    if ('scenes' in raw) throw new Error('The compound acknowledgement contains complete scenes.');
    const receipt = raw as DocumentPassageReceipt<DocumentPassageBookAcknowledgement>;
    if (!receipt.sceneReferences)
      throw new Error('The compound acknowledgement has no immutable scene references.');
    return {
      ...receipt,
      sceneReferences: receipt.sceneReferences,
      result: {
        passages: receipt.result.passages.map((item) => item.passage),
        sourceBookRevisionId: intent.request.expectedRevisionId,
        sceneIds: intent.request.scenes.map((item) => item.sceneId),
      },
    };
  };
  const dispatch = async (intent: NonNullable<PassageScopeJournal['pending']>) => {
    const raw = await requestDocumentResource<
      PassageScopeReceipt | DocumentPassageReceipt<DocumentPassageBookAcknowledgement>
    >(
      `/api/books/${encodeURIComponent(bookId)}/${intent.kind === 'transfer' ? 'document-passage-transfers' : intent.kind === 'edit' ? 'document-passage-commits' : 'document-passage-scope-restores'}`,
      { method: 'POST', body: JSON.stringify(intent.request) },
    );
    return normalizedReceipt(raw, intent);
  };
  const acknowledge = async (
    receipt: PassageScopeReceipt,
    intent: NonNullable<PassageScopeJournal['pending']>,
  ) => {
    const ids =
      intent.kind === 'transfer'
        ? [intent.request.source.sceneId, intent.request.destination.sceneId]
        : intent.request.scenes.map((item) => item.sceneId);
    if (
      receipt.kind !== 'catalog' ||
      receipt.status !== 'completed' ||
      receipt.operationId !== intent.request.operationId ||
      receipt.result.sourceBookRevisionId !== intent.request.expectedRevisionId ||
      receipt.result.passages.length !== ids.length ||
      'scenes' in receipt ||
      canonicalDocument([...receipt.result.sceneIds].sort()) !== canonicalDocument([...ids].sort())
    )
      throw new Error('Factory returned an incompatible scoped operation receipt.');
    for (const passage of receipt.result.passages) {
      const reference = receipt.sceneReferences.find((item) => item.sceneId === passage.sceneId);
      if (
        !ids.includes(passage.sceneId) ||
        passage.bookRevisionId !== receipt.revisionId ||
        passage.sceneRevisionId !== reference?.revisionId ||
        passage.contentHash !== reference?.contentHash ||
        passage.sourceFrame?.bookId !== Number(bookId)
      )
        throw new Error('The scoped receipt does not match its immutable scene references.');
    }
    const before = row.current;
    if (!before || before.pending?.request.operationId !== intent.request.operationId)
      throw new Error('The retained scope operation changed.');
    const committedSceneRevisions = Object.fromEntries(
      receipt.sceneReferences.map((item) => [String(item.sceneId), item.revisionId]),
    );
    let history = before.history,
      redo = before.redo;
    if (intent.kind === 'transfer' || intent.kind === 'edit') {
      history = [
        ...history,
        {
          beforeBookRevisionId: intent.request.expectedRevisionId,
          afterBookRevisionId: receipt.revisionId,
          sceneIds: ids,
          sceneRevisions: committedSceneRevisions,
        },
      ].slice(-100);
      redo = [];
    } else if (intent.direction === 'undo') {
      const last = history.at(-1);
      if (!last) throw new Error('The undo journal changed.');
      history = history.slice(0, -1);
      redo = [
        ...redo,
        {
          ...last,
          afterBookRevisionId: intent.request.expectedRevisionId,
          sceneRevisions: committedSceneRevisions,
        },
      ];
    } else {
      const last = redo.at(-1);
      if (!last) throw new Error('The redo journal changed.');
      redo = redo.slice(0, -1);
      history = [
        ...history,
        {
          ...last,
          afterBookRevisionId: receipt.revisionId,
          sceneRevisions: committedSceneRevisions,
        },
      ];
    }
    await persist(
      {
        ...before,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        history,
        redo,
        pending: undefined,
      },
      intent.request.operationId,
    );
    if (!alive.current) return;
    const inputs =
      intent.kind === 'transfer'
        ? [intent.request.source, intent.request.destination]
        : intent.request.scenes;
    for (const passage of receipt.result.passages) {
      const input = inputs.find((item) => item.sceneId === passage.sceneId)!;
      const editor = sessions.get(passage.sceneId);
      if (editor?.getSnapshot().passage?.sceneRevisionId === input.expectedSceneRevisionId)
        editor.adoptScopedPassage(passage, input.expectedSceneRevisionId);
      else await editor?.load({ cursor: passage.cursor, bookRevisionId: receipt.revisionId });
      onAcknowledged?.(passage);
    }
  };
  const run = async (intent: NonNullable<PassageScopeJournal['pending']>) => {
    if (busy || row.current?.pending) return;
    setBusy(true);
    setError(undefined);
    try {
      const base = row.current ?? {
        key: scope,
        userId,
        bookId,
        sceneIds,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        history: [],
        redo: [],
      };
      await persist({
        ...base,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        pending: intent,
      });
      if (!alive.current) return;
      const receipt = await dispatch(intent);
      if (alive.current) await acknowledge(receipt, intent);
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : 'Scope operation outcome unknown.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const recover = async (retryAbsent = false) => {
    const intent = row.current?.pending;
    if (!intent || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      let receipt: PassageScopeReceipt | undefined;
      try {
        const raw = await requestDocumentResource<
          PassageScopeReceipt | DocumentPassageReceipt<DocumentPassageBookAcknowledgement>
        >(
          `/api/books/${encodeURIComponent(bookId)}/document-operations/${encodeURIComponent(intent.request.operationId)}`,
        );
        receipt = normalizedReceipt(raw, intent);
      } catch (failure) {
        if (!(failure instanceof DocumentRequestError && failure.status === 404)) throw failure;
      }
      if (!alive.current) return;
      if (!receipt && !retryAbsent) {
        setError(
          'Factory has no completed receipt. Retry the exact retained operation explicitly.',
        );
        return;
      }
      receipt ??= await dispatch(intent);
      if (alive.current) await acknowledge(receipt, intent);
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to recover the original scope operation.',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const transfer = async (kind: PassageScopeTransfer['kind']) => {
    try {
      const { left, right } = await currentPair();
      const base = {
        schemaVersion: 1 as const,
        operationId: crypto.randomUUID(),
        expectedRevisionId: left.bookRevisionId,
        source: sourceDescriptor(left),
        destination: sourceDescriptor(right),
      };
      if (kind === 'move-blocks') {
        const selectedBlocks = blocks.map((blockId) => {
          const item = left.items?.find(
            (item) =>
              (item.type === 'paragraph'
                ? left.paragraphs[item.paragraphIndex]!.paragraph.id
                : item.type === 'image'
                  ? item.image.id
                  : item.type === 'pageBreak'
                    ? item.pageBreak.id
                    : item.id) === blockId,
          );
          if (!item) throw new Error('A selected whole block left the source passage.');
          return { blockId, sourceHash: item.placement.before.neighborHash };
        });
        await run({
          kind: 'transfer',
          request: { ...base, kind, blocks: selectedBlocks, placement },
        });
      } else if (kind === 'split-scene') {
        if (!selected || caret === undefined)
          throw new Error('Place a caret in the source paragraph fragment.');
        let offset = 0;
        const targets = selected.paragraph.runs.flatMap((run) => {
          const start = offset;
          offset += run.inlineImage ? 1 : run.text.length;
          return !run.inlineImage && caret >= start && caret <= offset ? [{ run, start }] : [];
        });
        if (targets.length !== 1) throw new Error('Choose a caret inside one exact styled run.');
        const target = passageRunSource(left, selected.paragraph.id, targets[0]!.run.id),
          position = target.from + caret - targets[0]!.start;
        await run({
          kind: 'transfer',
          request: {
            ...base,
            kind,
            target: { ...target, from: position, to: position },
            expectedText: '',
          },
        });
      } else {
        const last = left.items?.at(-1),
          first = right.items?.[0];
        if (
          left.next ||
          last?.type !== 'paragraph' ||
          first?.type !== 'paragraph' ||
          right.cursor.offset !== 0 ||
          (right.cursor.run ?? 0) !== 0 ||
          right.paragraphs[0]?.continuedBefore ||
          (right.cursor.item ?? right.cursor.paragraph) !== 0
        )
          throw new Error(
            'Load the source scene end and destination scene beginning before joining.',
          );
        const leftParagraph = left.paragraphs[last.paragraphIndex]!,
          rightParagraph = right.paragraphs[first.paragraphIndex]!;
        await run({
          kind: 'transfer',
          request: {
            ...base,
            kind,
            left: passageParagraphSource(left, leftParagraph.paragraph.id),
            right: passageParagraphSource(right, rightParagraph.paragraph.id),
            boundaryHash: await boundaryHash(
              last.placement.before.neighborHash,
              first.placement.before.neighborHash,
            ),
            tracking,
          },
        });
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The transfer target changed.');
    }
  };
  const captureAdjacent = () => {
    try {
      const range = window.getSelection();
      const left = sessions.get(sourceId ?? 0)?.getSnapshot().passage,
        right = sessions.get(destinationId ?? 0)?.getSnapshot().passage;
      if (!left || !right || !preview.current || !range?.rangeCount)
        throw new Error('Select text in the bounded adjacent preview.');
      if (
        references.findIndex((item) => item.sceneId === right.sceneId) !==
          references.findIndex((item) => item.sceneId === left.sceneId) + 1 ||
        left.next ||
        (right.cursor.item ?? right.cursor.paragraph) !== 0 ||
        (right.cursor.run ?? 0) !== 0 ||
        right.paragraphs[0]?.continuedBefore ||
        right.cursor.offset !== 0
      )
        throw new Error('Load the adjacent source end and destination beginning before selecting.');
      setAdjacentRanges(
        adjacentPassageSelection(preview.current, range.getRangeAt(0), [left, right]),
      );
      setError(undefined);
    } catch (failure) {
      setAdjacentRanges([]);
      setError(failure instanceof Error ? failure.message : 'The adjacent selection is stale.');
    }
  };
  const compoundPaste = async () => {
    try {
      const { left, right } = await currentPair();
      if (!adjacentRanges.length)
        throw new Error('Select both adjacent excerpts before applying multipart text.');
      const scopes = [left, right].map((passage, index) => {
        const ranges = adjacentRanges.filter((range) => range.sceneId === passage.sceneId);
        if (!ranges.length) throw new Error('An affected scene has no qualified selection.');
        return {
          sceneId: passage.sceneId,
          expectedSceneRevisionId: passage.sceneRevisionId,
          sourceFrame: passage.sourceFrame!,
          windowHash: passage.windowHash,
          cursor: passage.cursor,
          maxCharacters: 8000,
          maxParagraphs: 24,
          maxRuns: 256,
          reviewOffset: passage.reviewOffset,
          tracking,
          operations: ranges.map((range, part) => ({
            id: crypto.randomUUID(),
            kind: 'text' as const,
            target: range.target,
            expectedText: range.expectedText,
            replacement: part === 0 ? (index === 0 ? firstPart : secondPart) : '',
          })),
        };
      });
      const request: DocumentPassageBookCommit = {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevisionId: left.bookRevisionId,
        scenes: scopes,
      };
      await run({ kind: 'edit', request });
      setAdjacentRanges([]);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The multipart paste requires reconciliation.',
      );
    }
  };
  const restore = async (direction: 'undo' | 'redo') => {
    try {
      const entry = (direction === 'undo' ? row.current?.history : row.current?.redo)?.at(-1);
      if (!entry) return;
      const loaded = await Promise.all(
        entry.sceneIds.map(async (id) => {
          const editor = sessions.get(id);
          if (!editor) throw new Error('Load the affected scene window before restoring.');
          return editor.flush();
        }),
      );
      if (
        !entry.sceneRevisions ||
        loaded.some(
          (passage) => entry.sceneRevisions?.[String(passage.sceneId)] !== passage.sceneRevisionId,
        )
      )
        throw new Error(
          'Newer scene work supersedes this window operation. Undo those later edits before restoring the complete scopes.',
        );
      const bookRevisionId = loaded[0]!.bookRevisionId;
      if (loaded.some((item) => item.bookRevisionId !== bookRevisionId))
        throw new Error('Reload the saved window before restoring both scopes.');
      const request: PassageScopeRestore = {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevisionId: bookRevisionId,
        restoreFromBookRevisionId:
          direction === 'undo' ? entry.beforeBookRevisionId : entry.afterBookRevisionId,
        scenes: loaded.map(sourceDescriptor),
      };
      await run({ kind: 'restore', request, direction });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to restore the scoped revision.',
      );
    }
  };
  return (
    <section
      aria-label="Atomic scene transfers"
      className="space-y-4 rounded border border-border-muted p-4 [&_select]:rounded [&_select]:border [&_select]:border-border-muted [&_select]:bg-surface-base [&_select]:px-2 [&_select]:min-h-11 [&_textarea]:block [&_textarea]:w-full [&_textarea]:min-h-24 [&_textarea]:rounded [&_textarea]:border [&_textarea]:border-border-muted [&_textarea]:bg-surface-base [&_textarea]:p-2"
    >
      <h2 className="font-semibold">Move and edit scene boundaries</h2>
      {error && <p role="alert">{error}</p>}
      {journal?.pending && (
        <aside aria-label="Recover scene transfer">
          <p>The exact scope operation remains retained. Recover it before changing scenes.</p>
          <Button type="button" disabled={busy} onClick={() => void recover()}>
            Check original transfer receipt
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void recover(true)}
          >
            Retry retained transfer
          </Button>
        </aside>
      )}
      <fieldset
        disabled={!ready || disabled || busy || Boolean(journal?.pending)}
        className="space-y-3"
      >
        <div className="flex flex-wrap gap-3">
          <label>
            Source scene{' '}
            <select
              aria-label="Transfer source scene"
              value={sourceId}
              onChange={(event) => {
                setSourceId(Number(event.target.value));
                setBlocks([]);
                setParagraphId('');
                setCaret(undefined);
                setAdjacentRanges([]);
              }}
            >
              {references.map((reference) => (
                <option key={reference.sceneId} value={reference.sceneId}>
                  Scene {reference.sceneNumber}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination scene{' '}
            <select
              aria-label="Transfer destination scene"
              value={destinationId}
              onChange={(event) => {
                setDestinationId(Number(event.target.value));
                setAdjacentRanges([]);
              }}
            >
              {references.map((reference) => (
                <option key={reference.sceneId} value={reference.sceneId}>
                  Scene {reference.sceneNumber}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadExcerpt(sourceId, 'end')}
          >
            Load source scene end
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadExcerpt(destinationId, 'beginning')}
          >
            Load destination beginning
          </Button>
        </div>
        <label className="block">
          Whole blocks to move{' '}
          <select
            aria-label="Whole blocks to transfer"
            className="mt-2 block w-full min-h-24 p-2"
            multiple
            value={blocks}
            onChange={(event) =>
              setBlocks(Array.from(event.target.selectedOptions, (option) => option.value))
            }
          >
            {source?.items?.map((item, index) => {
              const id =
                item.type === 'paragraph'
                  ? source.paragraphs[item.paragraphIndex]!.paragraph.id
                  : item.type === 'image'
                    ? item.image.id
                    : item.type === 'pageBreak'
                      ? item.pageBreak.id
                      : item.id;
              return (
                <option key={id} value={id}>
                  {index + 1}. Entire {item.type === 'tableSlice' ? 'table' : item.type}
                  {item.type === 'paragraph' &&
                  (source.paragraphs[item.paragraphIndex]!.continuedBefore ||
                    source.paragraphs[item.paragraphIndex]!.continuedAfter)
                    ? ' (includes text beyond this fragment)'
                    : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          Position{' '}
          <select
            value={placement}
            onChange={(event) => setPlacement(event.target.value as 'start' | 'end')}
          >
            <option value="start">Destination beginning</option>
            <option value="end">Destination end</option>
          </select>
        </label>
        <Button
          type="button"
          disabled={!blocks.length}
          onClick={() => void transfer('move-blocks')}
        >
          Move whole selected blocks atomically
        </Button>
        <section
          aria-label="Adjacent scene selection and multipart paste"
          className="space-y-3 border-t border-border-muted pt-3"
        >
          <h3 className="font-semibold">Adjacent selection and multipart paste</h3>
          <p>
            Load the source scene end and destination beginning, then select text across the two
            excerpts. Each replacement part stays in its own scene; both scenes commit together.
          </p>
          <p id="adjacent-excerpts-scroll-help" className="text-sm text-text-muted">
            Scroll this box to read both excerpts. Use the next excerpt controls when a scene
            continues. Focus the box to scroll with the arrow keys or Page Down.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!source?.next}
              onClick={() => void loadExcerpt(sourceId, 'next')}
            >
              Next source excerpt
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!destination?.next}
              onClick={() => void loadExcerpt(destinationId, 'next')}
            >
              Next destination excerpt
            </Button>
          </div>
          {source && destination && (
            <section
              ref={preview}
              aria-label="Adjacent saved scene excerpts"
              aria-describedby="adjacent-excerpts-scroll-help"
              tabIndex={0}
              onMouseUp={captureAdjacent}
              className="max-h-80 overflow-auto overscroll-contain rounded border p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary [&_p]:break-words"
            >
              {[source, destination].map((passage, index) => (
                <div
                  key={`${index}-${passage.sceneId}`}
                  data-scene-id={passage.sceneId}
                  data-excerpt-role={index === 0 ? 'source' : 'destination'}
                  className="space-y-2 py-3"
                >
                  <h4 className="font-medium">
                    {index === 0 ? 'Source' : 'Destination'} scene{' '}
                    {references.find((item) => item.sceneId === passage.sceneId)?.sceneNumber}
                  </h4>
                  {(passage.cursor.offset > 0 ||
                    (passage.cursor.item ?? passage.cursor.paragraph) > 0 ||
                    (passage.cursor.run ?? 0) > 0 ||
                    passage.paragraphs[0]?.continuedBefore) && (
                    <p className="text-sm text-text-muted">
                      Earlier scene text precedes this excerpt.
                    </p>
                  )}
                  <SemanticDocument
                    document={passageDocument(passage)}
                    namedStyles={passage.styles}
                  />
                  <p className="text-sm text-text-muted">
                    {passage.next || passage.paragraphs.at(-1)?.continuedAfter
                      ? `${index === 0 ? 'Source' : 'Destination'} scene continues in the next excerpt.`
                      : `End of ${index === 0 ? 'source' : 'destination'} scene.`}
                  </p>
                </div>
              ))}
            </section>
          )}
          <p role="status">{adjacentRanges.length} qualified styled ranges selected.</p>
          <label>
            Source scene replacement
            <textarea
              aria-label="Source scene paste part"
              value={firstPart}
              onChange={(event) => setFirstPart(event.target.value)}
              maxLength={16000}
            />
          </label>
          <label>
            Destination scene replacement
            <textarea
              aria-label="Destination scene paste part"
              value={secondPart}
              onChange={(event) => setSecondPart(event.target.value)}
              maxLength={16000}
            />
          </label>
          <textarea
            aria-label="Paste two scene parts"
            placeholder="Paste two parts separated by a line containing ---scene---"
            onPaste={(event) => {
              const parts = event.clipboardData
                .getData('text/plain')
                .split(/\r?\n---scene---\r?\n/);
              if (parts.length !== 2) {
                setError('Paste exactly two scene parts separated by ---scene--- on its own line.');
                return;
              }
              event.preventDefault();
              setFirstPart(parts[0]!);
              setSecondPart(parts[1]!);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={tracking}
              onChange={(event) => setTracking(event.target.checked)}
            />{' '}
            Track multipart text for review
          </label>
          <Button
            type="button"
            disabled={!adjacentRanges.length}
            onClick={() => void compoundPaste()}
          >
            Apply multipart text atomically
          </Button>
        </section>
        <label>
          Split source paragraph{' '}
          <select
            aria-label="Scene split paragraph"
            value={selected?.paragraph.id ?? ''}
            onChange={(event) => {
              setParagraphId(event.target.value);
              setCaret(undefined);
            }}
          >
            {source?.paragraphs
              .filter((item) => !item.container)
              .map((item) => (
                <option key={item.paragraph.id} value={item.paragraph.id}>
                  Paragraph {item.ordinal + 1}
                </option>
              ))}
          </select>
        </label>
        {selected && (
          <textarea
            aria-label="Atomic scene split caret"
            value={text}
            readOnly
            className="block w-full rounded border p-2"
            onSelect={(event) =>
              setCaret(
                event.currentTarget.selectionStart === event.currentTarget.selectionEnd
                  ? event.currentTarget.selectionStart
                  : undefined,
              )
            }
          />
        )}
        <p className="text-sm">
          Splitting transfers everything after the caret to the adjacent destination scene. Joining
          combines the source scene’s last paragraph with the destination scene’s first paragraph.
          Both scenes save together.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={caret === undefined}
            onClick={() => void transfer('split-scene')}
          >
            Split scene at caret
          </Button>
          <label>
            <input
              type="checkbox"
              checked={tracking}
              onChange={(event) => setTracking(event.target.checked)}
            />{' '}
            Track boundary join
          </label>
          <Button type="button" onClick={() => void transfer('join-scenes')}>
            Join scene boundary
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!journal?.history.length}
            onClick={() => void restore('undo')}
          >
            Undo last scene transfer
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!journal?.redo.length}
            onClick={() => void restore('redo')}
          >
            Redo scene transfer
          </Button>
        </div>
      </fieldset>
    </section>
  );
}
