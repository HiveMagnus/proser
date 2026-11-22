import { canContinueManualChange } from './manual-review-editing';
import { paragraphSelection, type DocumentSelection } from './document-selection';
import {
  visibleRun,
  type DocumentParagraph,
  type ParagraphStyle,
  type ProserDocument,
  type TextStyle,
} from './document-model';

function paragraphIn(document: ProserDocument, blockId: string): DocumentParagraph {
  for (const block of document.blocks) {
    if (block.type === 'paragraph' && block.id === blockId) return block;
    if (block.type === 'table')
      for (const row of block.rows)
        for (const cell of row.cells) {
          const paragraph = cell.paragraphs.find((item) => item.id === blockId);
          if (paragraph) return paragraph;
        }
  }
  throw new Error('The paragraph identity is stale. Select it again.');
}
function assertUnresolved(
  document: ProserDocument,
  paragraph: DocumentParagraph,
  runIds: string[],
  actorId?: number,
) {
  if (
    document.changes.some(
      (change) =>
        change.status === 'pending' &&
        !canContinueManualChange(change, actorId) &&
        (change.targetBlockIds?.includes(paragraph.id) ||
          runIds.some((id) => change.targetRunIds.includes(id))),
    )
  )
    throw new Error('Resolve the pending changes in this target before changing its formatting.');
}
/** Format canonical runs, never HTML or Canvas indices. Keep comment evidence
 * and resolved/imported review targets immutable; Factory decides whether their
 * original anchors remain attached after a run split. */
export function formatDocumentSelection(
  document: ProserDocument,
  selection: DocumentSelection,
  patch: Partial<TextStyle>,
  id: () => string,
  actorId?: number,
): ProserDocument {
  const next = structuredClone(document);
  for (const target of selection.targets) {
    const paragraph = paragraphIn(next, target.blockId);
    const text = paragraph.runs
      .filter((run) => visibleRun(run, next.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    const verified = paragraphSelection(next, target.blockId, target.from, target.to, text);
    if (!verified || text.slice(target.from, target.to) !== target.sourceText)
      throw new Error('The formatting selection changed. Select the text again.');
    assertUnresolved(
      next,
      paragraph,
      verified.runs.map((run) => run.runId),
      actorId,
    );
    let offset = 0;
    paragraph.runs = paragraph.runs.flatMap((run) => {
      if (!visibleRun(run, next.changes, 'final')) return [run];
      if (run.inlineImage) {
        offset++;
        return [run];
      }
      const from = Math.max(0, target.from - offset);
      const to = Math.min(run.text.length, target.to - offset);
      offset += run.text.length;
      if (to <= from) return [run];
      const slices = [
        [0, from, false],
        [from, to, true],
        [to, run.text.length, false],
      ] as const;
      const segments = slices
        .filter(([start, end]) => end > start)
        .map(([start, end, selected], index) => ({
          start,
          end,
          run: {
            ...run,
            id: index === 0 ? run.id : id(),
            text: run.text.slice(start, end),
            style: selected ? { ...run.style, ...patch } : { ...run.style },
            ...(index > 0 &&
            run.changeId &&
            !next.changes.some(
              (change) => change.id === run.changeId && canContinueManualChange(change, actorId),
            )
              ? { changeId: undefined }
              : {}),
          },
        }));
      for (const change of next.changes)
        if (change.targetRunIds.includes(run.id) && canContinueManualChange(change, actorId))
          change.targetRunIds = [
            ...new Set([...change.targetRunIds, ...segments.map((segment) => segment.run.id)]),
          ];
      return segments.map((segment) => segment.run);
    });
  }
  return next;
}

export function formatDocumentParagraph(
  document: ProserDocument,
  blockId: string,
  patch: Partial<ParagraphStyle>,
  actorId?: number,
): ProserDocument {
  const next = structuredClone(document);
  const paragraph = paragraphIn(next, blockId);
  assertUnresolved(
    next,
    paragraph,
    paragraph.runs.map((run) => run.id),
    actorId,
  );
  paragraph.style = { ...paragraph.style, ...patch };
  return next;
}
