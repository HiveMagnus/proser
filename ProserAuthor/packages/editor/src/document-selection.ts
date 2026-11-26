import type CanvasEditor from '@hivemagnus/canvas-word-engine';
import { ElementType, SurroundPosition } from '@hivemagnus/canvas-word-engine';
import type { IElement } from '@hivemagnus/canvas-word-engine';
import type { DocumentTargetInput } from '@hivemagnus/proser-contracts';
import { identityOf } from './canvas-adapter';
import {
  visibleParagraph,
  visibleRun,
  type ProserDocument,
  type DocumentParagraph,
} from './document-model';

export interface DocumentSelection {
  projection: 'final';
  targets: DocumentTargetInput[];
  runs: Array<{ blockId: string; runId: string; from: number; to: number }>;
  container: { tableId?: string; rowId?: string; cellId?: string };
}
type SelectionCommand = Pick<
  CanvasEditor['command'],
  'getRange' | 'getRangeContext' | 'getSurroundElementList' | 'getRuntimeElementList'
>;
/** Semantic input offsets use the same canonical targets as Canvas. The complete
 * input value is checked, so stale DOM text cannot relocate an anchor. */
export function paragraphSelection(
  document: ProserDocument,
  blockId: string,
  from: number,
  to: number,
  inputValue: string,
  retainCaret = false,
): DocumentSelection | undefined {
  if (from === to && !retainCaret) return undefined;
  let paragraph: DocumentParagraph | undefined;
  const container: DocumentSelection['container'] = {};
  for (const block of document.blocks) {
    if (block.type === 'paragraph' && block.id === blockId) paragraph = block;
    if (block.type === 'table')
      for (const row of block.rows)
        for (const cell of row.cells) {
          const found = cell.paragraphs.find((item) => item.id === blockId);
          if (found) {
            paragraph = found;
            Object.assign(container, { tableId: block.id, rowId: row.id, cellId: cell.id });
          }
        }
  }
  if (!paragraph || !visibleParagraph(paragraph, document.changes, 'final'))
    throw new Error('The selected paragraph is stale. Select the text again.');
  const visible = paragraph.runs.filter((run) => visibleRun(run, document.changes, 'final'));
  const text = visible.map((run) => (run.inlineImage ? '\ufffc' : run.text)).join('');
  if (
    text !== inputValue ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > text.length
  )
    throw new Error(
      'The selection no longer matches the canonical document. Select the text again.',
    );
  const boundaries = new Set([0]);
  for (const { index, segment } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(text))
    boundaries.add(index + segment.length);
  if (!boundaries.has(from) || !boundaries.has(to))
    throw new Error('The selection splits a Unicode grapheme. Select the complete character.');
  let offset = 0;
  const runs: DocumentSelection['runs'] = [];
  for (const run of visible) {
    const end = offset + (run.inlineImage ? 1 : run.text.length);
    if (run.inlineImage && end > from && offset < to)
      throw new Error('This selection crosses a protected inline image. Select text beside it.');
    if (end > from && offset < to)
      runs.push({
        blockId,
        runId: run.id,
        from: Math.max(0, from - offset),
        to: Math.min(run.text.length, to - offset),
      });
    offset = end;
  }
  return {
    projection: 'final',
    targets: [{ blockId, from, to, sourceText: text.slice(from, to) }],
    runs,
    container,
  };
}
const inline = (elements: IElement[]): IElement[] =>
  elements.flatMap((element) =>
    [ElementType.HYPERLINK, ElementType.TITLE, ElementType.LIST].includes(element.type!) &&
    element.valueList
      ? inline(element.valueList)
      : [element],
  );

/** Convert the current runtime range once. No runtime index or quotation lookup
 * is retained as an anchor. Offsets are UTF-16 and must also bound graphemes. */
export function canvasSelection(
  command: SelectionCommand,
  document: ProserDocument,
  retainCaret = false,
): DocumentSelection | undefined {
  const range = command.getRange();
  if (range.startIndex < 0 || range.endIndex < 0) return undefined;
  if (range.startIndex === range.endIndex && !range.isCrossRowCol && !retainCaret) return undefined;
  const context = command.getRangeContext();
  if (!context || (context.isCollapsed && !retainCaret)) return undefined;
  if (context.zone !== 'main')
    throw new Error('Select body text; header and footer targets require a separate story.');
  if (range.isCrossRowCol)
    throw new Error('Select text within one table cell before preparing a text proposal.');
  let paragraphs: DocumentParagraph[];
  const container: DocumentSelection['container'] = {};
  if (context.isTable) {
    const tableId = context.tableElement && identityOf(context.tableElement)?.blockId;
    const table = document.blocks.find((block) => block.type === 'table' && block.id === tableId);
    if (!table || table.type !== 'table' || context.trIndex === null || context.tdIndex === null)
      throw new Error('The selected table identity is stale. Select the text again.');
    const row = table.rows[context.trIndex];
    const cell = row?.cells[context.tdIndex];
    if (!row || !cell) throw new Error('The selected table cell is stale. Select the text again.');
    Object.assign(container, { tableId: table.id, rowId: row.id, cellId: cell.id });
    paragraphs = cell.paragraphs;
  } else
    paragraphs = document.blocks.filter(
      (block): block is DocumentParagraph => block.type === 'paragraph',
    );
  const sources = new Map(
    paragraphs
      .filter((paragraph) => visibleParagraph(paragraph, document.changes, 'final'))
      .map((paragraph) => [paragraph.id, paragraph]),
  );
  const texts = new Map(
    [...sources].map(([blockId, paragraph]) => [
      blockId,
      paragraph.runs
        .filter((run) => visibleRun(run, document.changes, 'final'))
        .map((run) => (run.inlineImage ? '\ufffc' : run.text))
        .join(''),
    ]),
  );
  const prefix = inline(
    command.getSurroundElementList({
      direction: SurroundPosition.BEFORE,
      length: range.startIndex + 1,
    }) ?? [],
  );
  const selected = inline(context.selectionElementList);
  const before = new Map<string, string>();
  const chosen = new Map<string, string>();
  const runIds = new Map<string, Set<string>>();
  const read = (element: IElement, selection: boolean) => {
    const identity = identityOf(element);
    if (identity?.kind === 'boundary') {
      if (selection && sources.has(identity.blockId) && !chosen.has(identity.blockId))
        chosen.set(identity.blockId, '');
      return;
    }
    if (!identity) {
      if (element.value === '\u0000' || element.value === '') return;
      if (
        !selection &&
        [ElementType.TABLE, ElementType.IMAGE, ElementType.PAGE_BREAK].includes(element.type!)
      )
        return;
      throw new Error(
        'The selection or preceding text lacks a stable identity. Save and select it again.',
      );
    }
    if (identity.kind === 'inlineImage') {
      if (selection)
        throw new Error('This selection crosses a protected inline image. Select text beside it.');
      const paragraph = sources.get(identity.blockId);
      const run = paragraph?.runs.find((run) => run.id === identity.runId && run.inlineImage);
      if (
        !run ||
        run.inlineImage!.assetId !== identity.assetId ||
        run.inlineImage!.sha256 !== identity.sha256
      )
        throw new Error('The inline image identity changed. Select the text again.');
      before.set(identity.blockId, (before.get(identity.blockId) ?? '') + '\ufffc');
      return;
    }
    if (
      identity.kind !== 'run' &&
      identity.kind !== 'lineBreak' &&
      identity.kind !== 'emptyParagraph'
    ) {
      if (selection)
        throw new Error(
          'This selection crosses a protected object. Select text within paragraphs or one table cell.',
        );
      return;
    }
    const paragraph = sources.get(identity.blockId);
    if (!paragraph) {
      if (selection)
        throw new Error('The selected paragraph identity is stale. Select the text again.');
      return;
    }
    const value =
      identity.kind === 'emptyParagraph'
        ? ''
        : identity.kind === 'lineBreak'
          ? element.value.replaceAll('\u0000', '\n')
          : element.value === '\u0000' &&
              paragraph.runs.find((run) => run.id === identity.runId)?.text === ''
            ? ''
            : element.value;
    if (
      value &&
      (!identity.runId ||
        !paragraph.runs.some(
          (run) => run.id === identity.runId && visibleRun(run, document.changes, 'final'),
        ))
    )
      throw new Error('The selected run identity is stale. Save and select the text again.');
    const destination = selection ? chosen : before;
    destination.set(paragraph.id, (destination.get(paragraph.id) ?? '') + value);
    if (selection && identity.runId) {
      if (!runIds.has(paragraph.id)) runIds.set(paragraph.id, new Set());
      runIds.get(paragraph.id)!.add(identity.runId);
    }
  };
  for (const element of prefix) read(element, false);
  for (const element of selected) read(element, true);
  if (context.isCollapsed && retainCaret) {
    const start = identityOf(context.startElement);
    const followingElement = !start
      ? command.getRuntimeElementList()[range.startIndex + 1]
      : undefined;
    const following = followingElement ? identityOf(followingElement) : undefined;
    const blockId = start?.blockId ?? following?.blockId;
    if (!blockId || !sources.has(blockId))
      throw new Error('The caret paragraph identity is stale. Select it again.');
    chosen.set(blockId, '');
  }
  const targets: DocumentTargetInput[] = [];
  const runs: DocumentSelection['runs'] = [];
  for (const [blockId, sourceText] of chosen) {
    const text = texts.get(blockId)!;
    const preceding = before.get(blockId) ?? '';
    const from = preceding.length;
    const to = from + sourceText.length;
    if (!text.startsWith(preceding) || text.slice(from, to) !== sourceText || to > text.length)
      throw new Error(
        'The selection no longer matches the canonical document. Save and select it again.',
      );
    const boundaries = new Set([0]);
    for (const { index, segment } of new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(text))
      boundaries.add(index + segment.length);
    if (!boundaries.has(from) || !boundaries.has(to))
      throw new Error('The selection splits a Unicode grapheme. Select the complete character.');
    targets.push({ blockId, from, to, sourceText });
    let offset = 0;
    for (const run of sources
      .get(blockId)!
      .runs.filter((item) => visibleRun(item, document.changes, 'final'))) {
      const end = offset + (run.inlineImage ? 1 : run.text.length);
      if (run.inlineImage && end > from && offset < to)
        throw new Error('This selection crosses a protected inline image. Select text beside it.');
      if (end > from && offset < to && runIds.get(blockId)?.has(run.id))
        runs.push({
          blockId,
          runId: run.id,
          from: Math.max(0, from - offset),
          to: Math.min(run.text.length, to - offset),
        });
      offset = end;
    }
  }
  return targets.length ? { projection: 'final', targets, runs, container } : undefined;
}

type RestoreCommand = Pick<
  CanvasEditor['command'],
  | 'getRuntimeElementList'
  | 'getElementById'
  | 'executeSetPositionContext'
  | 'executeSetRange'
  | 'executeFocus'
>;
/** Restore a frozen canonical selection by identity and Unicode boundaries.
 * Runtime indices are computed afresh and discarded after this call. */
export function restoreCanvasSelection(
  command: RestoreCommand,
  document: ProserDocument,
  selection: DocumentSelection,
): void {
  if (!selection.targets.length) throw new Error('The saved selection has no targets.');
  let paragraphs = document.blocks.filter(
    (block): block is DocumentParagraph => block.type === 'paragraph',
  );
  const container = selection.container;
  let tableId: string | undefined;
  let rowIndex: number | undefined;
  let cellIndex: number | undefined;
  if (container.tableId) {
    const table = document.blocks.find(
      (block) => block.type === 'table' && block.id === container.tableId,
    );
    if (!table || table.type !== 'table')
      throw new Error('The selected table identity changed. Select it again.');
    const row = table.rows.find((item) => item.id === container.rowId);
    const cell = row?.cells.find((item) => item.id === container.cellId);
    if (!row || !cell) throw new Error('The selected cell identity changed. Select it again.');
    paragraphs = cell.paragraphs;
    const runtimeTable = command
      .getElementById({ id: table.id })
      .find(
        (element) =>
          element.type === ElementType.TABLE && identityOf(element)?.blockId === table.id,
      );
    if (!runtimeTable?.id) throw new Error('The runtime table no longer matches this selection.');
    rowIndex = runtimeTable.trList?.findIndex((item) => item.id === row.id);
    cellIndex =
      rowIndex !== undefined && rowIndex >= 0
        ? runtimeTable.trList?.[rowIndex]?.tdList.findIndex((item) => item.id === cell.id)
        : undefined;
    if (rowIndex === undefined || rowIndex < 0 || cellIndex === undefined || cellIndex < 0)
      throw new Error('The runtime cell no longer matches this selection.');
    tableId = runtimeTable.id;
  }
  const sources = new Map(
    paragraphs
      .filter((paragraph) => visibleParagraph(paragraph, document.changes, 'final'))
      .map((paragraph) => [paragraph.id, paragraph]),
  );
  for (const target of selection.targets) {
    const paragraph = sources.get(target.blockId);
    if (!paragraph)
      throw new Error('The selected paragraph changed its container. Select it again.');
    const text = paragraph.runs
      .filter((run) => visibleRun(run, document.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    const verified = paragraphSelection(
      document,
      target.blockId,
      target.from,
      target.to,
      text,
      true,
    );
    if (
      !verified ||
      text.slice(target.from, target.to) !== target.sourceText ||
      ['tableId', 'rowId', 'cellId'].some(
        (key) =>
          verified.container[key as keyof typeof verified.container] !==
          container[key as keyof typeof container],
      )
    )
      throw new Error('The saved selection no longer matches the canonical text or container.');
  }
  const indices = selection.targets.map((target) =>
    paragraphs.findIndex((paragraph) => paragraph.id === target.blockId),
  );
  if (
    indices.some(
      (index, position) => index < 0 || (position > 0 && index !== indices[position - 1]! + 1),
    )
  )
    throw new Error('The selected paragraphs are no longer contiguous.');
  command.executeSetPositionContext({
    startIndex: 0,
    endIndex: 0,
    tableId,
    startTrIndex: rowIndex,
    startTdIndex: cellIndex,
  });
  const runtime = command.getRuntimeElementList();
  const maps = new Map<string, { text: string; boundaries: Map<number, number> }>();
  for (const [index, element] of runtime.entries()) {
    const identity = identityOf(element);
    if (
      !identity ||
      !['run', 'lineBreak', 'inlineImage', 'emptyParagraph'].includes(identity.kind) ||
      !sources.has(identity.blockId)
    )
      continue;
    const paragraph = sources.get(identity.blockId)!;
    const run = paragraph.runs.find(
      (run) => run.id === identity.runId && visibleRun(run, document.changes, 'final'),
    );
    if (!run) {
      if (element.value) throw new Error('A runtime run identity changed. Select it again.');
      else continue;
    }
    const value =
      identity.kind === 'emptyParagraph'
        ? ''
        : identity.kind === 'inlineImage'
          ? '\ufffc'
          : identity.kind === 'lineBreak'
            ? element.value.replaceAll('\u0000', '\n')
            : element.value === '\u0000' && !run.text
              ? ''
              : element.value;
    const mapped = maps.get(paragraph.id) ?? {
      text: '',
      boundaries: new Map([[0, Math.max(0, index - 1)]]),
    };
    mapped.text += value;
    mapped.boundaries.set(mapped.text.length, index);
    maps.set(paragraph.id, mapped);
  }
  for (const target of selection.targets) {
    const mapped = maps.get(target.blockId);
    const text = sources
      .get(target.blockId)!
      .runs.filter((run) => visibleRun(run, document.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    if (
      !mapped ||
      mapped.text !== text ||
      !mapped.boundaries.has(target.from) ||
      !mapped.boundaries.has(target.to)
    )
      throw new Error('The runtime text or Unicode boundaries differ from the saved selection.');
  }
  const first = selection.targets[0]!;
  const last = selection.targets.at(-1)!;
  const startIndex = maps.get(first.blockId)!.boundaries.get(first.from)!;
  const endIndex = maps.get(last.blockId)!.boundaries.get(last.to)!;
  command.executeSetRange(startIndex, endIndex);
  command.executeFocus({ range: { startIndex, endIndex } });
}
