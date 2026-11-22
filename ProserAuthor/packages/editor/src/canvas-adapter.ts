import {
  ElementType,
  RowFlex,
  TitleLevel,
  ListType,
  ListStyle,
  type IElement,
  type IEditorData,
  type IEditorOption,
} from '@hivemagnus/canvas-word-engine';
import { canContinueManualChange, carryManualTargets } from './manual-review-editing';
import {
  type ProserDocument,
  type DocumentBlock,
  type DocumentParagraph,
  type DocumentRun,
  type ParagraphStyle,
  type TextStyle,
  visibleRun,
  visibleParagraph,
  effectiveParagraphStyle,
  effectiveTextStyle,
  type DocumentStyleDefinitions,
  paragraphBoundaryVisible,
  canonicalDocument,
  paragraphsOf,
  type DocumentView,
  type DocumentChange,
} from './document-model';

const nativeBoundaryRecords = new WeakMap<ProserDocument, Map<string, DocumentChange>>();
export interface CanvasDocumentBinding {
  startId: string;
  count: number;
  offset?: number;
  text?: string;
  externalId: string;
  extension: unknown;
}
interface Identity {
  kind:
    | 'run'
    | 'boundary'
    | 'lineBreak'
    | 'image'
    | 'inlineImage'
    | 'emptyParagraph'
    | 'table'
    | 'pageBreak';
  blockId: string;
  runId?: string;
  paragraphStyle?: ParagraphStyle;
  displayedParagraphStyle?: ParagraphStyle;
  sourceTextStyle?: TextStyle;
  displayedTextStyle?: TextStyle;
  changeId?: string;
  paragraphChangeId?: string;
  assetId?: number;
  sha256?: string;
  alt?: string;
  sourceWidths?: number[];
  displayedWidths?: number[];
  sourceCells?: string[];
  implicitHeadingFontSize?: number;
  implicitHeadingBold?: boolean;
}
const TITLE_LEVELS = [
  TitleLevel.FIRST,
  TitleLevel.SECOND,
  TitleLevel.THIRD,
  TitleLevel.FOURTH,
  TitleLevel.FIFTH,
  TitleLevel.SIXTH,
];
export const headingFontSize = (heading: number, base: number) =>
  Math.round(base * ([2, 1.5, 1.17, 1, 0.83, 0.67][heading - 1] ?? 1) * 100) / 100;
export const canvasTitleOptions = (base: number) => ({
  defaultFirstSize: headingFontSize(1, base),
  defaultSecondSize: headingFontSize(2, base),
  defaultThirdSize: headingFontSize(3, base),
  defaultFourthSize: headingFontSize(4, base),
  defaultFifthSize: headingFontSize(5, base),
  defaultSixthSize: headingFontSize(6, base),
});
function paragraphCanvasStyle(paragraph: DocumentParagraph, listId?: string) {
  return {
    ...(paragraph.style.heading
      ? { level: TITLE_LEVELS[paragraph.style.heading - 1], titleId: paragraph.id }
      : {}),
    ...(paragraph.style.list
      ? {
          listType: paragraph.style.list === 'number' ? ListType.OL : ListType.UL,
          listStyle: paragraph.style.list === 'number' ? ListStyle.DECIMAL : ListStyle.DISC,
          listId: listId ?? paragraph.id,
        }
      : {}),
  };
}
const extension = (identity: Identity) => ({ proser: identity });
export function identityOf(element: IElement): Identity | undefined {
  const value = element.extension;
  if (!value || typeof value !== 'object' || !('proser' in value)) return undefined;
  return value.proser as Identity;
}
/** Document images load only through owned Factory assets with immutable digest metadata. */
export function ownedCanvasImageSource(element: IElement): boolean {
  const identity = identityOf(element);
  return Boolean(
    identity &&
    (identity.kind === 'image' || identity.kind === 'inlineImage') &&
    Number.isSafeInteger(identity.assetId) &&
    identity.assetId! > 0 &&
    typeof identity.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(identity.sha256) &&
    element.value === `/api/images/${identity.assetId}/content`,
  );
}
interface ParagraphContinuation {
  blockId: string;
  before: boolean;
  after: boolean;
}
function nativeParagraphLayout(
  paragraph: DocumentParagraph,
  style: ParagraphStyle,
  continuation?: ParagraphContinuation,
): IElement['paragraphLayout'] {
  const layout = {
    id: paragraph.id,
    before: style.before,
    after: style.after,
    indent: style.indent,
    firstLineIndent: style.firstLineIndent,
    keepWithNext: style.keepWithNext,
    pageBreakBefore: style.pageBreakBefore,
    ...(continuation?.blockId === paragraph.id
      ? { continuesBefore: continuation.before, continuesAfter: continuation.after }
      : {}),
  };
  return Object.values(layout).some((value, index) => index > 0 && value !== undefined)
    ? layout
    : undefined;
}
function paragraphElements(
  paragraphs: DocumentParagraph[],
  document: ProserDocument,
  view: DocumentView,
  initialListId?: string,
  definitions?: DocumentStyleDefinitions,
  initialParagraph?: DocumentParagraph,
  continuation?: ParagraphContinuation,
): IElement[] {
  const elements: IElement[] = [];
  let listId = initialListId;
  let listKind: ParagraphStyle['list'];
  const projected = paragraphs.filter((block) => visibleParagraph(block, document.changes, view));
  let logicalParagraph = initialParagraph;
  for (const [index, paragraph] of projected.entries()) {
    if (
      !logicalParagraph ||
      (index && paragraphBoundaryVisible(projected[index - 1]!, paragraph, document.changes, view))
    )
      logicalParagraph = paragraph;
    const styleOfParagraph = effectiveParagraphStyle(logicalParagraph, document, view, definitions);
    const paragraphLayout = nativeParagraphLayout(logicalParagraph, styleOfParagraph, continuation);
    const displayedParagraph = { ...paragraph, style: styleOfParagraph };
    if (styleOfParagraph.list !== listKind || !listId) listId = initialListId ?? paragraph.id;
    listKind = styleOfParagraph.list;
    if (index && paragraphBoundaryVisible(projected[index - 1]!, paragraph, document.changes, view))
      elements.push({
        value: '\n',
        paragraphLayout,
        extension: extension({
          kind: 'boundary',
          blockId: paragraph.id,
          paragraphStyle: paragraph.style,
        }),
      });
    const visible = paragraph.runs.filter((run) => visibleRun(run, document.changes, view));
    for (const run of visible) {
      if (run.inlineImage) {
        const image = run.inlineImage;
        elements.push({
          id: run.id,
          externalId: run.id,
          type: ElementType.IMAGE,
          paragraphLayout,
          value: `/api/images/${image.assetId}/content`,
          width: image.width,
          height: image.height,
          extension: extension({
            kind: 'inlineImage',
            blockId: paragraph.id,
            runId: run.id,
            paragraphStyle: paragraph.style,
            displayedParagraphStyle: styleOfParagraph,
            paragraphChangeId: paragraph.changeId,
            changeId: run.changeId,
            assetId: image.assetId,
            sha256: image.sha256,
            alt: image.alt,
          }),
        });
        continue;
      }
      const style = effectiveTextStyle(run, paragraph, document, view, definitions);
      const change =
        document.changes.find((item) => item.id === run.changeId && item.status === 'pending') ??
        document.changes.find(
          (item) => item.id === paragraph.changeId && item.status === 'pending',
        );
      const displayedStyle =
        view === 'markup' && change
          ? {
              ...style,
              ...(change.kind === 'deletion' || change.kind === 'paragraphDeletion'
                ? { strikeout: true, color: '#a52a43' }
                : { underline: true, color: '#176b48' }),
            }
          : style;
      for (const value of run.text.split(/(\n)/)) {
        const element: IElement = {
          type: ElementType.TEXT,
          paragraphLayout,
          ...(value === '\n' ? { paragraphBreak: false } : {}),
          value,
          ...displayedStyle,
          ...(styleOfParagraph.heading && displayedStyle.size === undefined
            ? { size: headingFontSize(styleOfParagraph.heading, document.layout.fontSize) }
            : {}),
          ...(styleOfParagraph.heading && displayedStyle.bold === undefined ? { bold: true } : {}),
          ...paragraphCanvasStyle(displayedParagraph, listId),
          rowFlex: styleOfParagraph.alignment as RowFlex | undefined,
          rowMargin: styleOfParagraph.lineSpacing,
          externalId: run.id,
          extension: extension({
            kind: value === '\n' ? 'lineBreak' : 'run',
            blockId: paragraph.id,
            runId: run.id,
            paragraphStyle: paragraph.style,
            displayedParagraphStyle: styleOfParagraph,
            sourceTextStyle: run.style,
            displayedTextStyle: style,
            paragraphChangeId: paragraph.changeId,
            changeId: run.changeId,
            ...(styleOfParagraph.heading && style.size === undefined
              ? { implicitHeadingFontSize: document.layout.fontSize }
              : {}),
            ...(styleOfParagraph.heading && style.bold === undefined
              ? { implicitHeadingBold: true }
              : {}),
          }),
        };
        elements.push(
          style.hyperlink
            ? { type: ElementType.HYPERLINK, value: '', url: style.hyperlink, valueList: [element] }
            : element,
        );
      }
    }
    if (!visible.length)
      elements.push({
        value: '',
        paragraphLayout,
        ...paragraphCanvasStyle(displayedParagraph, listId),
        extension: extension({
          kind: 'run',
          blockId: paragraph.id,
          paragraphStyle: paragraph.style,
        }),
      });
  }
  return elements;
}
function fittedTableWidths(widths: number[], layout: ProserDocument['layout']) {
  const available = Math.max(24, layout.width - layout.margins[1] - layout.margins[3]);
  const total = widths.reduce((sum, width) => sum + width, 0);
  return total > available ? widths.map((width) => (width * available) / total) : widths;
}
function sourceTableWidths(element: IElement, identity: Identity | undefined): number[] {
  const current = (element.colgroup ?? []).map((column) => column.width);
  if (!identity?.sourceWidths || !identity.displayedWidths) return current;
  const renderedTotal = identity.displayedWidths.reduce((sum, width) => sum + width, 0);
  const sourceTotal = identity.sourceWidths.reduce((sum, width) => sum + width, 0);
  return current.map((width, index) => {
    const cellId = element.trList?.[0]?.tdList[index]?.id;
    const sourceIndex =
      cellId && identity.sourceCells
        ? identity.sourceCells.indexOf(cellId)
        : current.length === identity.sourceWidths!.length
          ? index
          : -1;
    if (sourceIndex < 0) return (width * sourceTotal) / renderedTotal;
    const rendered = identity.displayedWidths![sourceIndex]!;
    const source = identity.sourceWidths![sourceIndex]!;
    return Math.abs(width - rendered) < 0.000001 ? source : (width * source) / rendered;
  });
}
export function documentToCanvas(
  document: ProserDocument,
  view: DocumentView = 'final',
  definitions?: DocumentStyleDefinitions,
  continuation?: ParagraphContinuation,
): IEditorData {
  const main: IElement[] = [];
  let listId: string | undefined;
  let listKind: ParagraphStyle['list'];
  let logicalParagraph: DocumentParagraph | undefined;
  const projected = document.blocks.filter(
    (block) => block.type !== 'paragraph' || visibleParagraph(block, document.changes, view),
  );
  for (const [index, block] of projected.entries()) {
    if (block.type !== 'paragraph') {
      listId = undefined;
      listKind = undefined;
      logicalParagraph = undefined;
    }
    const previous = projected[index - 1];
    if (
      block.type === 'paragraph' &&
      (!logicalParagraph ||
        previous?.type !== 'paragraph' ||
        paragraphBoundaryVisible(previous, block, document.changes, view))
    )
      logicalParagraph = block;
    if (
      index &&
      !(
        previous?.type === 'paragraph' &&
        block.type === 'paragraph' &&
        !paragraphBoundaryVisible(previous, block, document.changes, view)
      )
    )
      main.push({
        value: '\n',
        paragraphLayout:
          block.type === 'paragraph'
            ? nativeParagraphLayout(
                logicalParagraph!,
                effectiveParagraphStyle(logicalParagraph!, document, view, definitions),
                continuation,
              )
            : undefined,
        extension: extension({
          kind: 'boundary',
          blockId: block.id,
          ...(block.type === 'paragraph' ? { paragraphStyle: block.style } : {}),
        }),
      });
    if (block.type === 'paragraph') {
      const style = effectiveParagraphStyle(block, document, view, definitions);
      if (style.list !== listKind || !listId) listId = block.id;
      listKind = style.list;
      main.push(
        ...paragraphElements(
          [block],
          document,
          view,
          listId,
          definitions,
          logicalParagraph,
          continuation,
        ),
      );
    } else if (block.type === 'image')
      main.push({
        id: block.id,
        type: ElementType.IMAGE,
        value: `/api/images/${block.assetId}/content`,
        width: block.width,
        height: block.height,
        extension: extension({
          kind: 'image',
          blockId: block.id,
          assetId: block.assetId,
          sha256: block.sha256,
          alt: block.alt,
        }),
      });
    else if (block.type === 'pageBreak')
      main.push({
        id: block.id,
        type: ElementType.PAGE_BREAK,
        value: '',
        extension: extension({ kind: 'pageBreak', blockId: block.id }),
      });
    else
      main.push({
        id: block.id,
        type: ElementType.TABLE,
        value: '',
        extension: extension({
          kind: 'table',
          blockId: block.id,
          sourceWidths: block.widths,
          sourceCells: block.rows[0]?.cells.map((cell) => cell.id),
          displayedWidths: fittedTableWidths(block.widths, document.layout),
        }),
        colgroup: fittedTableWidths(block.widths, document.layout).map((width) => ({ width })),
        trList: block.rows.map((row) => ({
          id: row.id,
          height: 32,
          tdList: row.cells.map((cell) => ({
            id: cell.id,
            colspan: 1,
            rowspan: 1,
            value: paragraphElements(cell.paragraphs, document, view, undefined, definitions),
          })),
        })),
      });
  }
  return {
    main,
    header: paragraphElements(document.layout.header, document, view, undefined, definitions),
    footer: paragraphElements(document.layout.footer, document, view, undefined, definitions),
  };
}
const textStyle = (element: IElement): TextStyle => {
  const style: TextStyle = {};
  for (const key of [
    'font',
    'size',
    'bold',
    'italic',
    'underline',
    'strikeout',
    'color',
    'highlight',
  ] as const) {
    const value = element[key];
    if (value !== undefined) Object.assign(style, { [key]: value });
  }
  if (element.url) {
    if (
      !/^https?:\/\//i.test(element.url) ||
      Array.from(element.url).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error('This hyperlink cannot be saved. Only HTTP(S) links are supported.');
    style.hyperlink = element.url;
  }
  return style;
};
function decodeElements(
  elements: IElement[],
  id: () => string,
  protectedRuns: Set<string>,
  seen: Set<string> = new Set(),
  bindings?: CanvasDocumentBinding[],
  boundaries?: Array<{ kind: 'paragraphJoin' | 'paragraphSplit'; left: string; right: string }>,
): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const unique = (candidate?: string, fallback?: string) => {
    const value =
      candidate && !seen.has(candidate)
        ? candidate
        : fallback && !seen.has(fallback)
          ? fallback
          : id();
    seen.add(value);
    return value;
  };
  let current: DocumentParagraph | undefined;
  let currentSourceBlockId: string | undefined;
  let pendingSplit: { left: string; identity?: Identity; elementId?: string } | undefined;
  let lastSourceRun: string | undefined;
  const begin = (identity?: Identity, elementId?: string) => {
    current = {
      type: 'paragraph',
      id: unique(identity?.blockId, elementId ? `paragraph:${elementId}` : undefined),
      style: { ...identity?.paragraphStyle },
      runs: [],
      ...(identity?.paragraphChangeId ? { changeId: identity.paragraphChangeId } : {}),
    };
    blocks.push(current);
    currentSourceBlockId = identity?.blockId;
    if (pendingSplit) {
      boundaries?.push({ kind: 'paragraphSplit', left: pendingSplit.left, right: current.id });
      if (pendingSplit.elementId)
        bindings?.push({
          startId: pendingSplit.elementId,
          count: 1,
          externalId: current.id,
          extension: extension({
            ...pendingSplit.identity,
            kind: 'boundary',
            blockId: current.id,
            runId: undefined,
            paragraphStyle: current.style,
          }),
        });
      pendingSplit = undefined;
    }
    lastSourceRun = undefined;
  };
  const completeEmptySplit = () => {
    if (!pendingSplit) return;
    const empty = pendingSplit;
    begin({ ...empty.identity, kind: 'run', blockId: id() }, empty.elementId);
    const runId = id();
    current!.runs.push({ id: runId, text: '', style: {} });
    if (empty.elementId)
      bindings?.push({
        startId: empty.elementId,
        count: 1,
        externalId: runId,
        extension: extension({
          ...empty.identity,
          kind: 'emptyParagraph',
          blockId: current!.id,
          runId,
          paragraphStyle: current!.style,
        }),
      });
  };
  const inline = (values: IElement[]): IElement[] =>
    values.flatMap((element) =>
      element.valueList &&
      [ElementType.HYPERLINK, ElementType.TITLE, ElementType.LIST].includes(element.type!)
        ? inline(element.valueList).map((child) => ({
            ...child,
            ...(element.type === ElementType.HYPERLINK
              ? { url: element.url }
              : element.type === ElementType.TITLE
                ? { level: element.level, titleId: element.titleId }
                : {
                    listType: element.listType,
                    listStyle: element.listStyle,
                    listId: child.listId ?? element.listId,
                  }),
          }))
        : [element],
    );
  for (const element of inline(elements)) {
    const identity = identityOf(element);
    if (element.type === ElementType.TABLE) {
      current = undefined;
      blocks.push({
        type: 'table',
        id: unique(identity?.blockId ?? element.id),
        widths: sourceTableWidths(element, identity),
        rows: (element.trList ?? []).map((row) => ({
          id: unique(row.id),
          cells: row.tdList.map((cell) => {
            if (cell.colspan !== 1 || cell.rowspan !== 1)
              throw new Error('Merged cells require a supported table conversion before saving.');
            const children = decodeElements(
              cell.value,
              id,
              protectedRuns,
              seen,
              bindings,
              boundaries,
            );
            if (children.some((block) => block.type !== 'paragraph'))
              throw new Error('Unsupported nested object in a table cell.');
            return { id: unique(cell.id), paragraphs: children as DocumentParagraph[] };
          }),
        })),
      });
      continue;
    }
    if (element.type === ElementType.IMAGE) {
      if (!identity?.assetId || !identity.sha256)
        throw new Error('Insert images through Proser to retain authenticated asset identity.');
      if (identity.kind === 'inlineImage') {
        if (!current || identity.blockId !== currentSourceBlockId) begin(identity, element.id);
        const runId = unique(identity.runId, element.id);
        current!.runs.push({
          id: runId,
          text: '',
          style: {},
          ...(identity.changeId ? { changeId: identity.changeId } : {}),
          inlineImage: {
            assetId: identity.assetId,
            sha256: identity.sha256,
            alt: identity.alt ?? '',
            width: element.width ?? 100,
            height: element.height ?? 100,
          },
        });
        if (element.id)
          bindings?.push({
            startId: element.id,
            count: 1,
            externalId: runId,
            extension: extension({
              ...identity,
              blockId: current!.id,
              runId,
              paragraphStyle: current!.style,
            }),
          });
        lastSourceRun = undefined;
        continue;
      }
      current = undefined;
      blocks.push({
        type: 'image',
        id: unique(identity.blockId),
        assetId: identity.assetId,
        sha256: identity.sha256,
        alt: identity.alt ?? '',
        width: element.width ?? 100,
        height: element.height ?? 100,
      });
      continue;
    }
    if (element.type === ElementType.PAGE_BREAK) {
      current = undefined;
      blocks.push({ type: 'pageBreak', id: unique(identity?.blockId ?? element.id) });
      continue;
    }
    if (
      element.type &&
      ![ElementType.TEXT, ElementType.HYPERLINK, ElementType.TITLE, ElementType.LIST].includes(
        element.type,
      )
    )
      throw new Error(`Unsupported editor object: ${element.type}`);
    if (element.valueList) {
      const children = decodeElements(
        element.valueList,
        id,
        protectedRuns,
        seen,
        bindings,
        boundaries,
      );
      blocks.push(...children);
      current = undefined;
      continue;
    }
    if (identity?.kind === 'boundary') {
      completeEmptySplit();
      current = undefined;
      continue;
    }
    if (!identity && element.value === '\u0000') continue;
    const value = identity?.kind === 'emptyParagraph' ? '' : element.value;
    const joined =
      current && identity?.blockId && identity.blockId !== currentSourceBlockId
        ? current.id
        : undefined;
    if (!current || (identity?.blockId && identity.blockId !== currentSourceBlockId)) {
      begin(identity, element.id);
      if (joined) boundaries?.push({ kind: 'paragraphJoin', left: joined, right: current!.id });
    }
    if (value === '\n' && identity?.kind !== 'lineBreak' && element.paragraphBreak !== false) {
      pendingSplit = { left: current!.id, identity, elementId: element.id };
      current = undefined;
      continue;
    }
    if (!current) throw new Error('Paragraph context is unavailable.');
    if (element.rowFlex)
      current.style.alignment = element.rowFlex === RowFlex.ALIGNMENT ? 'justify' : element.rowFlex;
    if (element.rowMargin) current.style.lineSpacing = element.rowMargin;
    const heading = element.level ? TITLE_LEVELS.indexOf(element.level) + 1 : undefined;
    const previousHeading = current.style.heading;
    const previousList = current.style.list;
    current.style.heading =
      heading && heading > 0 ? (heading as ParagraphStyle['heading']) : undefined;
    current.style.list =
      element.listType === ListType.OL
        ? 'number'
        : element.listType === ListType.UL
          ? 'bullet'
          : undefined;
    if (
      current.style.heading !== previousHeading &&
      current.style.heading &&
      (!current.style.name ||
        ['Body', 'Normal'].includes(current.style.name) ||
        /^Heading ?[1-6]$/.test(current.style.name))
    )
      current.style.name = `Heading${current.style.heading}`;
    if (
      !current.style.heading &&
      previousHeading &&
      /^Heading ?[1-6]$/.test(current.style.name ?? '')
    )
      current.style.name = 'Normal';
    if (
      current.style.list !== previousList &&
      (!current.style.name ||
        ['Normal', 'Body', 'Bulleted list', 'Numbered list'].includes(current.style.name))
    )
      current.style.name = 'Normal';
    if (!heading && identity?.displayedParagraphStyle?.heading && !identity.paragraphStyle?.heading)
      current.style.name = 'Normal';
    if (identity?.displayedParagraphStyle) {
      for (const key of ['alignment', 'lineSpacing', 'heading', 'list'] as const) {
        if (current.style[key] === identity.displayedParagraphStyle[key]) {
          const raw = identity.paragraphStyle?.[key];
          if (raw === undefined) delete current.style[key];
          else Object.assign(current.style, { [key]: raw });
        }
      }
    }
    const style = textStyle(element);
    if (identity?.sourceTextStyle?.characterStyleId)
      style.characterStyleId = identity.sourceTextStyle.characterStyleId;
    if (
      heading &&
      identity?.implicitHeadingFontSize &&
      style.size === headingFontSize(heading, identity.implicitHeadingFontSize)
    )
      delete style.size;
    if (heading && identity?.implicitHeadingBold && style.bold === true) delete style.bold;
    if (identity?.displayedTextStyle)
      for (const key of Object.keys(identity.displayedTextStyle) as Array<keyof TextStyle>) {
        if (style[key] === identity.displayedTextStyle[key]) {
          const raw = identity.sourceTextStyle?.[key];
          if (raw === undefined) delete style[key];
          else Object.assign(style, { [key]: raw });
        }
      }
    const last = current.runs.at(-1);
    if (
      last &&
      lastSourceRun === identity?.runId &&
      canonicalDocument(last.style) === canonicalDocument(style)
    )
      last.text += value;
    else {
      const run: DocumentRun = {
        id: unique(identity?.runId, element.id ? `run:${element.id}` : undefined),
        text: value,
        style,
        ...(identity?.changeId ? { changeId: identity.changeId } : {}),
      };
      if (identity?.runId && protectedRuns.has(identity.runId) && run.id !== identity.runId)
        throw new Error('Resolve a tracked change before splitting its formatting.');
      current.runs.push(run);
      lastSourceRun = identity?.runId;
    }
    const ownedRun = current.runs.at(-1)!;
    if (element.id && value)
      bindings?.push({
        startId: element.id,
        count: Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value))
          .length,
        text: value,
        externalId: ownedRun.id,
        extension: extension({
          ...identity,
          kind: identity?.kind === 'lineBreak' ? 'lineBreak' : 'run',
          blockId: current.id,
          runId: ownedRun.id,
          paragraphStyle: current.style,
          sourceTextStyle: ownedRun.style,
          displayedTextStyle: textStyle(element),
        }),
      });
  }
  completeEmptySplit();
  for (const block of blocks)
    if (block.type === 'paragraph' && !block.runs.length)
      block.runs.push({ id: id(), text: '', style: {} });
  return blocks;
}
export function canvasToDocument(
  data: IEditorData,
  previous: ProserDocument,
  id: () => string = () => crypto.randomUUID(),
  options?: IEditorOption,
  bindings?: CanvasDocumentBinding[],
  trackBoundaries = false,
  actorId?: number,
): ProserDocument {
  const protectedRuns = new Set(
    previous.changes
      .filter((change) => change.status === 'pending' && !canContinueManualChange(change, actorId))
      .flatMap((change) => change.targetRunIds),
  );
  for (const paragraph of paragraphsOf(previous, true))
    if (
      paragraph.changeId &&
      previous.changes.some(
        (change) =>
          change.id === paragraph.changeId &&
          change.status === 'pending' &&
          !canContinueManualChange(change, actorId),
      )
    )
      for (const run of paragraph.runs) protectedRuns.add(run.id);
  const result = structuredClone(previous);
  const seen = new Set<string>();
  const boundaryEdits: Array<{
    kind: 'paragraphJoin' | 'paragraphSplit';
    left: string;
    right: string;
  }> = [];
  result.blocks = decodeElements(data.main, id, protectedRuns, seen, bindings, boundaryEdits);
  for (const story of ['header', 'footer'] as const) {
    const content = data[story];
    if (!content) continue;
    const blocks = decodeElements(content, id, protectedRuns, seen, bindings);
    if (blocks.some((block) => block.type !== 'paragraph'))
      throw new Error('Header/footer objects require an explicit supported conversion.');
    result.layout[story] = blocks as DocumentParagraph[];
  }
  if (options) {
    if (options.width !== undefined) result.layout.width = options.width;
    if (options.height !== undefined) result.layout.height = options.height;
    if (options.margins) result.layout.margins = [...options.margins];
    if (options.defaultFont) result.layout.font = options.defaultFont;
    if (options.defaultSize) result.layout.fontSize = options.defaultSize;
    if (options.pageNumber?.disabled !== undefined)
      result.layout.pageNumbers = !options.pageNumber.disabled;
  }
  if (!result.blocks.length && previous.blocks.length)
    result.blocks.push({
      type: 'paragraph',
      id: id(),
      style: {},
      runs: [{ id: id(), text: '', style: {} }],
    });
  const previousParagraphs = new Map(
    paragraphsOf(previous, true).map((paragraph) => [paragraph.id, paragraph]),
  );
  for (const paragraph of paragraphsOf(result, true)) {
    const original = previousParagraphs.get(paragraph.id);
    if (original?.changeId) paragraph.changeId = original.changeId;
    if (original?.boundaryChangeId) paragraph.boundaryChangeId = original.boundaryChangeId;
  }
  for (const [index, paragraph] of previous.blocks.entries()) {
    if (paragraph.type !== 'paragraph' || visibleParagraph(paragraph, previous.changes, 'final'))
      continue;
    const following = previous.blocks
      .slice(index + 1)
      .find(
        (block) => block.type !== 'paragraph' || visibleParagraph(block, previous.changes, 'final'),
      );
    const position = following ? result.blocks.findIndex((block) => block.id === following.id) : -1;
    result.blocks.splice(
      position < 0 ? result.blocks.length : position,
      0,
      structuredClone(paragraph),
    );
  }
  for (const edit of boundaryEdits) {
    const left = paragraphsOf(result).find((block) => block.id === edit.left);
    const right = paragraphsOf(result).find((block) => block.id === edit.right);
    if (!left || !right) continue;
    const oldLeft = previousParagraphs.get(left.id);
    const oldRight = previousParagraphs.get(right.id);
    if (
      edit.kind === 'paragraphJoin' &&
      oldLeft &&
      oldRight &&
      !paragraphBoundaryVisible(oldLeft, oldRight, previous.changes, 'final')
    )
      continue;
    if (
      left.boundaryChangeId &&
      previous.changes.some(
        (change) => change.id === left.boundaryChangeId && change.status === 'pending',
      )
    )
      throw new Error('Resolve the pending paragraph boundary before changing it.');
    let records = nativeBoundaryRecords.get(previous);
    if (!records) {
      records = new Map();
      nativeBoundaryRecords.set(previous, records);
    }
    const key = JSON.stringify([edit.kind, left.id, right.id, trackBoundaries]);
    let record = records.get(key);
    if (!record) {
      record = {
        id: id(),
        kind: edit.kind,
        targetRunIds: [],
        targetBlockIds: [left.id, right.id],
        origin: 'manual',
        status: trackBoundaries ? 'pending' : 'accepted',
        authorId: 0,
        authorName: '',
        createdAt: new Date().toISOString(),
      };
      records.set(key, record);
    }
    left.boundaryChangeId = record.id;
    result.changes.push(structuredClone(record));
  }
  // Final view hides deletions; retain their original runs and order rather than silently dropping review records.
  const targets = new Map(paragraphsOf(result, true).map((paragraph) => [paragraph.id, paragraph]));
  for (const block of paragraphsOf(previous, true)) {
    if (!visibleParagraph(block, previous.changes, 'final')) continue;
    const target = targets.get(block.id);
    for (const [index, run] of block.runs.entries()) {
      const own = previous.changes.find(
        (change) => change.id === run.changeId && canContinueManualChange(change, actorId),
      );
      if (own && !target?.runs.some((item) => item.id === run.id)) {
        if (!target)
          throw new Error(
            'Keep the pending manual paragraph identity when erasing its provisional text.',
          );
        target.runs.splice(Math.min(index, target.runs.length), 0, {
          ...structuredClone(run),
          text: '',
        });
      }
      if (!visibleRun(run, previous.changes, 'final')) {
        if (!target) throw new Error('Resolve tracked changes before deleting their paragraph.');
        target.runs.splice(Math.min(index, target.runs.length), 0, structuredClone(run));
      }
      if (protectedRuns.has(run.id) && visibleRun(run, previous.changes, 'final')) {
        const next = target?.runs.find((item) => item.id === run.id);
        if (!next || canonicalDocument(next) !== canonicalDocument(run))
          throw new Error('Resolve overlapping tracked changes before editing their text.');
      }
    }
  }
  return carryManualTargets(previous, result, actorId);
}

/** Rebase render bindings onto a formatting-preserving tracked document. Only
 * transient glyph offsets participate; canonical IDs and text stay authoritative. */
export function rebaseCanvasBindings(
  bindings: CanvasDocumentBinding[],
  document: ProserDocument,
): CanvasDocumentBinding[] {
  const paragraphs = new Map(
    paragraphsOf(document, true).map((paragraph) => [paragraph.id, paragraph]),
  );
  const offsets = new Map<string, number>();
  const result: CanvasDocumentBinding[] = [];
  const count = (text: string) =>
    Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length;
  for (const binding of bindings) {
    const identity = identityOf({ value: '', extension: binding.extension });
    if (!identity) {
      result.push(binding);
      continue;
    }
    const offset = offsets.get(identity.blockId) ?? 0;
    if (identity.kind === 'inlineImage') {
      offsets.set(identity.blockId, offset + 1);
      result.push(binding);
      continue;
    }
    if (binding.text === undefined) {
      result.push(binding);
      continue;
    }
    const paragraph = paragraphs.get(identity.blockId);
    if (!paragraph) throw new Error('A tracked paragraph identity changed before rendering.');
    let position = 0;
    let covered = 0;
    const text = paragraph.runs
      .filter((run) => visibleRun(run, document.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    if (text.slice(offset, offset + binding.text.length) !== binding.text)
      throw new Error('Tracked render text does not match its canonical span.');
    for (const run of paragraph.runs.filter((run) => visibleRun(run, document.changes, 'final'))) {
      const length = run.inlineImage ? 1 : run.text.length;
      const start = Math.max(position, offset);
      const end = Math.min(position + length, offset + binding.text.length);
      if (end > start && !run.inlineImage) {
        const before = binding.text.slice(0, start - offset);
        const value = binding.text.slice(start - offset, end - offset);
        result.push({
          startId: binding.startId,
          offset: count(before),
          count: count(value),
          text: value,
          externalId: run.id,
          extension: extension({
            ...identity,
            blockId: paragraph.id,
            runId: run.id,
            changeId: run.changeId,
            paragraphStyle: paragraph.style,
          }),
        });
        covered += value.length;
      }
      position += length;
    }
    if (covered !== binding.text.length)
      throw new Error('A tracked render span crosses a protected object.');
    offsets.set(identity.blockId, offset + binding.text.length);
  }
  return result;
}
