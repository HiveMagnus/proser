import {
  visibleRun,
  type DocumentPassage,
  type DocumentPassageSourceFrame,
} from '@cheftaco/proser-contracts';
import type { DocumentSelection } from './document-selection';
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validatePassageSource(
  passage: DocumentPassage,
  scope: { bookId: number; sceneId: number; bookRevisionId?: string },
): DocumentPassageSourceFrame {
  const frame = passage.sourceFrame;
  if (!frame) throw new Error('This passage has no Factory source frame.');
  if (
    passage.schemaVersion !== 1 ||
    !['final', 'original', 'markup'].includes(passage.projection) ||
    frame.projection !== passage.projection ||
    frame.bookId !== scope.bookId ||
    frame.sceneId !== scope.sceneId ||
    passage.sceneId !== scope.sceneId ||
    frame.bookRevisionId !== passage.bookRevisionId ||
    frame.sceneRevisionId !== passage.sceneRevisionId ||
    frame.sceneContentHash !== passage.contentHash ||
    (scope.bookRevisionId !== undefined && passage.bookRevisionId !== scope.bookRevisionId) ||
    ![frame.bookId, frame.actId, frame.chapterId, frame.sceneId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    !frame.bookRevisionId ||
    !frame.sceneRevisionId ||
    !frame.structureScope?.revisionId ||
    !frame.layoutScope?.revisionId ||
    ![
      frame.bookContentHash,
      frame.sceneContentHash,
      frame.qualifiedMembershipHash,
      frame.effectiveStyleLayoutHash,
      frame.structureScope.contentHash,
      frame.layoutScope.contentHash,
      passage.windowHash,
    ].every(digest)
  )
    throw new Error('The passage no longer matches its owned immutable source.');
  return frame;
}
export interface QualifiedPassageSelection {
  sourceFrame: DocumentPassageSourceFrame;
  windowHash: string;
  projection: 'final';
  ranges: Array<{
    blockId: string;
    runId: string;
    sourceHash: string;
    from: number;
    to: number;
    sourceText: string;
    container?: { tableId: string; rowId: string; cellId: string };
  }>;
}
/** Map only the supplied fragment/run identities; matching quotations cannot locate a target. */
export function qualifyPassageSelection(
  passage: DocumentPassage,
  selection: DocumentSelection,
  scope: { bookId: number; sceneId: number; bookRevisionId?: string },
): QualifiedPassageSelection {
  const sourceFrame = validatePassageSource(passage, scope);
  if (selection.projection !== 'final') throw new Error('Select the final working projection.');
  const targets = new Map(selection.targets.map((target) => [target.blockId, target]));
  if (targets.size !== selection.targets.length) throw new Error('Duplicate paragraph targets.');
  for (const target of targets.values()) {
    const fragments = passage.paragraphs.filter((item) => item.paragraph.id === target.blockId);
    if (fragments.length !== 1) throw new Error('The selected paragraph is outside this passage.');
    const fragment = fragments[0]!;
    const text = fragment.paragraph.runs
      .filter((run) => visibleRun(run, passage.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    if (
      target.from < 0 ||
      target.to < target.from ||
      target.to > text.length ||
      text.slice(target.from, target.to) !== target.sourceText
    )
      throw new Error('The selected text changed before mapping this passage.');
    const container = fragment.container;
    if (
      (container?.tableId ?? undefined) !== selection.container.tableId ||
      (container?.rowId ?? undefined) !== selection.container.rowId ||
      (container?.cellId ?? undefined) !== selection.container.cellId
    )
      throw new Error('The selected text belongs to a different table container.');
  }
  const seen = new Set<string>();
  const ranges = selection.runs.map((selected) => {
    const key = JSON.stringify([selected.blockId, selected.runId]);
    if (seen.has(key) || !targets.has(selected.blockId))
      throw new Error('The selection has incompatible run targets.');
    seen.add(key);
    const fragments = passage.paragraphs.filter((item) => item.paragraph.id === selected.blockId);
    const fragment = fragments[0]!;
    const runs = fragment.paragraph.runs.filter((run) => run.id === selected.runId);
    const sources = fragment.runs.filter((run) => run.runId === selected.runId);
    if (runs.length !== 1 || sources.length !== 1)
      throw new Error('The selected run is outside its immutable source slice.');
    const run = runs[0]!;
    if (run.inlineImage) throw new Error('The selected run is a protected inline object.');
    const source = sources[0]!;
    const target = targets.get(selected.blockId)!;
    let runStart = 0;
    for (const preceding of fragment.paragraph.runs) {
      if (preceding.id === run.id) break;
      if (visibleRun(preceding, passage.changes, 'final'))
        runStart += preceding.inlineImage ? 1 : preceding.text.length;
    }
    const expectedFrom = Math.max(0, target.from - runStart);
    const expectedTo = Math.min(run.text.length, target.to - runStart);
    if (selected.from !== expectedFrom || selected.to !== expectedTo || expectedTo < expectedFrom)
      throw new Error('The selected run does not cover its frozen paragraph target.');
    const boundaries = new Set([
      0,
      run.text.length,
      ...Array.from(
        new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(run.text),
        (segment) => segment.index,
      ),
    ]);
    if (
      run.inlineImage ||
      !visibleRun(run, passage.changes, 'final') ||
      !digest(source.sourceHash) ||
      source.to - source.from !== run.text.length ||
      source.from < 0 ||
      source.to > source.sourceLength ||
      !Number.isSafeInteger(selected.from) ||
      !Number.isSafeInteger(selected.to) ||
      selected.to < selected.from ||
      !boundaries.has(selected.from) ||
      !boundaries.has(selected.to)
    )
      throw new Error('The selection crosses a protected object or partial Unicode grapheme.');
    return {
      blockId: selected.blockId,
      runId: selected.runId,
      sourceHash: source.sourceHash,
      from: source.from + selected.from,
      to: source.from + selected.to,
      sourceText: run.text.slice(selected.from, selected.to),
      ...(fragment.container
        ? {
            container: {
              tableId: fragment.container.tableId,
              rowId: fragment.container.rowId,
              cellId: fragment.container.cellId,
            },
          }
        : {}),
    };
  });
  for (const [blockId, target] of targets) {
    const fragment = passage.paragraphs.find((item) => item.paragraph.id === blockId)!;
    let offset = 0;
    for (const run of fragment.paragraph.runs) {
      if (!visibleRun(run, passage.changes, 'final')) continue;
      const end = offset + (run.inlineImage ? 1 : run.text.length);
      if (
        end > target.from &&
        offset < target.to &&
        (run.inlineImage || !seen.has(JSON.stringify([blockId, run.id])))
      )
        throw new Error('The selection omits text or crosses a protected object.');
      offset = end;
    }
  }
  return {
    sourceFrame: structuredClone(sourceFrame),
    windowHash: passage.windowHash,
    projection: 'final',
    ranges,
  };
}
