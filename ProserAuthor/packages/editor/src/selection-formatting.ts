import {
  effectiveTextStyle,
  effectiveParagraphStyle,
  visibleRun,
  type ProserDocument,
  type DocumentStyleDefinitions,
  type TextStyle,
  type DocumentParagraph,
} from './document-model';
import { paragraphSelection, type DocumentSelection } from './document-selection';
import { headingFontSize } from './canvas-adapter';

export function selectedParagraphs(
  document: ProserDocument,
  selection?: DocumentSelection,
): DocumentParagraph[] {
  const identities = new Set(selection?.targets.map((target) => target.blockId));
  return document.blocks
    .flatMap((block) =>
      block.type === 'paragraph'
        ? [block]
        : block.type === 'table'
          ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
          : [],
    )
    .filter((paragraph) => identities.has(paragraph.id));
}
/** Refresh run identities after a format split; never relocate text by searching. */
export function refreshFormattingSelection(
  document: ProserDocument,
  selection?: DocumentSelection,
): DocumentSelection | undefined {
  if (!selection) return undefined;
  const paragraphs = selectedParagraphs(document, selection);
  const refreshed = selection.targets.map((target) => {
    const paragraph = paragraphs.find((item) => item.id === target.blockId);
    if (!paragraph) throw new Error('The formatting paragraph changed. Select it again.');
    const text = paragraph.runs
      .filter((run) => visibleRun(run, document.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    if (text.slice(target.from, target.to) !== target.sourceText)
      throw new Error('The formatting selection changed. Select it again.');
    return paragraphSelection(document, target.blockId, target.from, target.to, text, true)!;
  });
  if (
    refreshed.some((value) =>
      ['tableId', 'rowId', 'cellId'].some(
        (key) =>
          value.container[key as keyof typeof value.container] !==
          selection.container[key as keyof typeof selection.container],
      ),
    )
  )
    throw new Error('The formatting container changed. Select it again.');
  return { ...selection, runs: refreshed.flatMap((value) => value.runs) };
}
export type SelectionTextStyle = TextStyle & { mixed?: Array<keyof TextStyle> };
export function selectionTextStyle(
  document: ProserDocument,
  selection?: DocumentSelection,
  namedStyles?: DocumentStyleDefinitions,
): SelectionTextStyle {
  const paragraphs = selectedParagraphs(document, selection);
  const styles: TextStyle[] = [];
  for (const target of selection?.targets ?? []) {
    const paragraph = paragraphs.find((item) => item.id === target.blockId);
    if (!paragraph) continue;
    let offset = 0;
    for (const run of paragraph.runs.filter((run) => visibleRun(run, document.changes, 'final'))) {
      const end = offset + (run.inlineImage ? 1 : run.text.length);
      if (
        !run.inlineImage &&
        (target.from === target.to
          ? target.from >= offset && target.from <= end
          : end > target.from && offset < target.to)
      ) {
        const style = effectiveTextStyle(run, paragraph, document, 'final', namedStyles);
        const heading = effectiveParagraphStyle(paragraph, document, 'final', namedStyles).heading;
        styles.push({
          ...style,
          ...(heading && style.size === undefined
            ? { size: headingFontSize(heading, document.layout.fontSize) }
            : {}),
          ...(heading && style.bold === undefined ? { bold: true } : {}),
        });
        if (target.from === target.to) break;
      }
      offset = end;
    }
  }
  const first = styles[0] ?? {};
  return {
    ...first,
    mixed: (
      ['font', 'size', 'color', 'highlight', 'bold', 'italic', 'underline', 'strikeout'] as const
    ).filter((key) => {
      const resolved = (style: TextStyle) =>
        key === 'font'
          ? (style.font ?? document.layout.font)
          : key === 'size'
            ? (style.size ?? document.layout.fontSize)
            : ['bold', 'italic', 'underline', 'strikeout'].includes(key)
              ? Boolean(style[key])
              : (style[key] ?? '');
      return styles.some((style) => resolved(style) !== resolved(first));
    }),
    ...Object.fromEntries(
      (['bold', 'italic', 'underline', 'strikeout'] as const).map((key) => [
        key,
        styles.length > 0 && styles.every((style) => Boolean(style[key])),
      ]),
    ),
  };
}
