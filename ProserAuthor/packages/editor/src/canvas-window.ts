import {
  canonicalDocument,
  visibleRun,
  type ProserDocument,
  type DocumentParagraph,
  type DocumentRun,
  type DocumentBlock,
} from './document-model';
import { paragraphSelection, type DocumentSelection } from './document-selection';

export interface CanvasDocumentWindow {
  document: ProserDocument;
  start: number;
  end: number;
  beforeId?: string;
  afterId?: string;
  part: number;
  parts: number;
  segment?: {
    source: DocumentBlock;
    paragraphId: string;
    from: number;
    to: number;
    rowId?: string;
    cellId?: string;
  };
}
const rawText = (paragraph: DocumentParagraph) =>
  paragraph.runs.map((run) => (run.inlineImage ? '\ufffc' : run.text)).join('');
const rawCost = (block: DocumentBlock) =>
  block.type === 'paragraph'
    ? rawText(block).length
    : block.type === 'table'
      ? block.rows.reduce(
          (total, row) =>
            total +
            row.cells.reduce(
              (sum, cell) =>
                sum + cell.paragraphs.reduce((count, p) => count + rawText(p).length + 2, 0),
              0,
            ),
          0,
        )
      : 1;
function sliceRuns(paragraph: DocumentParagraph, from: number, to: number): DocumentRun[] {
  let offset = 0;
  return paragraph.runs.flatMap((run) => {
    const end = offset + (run.inlineImage ? 1 : run.text.length);
    const left = Math.max(from, offset);
    const right = Math.min(to, end);
    const keep = right > left || (from === to && offset === from && !run.text && !run.inlineImage);
    const result = keep
      ? [{ ...run, text: run.inlineImage ? '' : run.text.slice(left - offset, right - offset) }]
      : [];
    offset = end;
    return result;
  });
}
function paragraphParts(paragraph: DocumentParagraph, budget: number) {
  const text = rawText(paragraph);
  if (!text.length) return [{ paragraph, from: 0, to: 0 }];
  const cuts = [0];
  let last = 0;
  for (const { index, segment } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(text)) {
    const end = index + segment.length;
    if (end - last > budget && index > last) {
      cuts.push(index);
      last = index;
    }
  }
  if (cuts.at(-1) !== text.length) cuts.push(text.length);
  return cuts.slice(0, -1).map((from, index) => ({ paragraph, from, to: cuts[index + 1]! }));
}
/** Only runtime fragments are sliced. Exact canonical source and outside identities
 * fence every merge; fragments never become independently saved documents. */
export function canvasDocumentWindow(
  document: ProserDocument,
  start: number,
  budget = 2400,
  part = 0,
): CanvasDocumentWindow {
  if (!Number.isInteger(budget) || budget < 1)
    throw new Error('The passage budget must be positive.');
  const first = Math.max(0, Math.min(start, Math.max(0, document.blocks.length - 1)));
  const block = document.blocks[first];
  const cost = block ? rawCost(block) : 0;
  if (block && cost > budget && (block.type === 'paragraph' || block.type === 'table')) {
    const choices =
      block.type === 'paragraph'
        ? paragraphParts(block, budget).map((item) => ({
            ...item,
            rowId: undefined,
            cellId: undefined,
          }))
        : block.rows.flatMap((row) =>
            row.cells.flatMap((cell) =>
              cell.paragraphs.flatMap((paragraph) =>
                paragraphParts(paragraph, budget).map((item) => ({
                  ...item,
                  rowId: row.id,
                  cellId: cell.id,
                })),
              ),
            ),
          );
    const selectedPart = Math.min(Math.max(0, part), Math.max(0, choices.length - 1));
    const selected = choices[selectedPart];
    if (selected) {
      const paragraph = {
        ...selected.paragraph,
        runs: sliceRuns(selected.paragraph, selected.from, selected.to),
      };
      const fragment: DocumentBlock =
        block.type === 'paragraph'
          ? paragraph
          : {
              ...block,
              widths: [
                block.widths[
                  block.rows
                    .find((row) => row.id === selected.rowId)!
                    .cells.findIndex((cell) => cell.id === selected.cellId)
                ] ?? block.widths[0]!,
              ],
              rows: block.rows
                .filter((row) => row.id === selected.rowId)
                .map((row) => ({
                  ...row,
                  cells: row.cells
                    .filter((cell) => cell.id === selected.cellId)
                    .map((cell) => ({ ...cell, paragraphs: [paragraph] })),
                })),
            };
      return {
        document: { ...document, blocks: [fragment] },
        start: first,
        end: first + 1,
        beforeId: document.blocks[first - 1]?.id,
        afterId: document.blocks[first + 1]?.id,
        part: selectedPart,
        parts: choices.length,
        segment: {
          source: block,
          paragraphId: paragraph.id,
          from: selected.from,
          to: selected.to,
          rowId: selected.rowId,
          cellId: selected.cellId,
        },
      };
    }
  }
  let end = first;
  let size = 0;
  while (end < document.blocks.length) {
    const current = document.blocks[end]!;
    const length = rawCost(current);
    if (end > first && (size + length > budget || end - first >= 12)) break;
    size += length;
    end++;
  }
  return {
    document: { ...document, blocks: document.blocks.slice(first, end) },
    start: first,
    end,
    beforeId: document.blocks[first - 1]?.id,
    afterId: document.blocks[end]?.id,
    part: 0,
    parts: 1,
  };
}
function paragraphOf(block: DocumentBlock, id: string) {
  return block.type === 'paragraph'
    ? block.id === id
      ? block
      : undefined
    : block.type === 'table'
      ? block.rows
          .flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
          .find((paragraph) => paragraph.id === id)
      : undefined;
}
function mergeRuns(
  source: DocumentParagraph,
  from: number,
  to: number,
  edited: DocumentParagraph,
  id: () => string,
) {
  for (const run of edited.runs) {
    const original = source.runs.find((item) => item.id === run.id);
    if (original && canonicalDocument(original.style) !== canonicalDocument(run.style))
      throw new Error(
        'Format this text in semantic mode so the complete run and its anchors are retained.',
      );
  }
  const runs = [
    ...sliceRuns(source, 0, from),
    ...edited.runs,
    ...sliceRuns(source, to, rawText(source).length),
  ];
  const merged: DocumentRun[] = [];
  const used = new Set<string>();
  for (const run of runs) {
    const previous = merged.at(-1);
    const metadata = (run: DocumentRun) => ({
      style: run.style,
      changeId: run.changeId,
      inlineImage: run.inlineImage,
    });
    if (
      previous?.id === run.id &&
      !run.inlineImage &&
      canonicalDocument(metadata(previous)) === canonicalDocument(metadata(run))
    )
      previous.text += run.text;
    else {
      const next = { ...run, id: used.has(run.id) ? id() : run.id };
      merged.push(next);
      used.add(next.id);
    }
  }
  return merged;
}
export function mergeCanvasDocumentWindow(
  document: ProserDocument,
  window: CanvasDocumentWindow,
  edited: ProserDocument,
  id: () => string = () => crypto.randomUUID(),
): ProserDocument {
  const start = window.beforeId
    ? document.blocks.findIndex((block) => block.id === window.beforeId) + 1
    : 0;
  const end = window.afterId
    ? document.blocks.findIndex((block) => block.id === window.afterId)
    : document.blocks.length;
  if ((window.beforeId && start === 0) || end < start || (window.afterId && end < 0))
    throw new Error('This passage changed outside the current editor. Reopen it before editing.');
  let blocks = edited.blocks;
  if (window.segment) {
    const segment = window.segment;
    if (
      end !== start + 1 ||
      canonicalDocument(document.blocks[start]) !== canonicalDocument(segment.source)
    )
      throw new Error('The source of this text slice changed. Reopen it before editing.');
    const previous = paragraphOf(segment.source, segment.paragraphId)!;
    const fragment = edited.blocks[0];
    const next = fragment && paragraphOf(fragment, segment.paragraphId);
    if (edited.blocks.length !== 1 || !next)
      throw new Error(
        'Paragraph splitting across a text slice requires the complete paragraph in semantic mode.',
      );
    const expectedBlock = window.document.blocks[0]!;
    if (segment.source.type === 'table' && fragment?.type === 'table') {
      const withoutRuns = (block: DocumentBlock) =>
        canonicalDocument({
          ...block,
          rows:
            block.type === 'table'
              ? block.rows.map((row) => ({
                  ...row,
                  cells: row.cells.map((cell) => ({
                    ...cell,
                    paragraphs: cell.paragraphs.map((p) => ({ ...p, runs: [] })),
                  })),
                }))
              : undefined,
        });
      if (withoutRuns(fragment) !== withoutRuns(expectedBlock))
        throw new Error(
          'Table structure edits require a complete table operation, not a text slice.',
        );
    }
    if (
      (segment.from > 0 || segment.to < rawText(previous).length) &&
      canonicalDocument(previous.style) !== canonicalDocument(next.style)
    )
      throw new Error('Apply paragraph formatting to the complete paragraph in semantic mode.');
    const paragraph = {
      ...previous,
      runs: mergeRuns(previous, segment.from, segment.to, next, id),
    };
    const block =
      segment.source.type === 'paragraph'
        ? paragraph
        : ({
            ...segment.source,
            rows:
              segment.source.type === 'table'
                ? segment.source.rows.map((row) => ({
                    ...row,
                    cells: row.cells.map((cell) => ({
                      ...cell,
                      paragraphs: cell.paragraphs.map((p) =>
                        p.id === paragraph.id ? paragraph : p,
                      ),
                    })),
                  }))
                : undefined,
          } as DocumentBlock);
    blocks = [block];
  }
  const outsideIds = new Set(
    [...document.blocks.slice(0, start), ...document.blocks.slice(end)].map((block) => block.id),
  );
  if (blocks.some((block) => outsideIds.has(block.id)))
    throw new Error('The edited passage duplicates a block outside its scope.');
  return {
    ...document,
    blocks: [...document.blocks.slice(0, start), ...blocks, ...document.blocks.slice(end)],
    layout: document.layout,
    changes: edited.changes,
    comments: edited.comments,
  };
}
/** Keep the exact live fragment after insertion; do not re-cut its suffix on a controlled echo. */
export function acknowledgeCanvasWindow(
  window: CanvasDocumentWindow,
  document: ProserDocument,
  fragment: ProserDocument,
): void {
  if (window.segment) {
    const paragraph = paragraphOf(fragment.blocks[0]!, window.segment.paragraphId)!;
    window.segment.to = window.segment.from + rawText(paragraph).length;
    window.segment.source = document.blocks.find(
      (block) => block.id === window.segment!.source.id,
    )!;
  }
  window.document = fragment;
}
function finalPrefix(window: CanvasDocumentWindow, document: ProserDocument) {
  const segment = window.segment;
  if (!segment) return 0;
  const paragraph = paragraphOf(segment.source, segment.paragraphId)!;
  return sliceRuns(paragraph, 0, segment.from)
    .filter((run) => visibleRun(run, document.changes, 'final'))
    .reduce((sum, run) => sum + (run.inlineImage ? 1 : run.text.length), 0);
}
export function windowSelection(
  window: CanvasDocumentWindow,
  selection: DocumentSelection | undefined,
  document: ProserDocument,
  reverse = false,
): DocumentSelection | undefined {
  if (!selection || !window.segment) return selection;
  const shift = finalPrefix(window, document) * (reverse ? -1 : 1);
  const targetDocument = reverse ? window.document : document;
  const mapped = selection.targets.map((target) => {
    const block = targetDocument.blocks.find((block) => paragraphOf(block, target.blockId));
    const paragraph = block && paragraphOf(block, target.blockId);
    if (!paragraph) throw new Error('The selected paragraph is no longer in this passage.');
    const text = paragraph.runs
      .filter((run) => visibleRun(run, targetDocument.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    const selected = paragraphSelection(
      targetDocument,
      target.blockId,
      target.from + shift,
      target.to + shift,
      text,
      true,
    )!;
    if (selected.targets[0]!.sourceText !== target.sourceText)
      throw new Error('The selected text slice changed. Select it again.');
    return selected;
  });
  return {
    ...selection,
    targets: mapped.flatMap((item) => item.targets),
    runs: mapped.flatMap((item) => item.runs),
  };
}
export function canvasWindowForSelection(
  document: ProserDocument,
  selection: DocumentSelection,
  budget = 2400,
): CanvasDocumentWindow {
  const index = document.blocks.findIndex(
    (block) => block.id === (selection.container.tableId ?? selection.targets[0]?.blockId),
  );
  if (index < 0) throw new Error('The selected document block is stale.');
  let window = canvasDocumentWindow(document, index, budget);
  if (!window.segment) return window;
  for (let part = 0; part < window.parts; part++) {
    window = canvasDocumentWindow(document, index, budget, part);
    if (window.segment?.paragraphId !== selection.targets[0]?.blockId) continue;
    try {
      windowSelection(window, selection, document, true);
      return window;
    } catch {
      /* Exact bounded slice only; never relocate by quotation. */
    }
  }
  throw new Error(
    'This selection crosses text slices. Use semantic mode to select the complete range.',
  );
}
/** A durable acknowledgement may stamp review metadata without changing body
 * bytes. Keep the live slice's extended end instead of cutting off recent input. */
export function refreshCanvasDocumentWindow(
  document: ProserDocument,
  window: CanvasDocumentWindow,
): CanvasDocumentWindow {
  const segment = window.segment;
  const source = segment && document.blocks.find((block) => block.id === segment.source.id);
  if (segment && source && canonicalDocument(source) === canonicalDocument(segment.source))
    return {
      ...window,
      document: { ...document, blocks: window.document.blocks },
      segment: { ...segment, source },
    };
  return canvasDocumentWindow(document, window.start, 2400, window.part);
}

export function canvasParagraphContinuation(window: CanvasDocumentWindow | undefined) {
  const segment = window?.segment;
  if (!segment) return undefined;
  const paragraph = paragraphOf(segment.source, segment.paragraphId)!;
  return {
    blockId: paragraph.id,
    before: segment.from > 0,
    after: segment.to < rawText(paragraph).length,
  };
}
