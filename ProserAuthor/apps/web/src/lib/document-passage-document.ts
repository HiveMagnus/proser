import {
  canonicalDocument,
  minimalTextEdit,
  visibleRun,
  type DocumentPassage,
  type DocumentParagraph,
  type DocumentRun,
  type ProserDocument,
  type DocumentPassageOperation,
  type PassageRunSource,
  type PassageStylePatch,
  type TextStyle,
  type ParagraphStyle,
} from '@cheftaco/proser-contracts';

const equal = (a: unknown, b: unknown) => canonicalDocument(a) === canonicalDocument(b);
const paragraphText = (paragraph: DocumentParagraph, changes: ProserDocument['changes']) =>
  paragraph.runs
    .filter((run) => visibleRun(run, changes, 'final'))
    .map((run) => (run.inlineImage ? '\ufffc' : run.text))
    .join('');
function stylePatch<T extends TextStyle | ParagraphStyle>(
  before: T,
  after: T,
): PassageStylePatch<T> {
  const set: Partial<T> = {};
  const unset: Array<keyof T> = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>) {
    if (equal(before[key], after[key])) continue;
    if (after[key] === undefined) unset.push(key);
    else set[key] = after[key];
  }
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}
export function passageParagraphSource(passage: DocumentPassage, blockId: string) {
  const scope = passage.paragraphs.find((item) => item.paragraph.id === blockId);
  if (!scope?.paragraphHash || !scope.containerHash)
    throw new Error('Factory did not supply a complete immutable paragraph source.');
  return { blockId, paragraphHash: scope.paragraphHash, containerHash: scope.containerHash };
}
export function passageRunSource(
  passage: DocumentPassage,
  blockId: string,
  runId: string,
): PassageRunSource {
  const paragraph = passageParagraphSource(passage, blockId);
  const source = passage.paragraphs
    .find((item) => item.paragraph.id === blockId)
    ?.runs.find((run) => run.runId === runId);
  if (!source) throw new Error('This run is outside the owned passage.');
  const run = passage.paragraphs
    .find((item) => item.paragraph.id === blockId)
    ?.paragraph.runs.find((item) => item.id === runId);
  if (!run || source.to - source.from !== (run.inlineImage ? 1 : run.text.length))
    throw new Error('The passage run has incompatible immutable source coordinates.');
  return { ...paragraph, runId, sourceHash: source.sourceHash, from: source.from, to: source.to };
}
function paragraphs(document: ProserDocument) {
  return document.blocks.flatMap((block) =>
    block.type === 'paragraph'
      ? [block]
      : block.type === 'table'
        ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
        : [],
  );
}
/** Derive only qualified immutable operations. Local Canvas IDs and attribution
 * never become authority. Objects and containers remain protected. */
export function passageDocumentOperations(
  passage: DocumentPassage,
  before: ProserDocument,
  after: ProserDocument,
  id: () => string,
): DocumentPassageOperation[] {
  if (!equal(before.layout, after.layout) || !equal(before.comments, after.comments))
    throw new Error('Save layout and comments through their owned controls.');
  const oldParagraphs = paragraphs(before);
  const newParagraphs = paragraphs(after);
  const oldObjects = before.blocks.filter((block) => !['paragraph', 'table'].includes(block.type));
  const newObjects = after.blocks.filter((block) => !['paragraph', 'table'].includes(block.type));
  if (!equal(oldObjects, newObjects))
    throw new Error('Use the passage object controls to change protected objects.');
  const tableTopology = (document: ProserDocument) =>
    document.blocks.flatMap((block) =>
      block.type === 'table'
        ? [
            [
              block.id,
              block.widths,
              block.rows.map((row) => [row.id, row.cells.map((cell) => cell.id)]),
            ],
          ]
        : [],
    );
  if (!equal(tableTopology(before), tableTopology(after)))
    throw new Error('Use the passage table controls to change containers.');
  const inlineObjects = (items: DocumentParagraph[]) =>
    items.flatMap((p) => p.runs.flatMap((run) => (run.inlineImage ? [run.inlineImage] : [])));
  if (!equal(inlineObjects(oldParagraphs), inlineObjects(newParagraphs)))
    throw new Error('Inline images are protected; use the image controls.');
  // Native paragraph split/join is represented explicitly, never as flattened prose.
  if (
    !equal(
      oldParagraphs.map((p) => p.id),
      newParagraphs.map((p) => p.id),
    )
  ) {
    if (newParagraphs.length === oldParagraphs.length + 1) {
      for (let index = 0; index < oldParagraphs.length; index++) {
        const source = oldParagraphs[index]!,
          left = newParagraphs[index]!,
          right = newParagraphs[index + 1]!;
        if (
          left.id !== source.id ||
          oldParagraphs.some((p) => p.id === right.id) ||
          !equal(
            oldParagraphs.slice(0, index).map((p) => p.id),
            newParagraphs.slice(0, index).map((p) => p.id),
          ) ||
          !equal(
            oldParagraphs.slice(index + 1).map((p) => p.id),
            newParagraphs.slice(index + 2).map((p) => p.id),
          )
        )
          continue;
        const sourceText = paragraphText(source, before.changes),
          leftText = paragraphText(left, after.changes),
          rightText = paragraphText(right, after.changes);
        if (
          sourceText !== leftText + rightText ||
          !equal(source.style, left.style) ||
          !equal(source.style, right.style)
        )
          throw new Error('Save typing and formatting before splitting the paragraph.');
        let offset = 0;
        const targets = source.runs
          .filter((run) => visibleRun(run, before.changes, 'final'))
          .flatMap((run) => {
            const start = offset;
            offset += run.inlineImage ? 1 : run.text.length;
            return !run.inlineImage && leftText.length >= start && leftText.length <= offset
              ? [{ run, start }]
              : [];
          });
        const choice =
          targets.find((target) => target.run.id === left.runs.at(-1)?.id) ?? targets[0];
        if (!choice) throw new Error('The paragraph split crosses a protected object.');
        const target = passageRunSource(passage, source.id, choice.run.id),
          caret = target.from + leftText.length - choice.start;
        const unchanged = oldParagraphs
          .filter((p) => p.id !== source.id)
          .every((p) =>
            equal(
              p,
              newParagraphs.find((candidate) => candidate.id === p.id),
            ),
          );
        if (!unchanged) throw new Error('Save unrelated edits before splitting the paragraph.');
        return [
          {
            id: id(),
            kind: 'paragraph-split',
            target: { ...target, from: caret, to: caret },
            expectedText: '',
          },
        ];
      }
    }
    if (newParagraphs.length === oldParagraphs.length - 1) {
      for (let index = 0; index < oldParagraphs.length - 1; index++) {
        const left = oldParagraphs[index]!,
          right = oldParagraphs[index + 1]!,
          joined = newParagraphs[index]!;
        if (
          joined.id !== left.id ||
          newParagraphs.some((p) => p.id === right.id) ||
          !equal(
            oldParagraphs.slice(0, index).map((p) => p.id),
            newParagraphs.slice(0, index).map((p) => p.id),
          ) ||
          !equal(
            oldParagraphs.slice(index + 2).map((p) => p.id),
            newParagraphs.slice(index + 1).map((p) => p.id),
          )
        )
          continue;
        const evidence = passage.paragraphs.find((item) => item.paragraph.id === left.id);
        if (!evidence?.boundaryAfterHash || evidence.adjacentAfterId !== right.id)
          throw new Error('Factory did not supply exact adjacent paragraph boundary evidence.');
        if (
          paragraphText(joined, after.changes) !==
            paragraphText(left, before.changes) + paragraphText(right, before.changes) ||
          !equal(joined.style, left.style)
        )
          throw new Error('Save typing and formatting before joining these paragraphs.');
        if (
          !oldParagraphs
            .filter((p) => p.id !== left.id && p.id !== right.id)
            .every((p) =>
              equal(
                p,
                newParagraphs.find((candidate) => candidate.id === p.id),
              ),
            )
        )
          throw new Error('Save unrelated edits before joining paragraphs.');
        return [
          {
            id: id(),
            kind: 'paragraph-join',
            left: passageParagraphSource(passage, left.id),
            right: passageParagraphSource(passage, right.id),
            boundaryHash: evidence.boundaryAfterHash,
          },
        ];
      }
    }
    throw new Error('Use the passage split/join controls before continuing to type.');
  }
  if (
    !equal(
      before.blocks.map((block) => [block.id, block.type]),
      after.blocks.map((block) => [block.id, block.type]),
    )
  )
    throw new Error('Use the passage object controls to change manuscript structure.');
  for (const block of before.blocks) {
    const next = after.blocks.find((item) => item.id === block.id)!;
    if (block.type === 'table') {
      if (
        next.type !== 'table' ||
        !equal(block.widths, next.widths) ||
        !equal(
          block.rows.map((row) => [row.id, row.cells.map((cell) => cell.id)]),
          next.rows.map((row) => [row.id, row.cells.map((cell) => cell.id)]),
        )
      )
        throw new Error('Use the passage table controls to edit table structure.');
    } else if (block.type !== 'paragraph' && !equal(block, next))
      throw new Error('Use the passage object controls to edit protected objects.');
  }
  const result: DocumentPassageOperation[] = [];
  for (const oldParagraph of oldParagraphs) {
    const next = newParagraphs.find((paragraph) => paragraph.id === oldParagraph.id)!;
    const oldText = paragraphText(oldParagraph, before.changes);
    const newText = paragraphText(next, after.changes);
    if (!equal(oldParagraph.style, next.style)) {
      result.push({
        id: id(),
        kind: 'paragraph-format',
        target: passageParagraphSource(passage, oldParagraph.id),
        patch: stylePatch(oldParagraph.style, next.style),
      });
    }
    const oldRuns = oldParagraph.runs.filter((run) => visibleRun(run, before.changes, 'final'));
    const nextRuns = next.runs.filter((run) => visibleRun(run, after.changes, 'final'));
    const protectedImages = (runs: DocumentRun[]) =>
      runs.flatMap((run) => (run.inlineImage ? [run.inlineImage] : []));
    if (!equal(protectedImages(oldRuns), protectedImages(nextRuns)))
      throw new Error('Inline images are protected; use the image controls.');
    if (oldText !== newText) {
      const edit = minimalTextEdit(oldText, newText);
      let offset = 0;
      const targets = oldRuns.flatMap((run) => {
        const start = offset;
        offset += run.inlineImage ? 1 : run.text.length;
        return !run.inlineImage && edit.start >= start && edit.end <= offset
          ? [{ run, start }]
          : [];
      });
      // An insertion at two adjacent run boundaries requires an explicit selected run.
      if (targets.length !== 1)
        throw new Error(
          'This edit crosses style or object boundaries. Edit one styled run at a time.',
        );
      const { run, start } = targets[0]!;
      const source = passageRunSource(passage, oldParagraph.id, run.id);
      result.push({
        id: id(),
        kind: 'text',
        target: {
          ...source,
          from: source.from + edit.start - start,
          to: source.from + edit.end - start,
        },
        expectedText: oldText.slice(edit.start, edit.end),
        replacement: edit.replacement,
      });
      // A simultaneous style edit must never silently disappear behind typing.
      const insertedStyles = nextRuns
        .filter((candidate) => !candidate.inlineImage)
        .map((candidate) => candidate.style);
      if (!insertedStyles.every((style) => oldRuns.some((old) => equal(old.style, style))))
        throw new Error('Save typing before applying new formatting to the same passage.');
      continue;
    }
    let oldOffset = 0;
    for (const run of oldRuns) {
      const start = oldOffset;
      const end = start + (run.inlineImage ? 1 : run.text.length);
      oldOffset = end;
      if (run.inlineImage) continue;
      let nextOffset = 0;
      const changed = nextRuns.flatMap((candidate) => {
        const left = nextOffset;
        const right = left + (candidate.inlineImage ? 1 : candidate.text.length);
        nextOffset = right;
        const from = Math.max(start, left),
          to = Math.min(end, right);
        return to > from && !equal(run.style, candidate.style)
          ? [{ from, to, style: candidate.style }]
          : [];
      });
      if (!changed.length) continue;
      if (
        changed.some((range) => !equal(range.style, changed[0]!.style)) ||
        changed.some((range, index) => index > 0 && range.from !== changed[index - 1]!.to)
      )
        throw new Error(
          'Save each formatting selection before formatting another part of this run.',
        );
      const from = changed[0]!.from,
        to = changed.at(-1)!.to;
      const source = passageRunSource(passage, oldParagraph.id, run.id);
      result.push({
        id: id(),
        kind: 'run-format',
        target: { ...source, from: source.from + from - start, to: source.from + to - start },
        expectedText: oldText.slice(from, to),
        patch: stylePatch(run.style, changed[0]!.style),
      });
    }
  }
  if (result.length > 32) throw new Error('Save at most thirty-two passage targets together.');
  return result;
}

/** Compose only the supplied ordered fragments. Incomplete table cells never
 * stand in for neighbours that Factory has not delivered. */
export function passageDocument(passage: DocumentPassage): ProserDocument {
  const blocks: ProserDocument['blocks'] = [];
  const used = new Set<number>();
  const paragraphAt = (index: number) => {
    const paragraph = passage.paragraphs[index];
    if (!paragraph || used.has(index))
      throw new Error('Factory returned an invalid ordered paragraph address.');
    used.add(index);
    return structuredClone(paragraph.paragraph);
  };
  if (!passage.items) {
    if (
      passage.paragraphs.some((paragraph) => paragraph.container) ||
      passage.images.length ||
      passage.omitted.objects
    )
      throw new Error('This Factory passage requires the ordered object transport.');
    blocks.push(...passage.paragraphs.map((item) => structuredClone(item.paragraph)));
  } else {
    let previousOrdinal = -1;
    for (const item of passage.items) {
      if (item.blockOrdinal <= previousOrdinal)
        throw new Error('Factory returned unordered or duplicate body blocks.');
      previousOrdinal = item.blockOrdinal;
      if (item.type === 'paragraph') {
        const paragraph = passage.paragraphs[item.paragraphIndex];
        if (paragraph?.container)
          throw new Error('A table-cell paragraph cannot become a body paragraph.');
        blocks.push(paragraphAt(item.paragraphIndex));
      } else if (item.type === 'image') blocks.push(structuredClone(item.image));
      else if (item.type === 'pageBreak') blocks.push(structuredClone(item.pageBreak));
      else {
        let previousRow = -1;
        const rows = item.rows.map((row) => {
          if (row.ordinal <= previousRow || row.ordinal >= item.rowCount)
            throw new Error('Factory returned unordered table rows.');
          previousRow = row.ordinal;
          let previousColumn = -1;
          return {
            id: row.id,
            cells: row.cells.map((cell) => {
              if (cell.columnIndex <= previousColumn || cell.columnIndex >= item.columnCount)
                throw new Error('Factory returned unordered table columns.');
              previousColumn = cell.columnIndex;
              return {
                id: cell.id,
                paragraphs: cell.paragraphIndexes.map((index) => {
                  const container = passage.paragraphs[index]?.container;
                  if (
                    container?.tableId !== item.id ||
                    container.rowId !== row.id ||
                    container.cellId !== cell.id ||
                    container.columnIndex !== cell.columnIndex ||
                    container.rowOrdinal !== row.ordinal
                  )
                    throw new Error('Factory returned an incompatible table-cell paragraph owner.');
                  return paragraphAt(index);
                }),
              };
            }),
          };
        });
        blocks.push({ type: 'table', id: item.id, widths: structuredClone(item.widths), rows });
      }
    }
    if (used.size !== passage.paragraphs.length)
      throw new Error('The ordered transport omitted a supplied paragraph.');
  }
  return {
    schemaVersion: 1,
    blocks,
    changes: structuredClone(passage.changes),
    comments: [],
    layout: { ...structuredClone(passage.layout), header: [], footer: [] },
  };
}

export function passageHasPartialTable(passage: DocumentPassage) {
  return (
    passage.items?.some(
      (item) =>
        item.type === 'tableSlice' &&
        (item.continuedBefore ||
          item.continuedAfter ||
          item.rows.length !== item.rowCount ||
          item.rows.some(
            (row) =>
              row.cells.length !== item.columnCount ||
              row.cells.some((cell) => cell.continuedBefore || cell.continuedAfter),
          )),
    ) ?? false
  );
}
