// Generated from Factory documents/style-model.ts; edit Factory and run npm run documents:sync.
/** Saved style IDs reference book-owned definitions; explicit properties override inheritance. */
import {
  paragraphStyle,
  runStyle,
  type DocumentParagraph,
  type DocumentRun,
  type ProserDocument,
  type DocumentView,
  type TextStyle,
  type ParagraphStyle,
} from './document-model.js';
export interface DocumentStyleDefinitions {
  text: Record<string, TextStyle>;
  paragraph: Record<string, ParagraphStyle>;
  labels?: Record<string, string>;
}
export function effectiveParagraphStyle(
  block: DocumentParagraph,
  document: ProserDocument,
  view: DocumentView,
  definitions?: DocumentStyleDefinitions,
): ParagraphStyle {
  const direct = paragraphStyle(block, document.changes, view);
  return { ...(direct.name ? definitions?.paragraph[direct.name] : {}), ...direct };
}
function characterStyle(
  id: string | undefined,
  definitions: DocumentStyleDefinitions | undefined,
  seen = new Set<string>(),
): TextStyle {
  if (!id || !definitions || !Object.hasOwn(definitions.text, id)) return {};
  if (seen.has(id) || seen.size >= 32)
    throw new Error('Character style inheritance is cyclic or too deep.');
  const definition = definitions.text[id]!;
  return {
    ...characterStyle(definition.characterStyleId, definitions, new Set([...seen, id])),
    ...definition,
  };
}
export function effectiveTextStyle(
  run: DocumentRun,
  block: DocumentParagraph,
  document: ProserDocument,
  view: DocumentView,
  definitions?: DocumentStyleDefinitions,
): TextStyle {
  if (run.inlineImage) return {};
  const paragraph = paragraphStyle(block, document.changes, view);
  const direct = runStyle(run, document.changes, view);
  const base = paragraph.name ? definitions?.text[paragraph.name] : undefined;
  return {
    ...characterStyle(base?.characterStyleId, definitions),
    ...base,
    ...characterStyle(direct.characterStyleId, definitions),
    ...direct,
  };
}

/** Validate owned references before canonical commits or layout-definition removal. */
export function validateDocumentStyleReferences(
  document: ProserDocument,
  definitions: DocumentStyleDefinitions,
): void {
  const checkParagraph = (style: ParagraphStyle | undefined) => {
    if (
      style?.name &&
      !/^Normal$|^Heading[1-6]$/.test(style.name) &&
      !Object.hasOwn(definitions.paragraph, style.name)
    )
      throw new Error('Paragraph style reference is not defined in this book.');
  };
  const checkText = (style: TextStyle | undefined) => {
    if (style?.characterStyleId && !Object.hasOwn(definitions.text, style.characterStyleId))
      throw new Error('Character style reference is not defined in this book.');
    if (style?.characterStyleId) characterStyle(style.characterStyleId, definitions);
  };
  for (const block of document.blocks) {
    const paragraphs =
      block.type === 'paragraph'
        ? [block]
        : block.type === 'table'
          ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
          : [];
    for (const paragraph of paragraphs) {
      checkParagraph(paragraph.style);
      for (const run of paragraph.runs) checkText(run.style);
    }
  }
  for (const paragraph of [...document.layout.header, ...document.layout.footer]) {
    checkParagraph(paragraph.style);
    for (const run of paragraph.runs) checkText(run.style);
  }
  for (const change of document.changes) {
    checkParagraph(change.beforeParagraphStyle);
    checkParagraph(change.afterParagraphStyle);
    checkText(change.beforeStyle);
    checkText(change.afterStyle);
  }
}

/** Validate every definition, including unused ancestors. A later edit must
 * never make an invalid graph visible merely by starting to use its style. */
export function validateStyleDefinitions(definitions: DocumentStyleDefinitions): void {
  for (const id of Object.keys(definitions.text)) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current) {
      if (!Object.hasOwn(definitions.text, current))
        throw new Error('Character style inheritance references an undefined definition.');
      if (seen.has(current) || seen.size >= 32)
        throw new Error('Character style inheritance is cyclic or too deep.');
      seen.add(current);
      current = definitions.text[current]!.characterStyleId;
    }
  }
}
