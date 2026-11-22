import { createHash, randomUUID } from 'node:crypto';
import { DocumentError } from './errors';
import { canonicalDocument, paragraphsOf, visibleParagraph, visibleRun, paragraphStyle, runStyle, type ProserDocument, type DocumentParagraph } from './model';
import type { DocumentTargetInput, FrozenDocumentTarget } from './proposal-model';
const digest = (value: unknown) => createHash('sha256').update(canonicalDocument(value)).digest('hex');
export const paragraphText = (paragraph: DocumentParagraph, document: ProserDocument) => paragraph.runs.filter((run) => visibleRun(run, document.changes, 'final')).map((run) => run.inlineImage ? '\uFFFC' : run.text).join('');
export function protectedObjects(document: ProserDocument) {
  return [...document.blocks.flatMap<unknown>((block) => block.type === 'paragraph' ? [] : block.type === 'table' ? [{ type: 'table', id: block.id, widths: block.widths, rows: block.rows.map((row) => ({ id: row.id, cells: row.cells.map((cell) => cell.id) })) }] : [block]), ...paragraphsOf(document, true).flatMap((paragraph) => paragraph.runs.flatMap((run) => run.inlineImage ? [{ blockId: paragraph.id, runId: run.id, inlineImage: run.inlineImage }] : []))];
}
export function frozenTarget(document: ProserDocument, input: DocumentTargetInput, targetId: string = randomUUID()): FrozenDocumentTarget {
  const paragraph = paragraphsOf(document).find((item) => item.id === input.blockId && visibleParagraph(item, document.changes, 'final'));
  if (!paragraph) throw new DocumentError('DOCUMENT_TARGET_STALE', 'The selected paragraph is missing or hidden.', 409);
  const text = paragraphText(paragraph, document);
  const boundaries = new Set([0, text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (item) => item.index)]);
  if (input.to < input.from || input.to > text.length || !boundaries.has(input.from) || !boundaries.has(input.to) || text.slice(input.from, input.to) !== input.sourceText) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Selection text or Unicode boundaries changed.', 409);
  const review = document.changes.filter((change) => change.id === paragraph.changeId || change.id === paragraph.boundaryChangeId || change.targetBlockIds?.includes(paragraph.id) || change.targetRunIds.some((id) => paragraph.runs.some((run) => run.id === id)));
  let cursor = 0;
  const touchesImage = paragraph.runs.filter((run) => visibleRun(run, document.changes, 'final')).some((run) => {
    const start = cursor; cursor += run.inlineImage ? 1 : run.text.length;
    return Boolean(run.inlineImage && input.from < cursor && input.to > start);
  });
  const editable = !touchesImage && !review.some((change) => change.status === 'pending');
  let container: FrozenDocumentTarget['container'] = {};
  for (const block of document.blocks) if (block.type === 'table') for (const row of block.rows) for (const cell of row.cells) if (cell.paragraphs.some((item) => item.id === paragraph.id)) container = { tableId: block.id, rowId: row.id, cellId: cell.id };
  return { ...input, targetId, paragraphText: text, container, editable, runIds: paragraph.runs.filter((run) => visibleRun(run, document.changes, 'final')).map((run) => run.id), formatHash: digest({ style: paragraphStyle(paragraph, document.changes, 'final'), runs: paragraph.runs.map((run) => ({ id: run.id, style: runStyle(run, document.changes, 'final'), changeId: run.changeId })), changeId: paragraph.changeId, boundaryChangeId: paragraph.boundaryChangeId, review }), objectHash: digest({ container, protectedObjects: protectedObjects(document), layout: document.layout }) };
}
export function verifyTargets(document: ProserDocument, targets: FrozenDocumentTarget[]) {
  for (const expected of targets) {
    const current = frozenTarget(document, expected, expected.targetId);
    if (canonicalDocument(current) !== canonicalDocument(expected)) throw new DocumentError('DOCUMENT_TARGET_STALE', 'Text, formatting, protected objects or container identities changed. Create a new proposal for this target.', 409, { targetId: expected.targetId });
  }
}
