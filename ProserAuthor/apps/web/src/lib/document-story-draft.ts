import {
  canonicalDocument,
  minimalTextEdit,
  paragraphsOf,
  visibleParagraph,
  visibleRun,
  type DocumentStorySourceRecord,
  type DocumentPassageOperation,
  type DocumentTargetInput,
  type ProserDocument,
  type DocumentParagraph,
  type PassageParagraphSource,
} from '@cheftaco/proser-contracts';
const equal = (a: unknown, b: unknown) => canonicalDocument(a) === canonicalDocument(b);
async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalDocument(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function skeleton(doc: ProserDocument) {
  const copy = structuredClone(doc);
  for (const paragraph of paragraphsOf(copy)) {
    paragraph.runs = [];
    paragraph.style = {};
  }
  return copy;
}
function paragraphContainer(doc: ProserDocument, id: string) {
  if (doc.blocks.some((b) => b.type === 'paragraph' && b.id === id))
    return { kind: 'body', blocks: doc.blocks.map((b) => ({ id: b.id, type: b.type })) };
  for (const table of doc.blocks)
    if (table.type === 'table')
      for (const row of table.rows)
        for (const cell of row.cells)
          if (cell.paragraphs.some((p) => p.id === id))
            return {
              kind: 'table-cell',
              tableId: table.id,
              widths: table.widths,
              rows: table.rows.map((r) => ({
                id: r.id,
                cells: r.cells.map((c) => ({
                  id: c.id,
                  paragraphIds: c.paragraphs.map((p) => p.id),
                })),
              })),
              rowId: row.id,
              cellId: cell.id,
            };
  throw new Error('The story paragraph has no saved container.');
}
function patch<T extends object>(before: T, after: T) {
  const set: Partial<T> = {},
    unset: Array<keyof T> = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>) {
    if (equal(before[key], after[key])) continue;
    if (after[key] === undefined) unset.push(key);
    else set[key] = after[key];
  }
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}
const metadata = (paragraph: DocumentParagraph) => {
  const { runs: _runs, ...rest } = paragraph;
  return rest;
};
const runMetadata = (run: DocumentParagraph['runs'][number]) => {
  const { text: _text, style: _style, ...rest } = run;
  return rest;
};
export interface StoryDraftContext {
  targets: DocumentTargetInput[];
  localOperations?: { operationId: string; operations: DocumentPassageOperation[] };
}
/** Exact owned identities only. Unsupported local object/container changes must
 * be saved through the layout journal before discussion context is prepared. */
export async function storyDraftContext(
  source: DocumentStorySourceRecord,
  current: ProserDocument,
  operationId: string,
  operationIds: (key: string) => string,
): Promise<StoryDraftContext> {
  if (!equal(skeleton(source.document), skeleton(current)))
    throw new Error(
      'Save story structure, objects, layout or review changes before preparing context.',
    );
  const saved = paragraphsOf(source.document),
    newer = paragraphsOf(current);
  if (saved.length !== newer.length) throw new Error('Save the changed story structure first.');
  const operations: DocumentPassageOperation[] = [];
  for (let index = 0; index < saved.length; index++) {
    const before = saved[index]!,
      after = newer[index]!;
    if (before.id !== after.id)
      throw new Error('The story paragraph identity changed. Save it first.');
    const target: PassageParagraphSource = {
      blockId: before.id,
      paragraphHash: await digest(metadata(before)),
      containerHash: await digest(paragraphContainer(source.document, before.id)),
    };
    if (!equal(before.style, after.style))
      operations.push({
        id: operationIds(before.id + ':paragraph-format'),
        kind: 'paragraph-format',
        target,
        patch: patch(before.style, after.style),
      });
    let nextRuns = after.runs;
    // Canvas may split a homogeneous text run during typing. Retain the original
    // run as the exact source; protected/styled/review-bearing runs cannot coalesce.
    if (
      before.runs.length === 1 &&
      !equal(
        before.runs.map((r) => r.id),
        after.runs.map((r) => r.id),
      )
    ) {
      const original = before.runs[0]!;
      const { id: _id, ...originalMeta } = runMetadata(original);
      if (
        original.inlineImage ||
        original.changeId ||
        source.document.changes.some(
          (change) => change.status === 'pending' && change.targetRunIds.includes(original.id),
        ) ||
        !after.runs.length ||
        after.runs.some((run) => {
          const { id: _nextId, ...nextMeta } = runMetadata(run);
          return !equal(originalMeta, nextMeta) || !equal(original.style, run.style);
        })
      )
        throw new Error('Save the changed styled run identities before preparing context.');
      nextRuns = [{ ...original, text: after.runs.map((r) => r.text).join('') }];
    }
    if (before.runs.length !== nextRuns.length)
      throw new Error('Save the changed styled run structure first.');
    for (let r = 0; r < before.runs.length; r++) {
      const old = before.runs[r]!,
        next = nextRuns[r]!;
      if (!equal(runMetadata(old), runMetadata(next)))
        throw new Error('Save changed protected run metadata first.');
      if (old.inlineImage && !equal(old, next))
        throw new Error('Save image changes before preparing context.');
      const textChanged = old.text !== next.text,
        formatChanged = !equal(old.style, next.style);
      if (textChanged && formatChanged)
        throw new Error('Save combined text and formatting changes before preparing context.');
      const runSource = {
        ...target,
        runId: old.id,
        sourceHash: await digest(old),
        from: 0,
        to: old.text.length,
      };
      if (textChanged) {
        const edit = minimalTextEdit(old.text, next.text);
        operations.push({
          id: operationIds(old.id + ':text'),
          kind: 'text',
          target: { ...runSource, from: edit.start, to: edit.end },
          expectedText: old.text.slice(edit.start, edit.end),
          replacement: edit.replacement,
        });
      } else if (formatChanged)
        operations.push({
          id: operationIds(old.id + ':run-format'),
          kind: 'run-format',
          target: runSource,
          expectedText: old.text,
          patch: patch(old.style, next.style),
        });
    }
  }
  if (
    operations.length > 32 ||
    new TextEncoder().encode(canonicalDocument(operations)).byteLength > 256 * 1024
  )
    throw new Error('Save this large draft before preparing bounded story context.');
  const targets = newer
    .filter((p) => visibleParagraph(p, current.changes, 'final'))
    .map((p) => {
      const text = p.runs
        .filter((r) => visibleRun(r, current.changes, 'final'))
        .map((r) => (r.inlineImage ? '\ufffc' : r.text))
        .join('');
      return { blockId: p.id, from: 0, to: text.length, sourceText: text };
    });
  return {
    targets,
    ...(operations.length ? { localOperations: { operationId, operations } } : {}),
  };
}
