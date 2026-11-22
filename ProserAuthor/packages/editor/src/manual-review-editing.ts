import {
  canonicalDocument,
  minimalTextEdit,
  paragraphsOf,
  projectDocument,
  replaceDocumentText,
  visibleRun,
  type ProserDocument,
  type DocumentChange,
  type DocumentRun,
} from './document-model';
export const canContinueManualChange = (change: DocumentChange, actorId?: number) =>
  Boolean(
    actorId &&
    change.status === 'pending' &&
    change.origin === 'manual' &&
    change.authorId === actorId &&
    !change.importedAuthor &&
    ['insertion', 'paragraphInsertion'].includes(change.kind),
  );
/** Continue only the authenticated actor's manual insertion; other pending
 * changes keep their immutable protected targets. Attribution is never edited. */
export function carryManualTargets(
  previous: ProserDocument,
  next: ProserDocument,
  actorId?: number,
): ProserDocument {
  const paragraphs = paragraphsOf(next, true);
  for (const change of next.changes) {
    const original = previous.changes.find((item) => item.id === change.id);
    if (!original || !canContinueManualChange(original, actorId)) continue;
    if (change.kind === 'insertion') {
      const ids = paragraphs.flatMap((paragraph) =>
        paragraph.runs.filter((run) => run.changeId === change.id).map((run) => run.id),
      );
      change.targetRunIds = [...new Set([...original.targetRunIds, ...ids])];
    } else
      change.targetBlockIds = [
        ...new Set([
          ...(original.targetBlockIds ?? []),
          ...paragraphs
            .filter((paragraph) => paragraph.changeId === change.id)
            .map((paragraph) => paragraph.id),
        ]),
      ];
  }
  return next;
}
export function trackManualDocumentEdit(
  previous: ProserDocument,
  next: ProserDocument,
  actorId: number,
  id: () => string,
): ProserDocument {
  const before = projectDocument(previous);
  const after = projectDocument(next);
  const attribute = {
    authorId: actorId,
    authorName: 'You',
    createdAt: new Date().toISOString(),
    origin: 'manual' as const,
    status: 'pending' as const,
  };
  if (before.text !== after.text) {
    // Paragraph mark changes already have their own native durable record.
    if (
      next.changes.some(
        (change) =>
          !previous.changes.some((old) => old.id === change.id) &&
          ['paragraphSplit', 'paragraphJoin'].includes(change.kind),
      )
    ) {
      if (projectDocument(next, 'original').text !== projectDocument(previous, 'original').text)
        throw new Error(
          'This paste combines paragraph boundaries and untracked text. Paste into one paragraph or switch off tracking before proceeding.',
        );
      return next;
    }
    const edit = minimalTextEdit(before.text, after.text);
    const points = before.spans.filter((span) =>
      edit.start === edit.end
        ? span.start <= edit.start && span.end >= edit.start
        : span.end > edit.start && span.start < edit.end,
    );
    const oldRuns = new Map(
      paragraphsOf(previous).flatMap((paragraph) =>
        paragraph.runs.map((run) => [run.id, run] as const),
      ),
    );
    const continuations = points.flatMap((span) => {
      const run = oldRuns.get(span.runId ?? '');
      const change = previous.changes.find((change) => change.id === run?.changeId);
      return change && canContinueManualChange(change, actorId) ? [change] : [];
    });
    if (continuations.length && (edit.start === edit.end || continuations.length === points.length))
      return carryManualTargets(previous, next, actorId);
    const insertedSpans = after.spans.filter(
      (span) =>
        span.editable &&
        span.start <= edit.start &&
        span.end >= edit.start + edit.replacement.length,
    );
    const insertedBlockIds = [...new Set(insertedSpans.map((span) => span.blockId))];
    const insertionTarget =
      edit.start === edit.end && insertedBlockIds.length === 1
        ? {
            blockId: insertedBlockIds[0]!,
            ...(insertedSpans.length === 1 && oldRuns.has(insertedSpans[0]!.runId ?? '')
              ? { runId: insertedSpans[0]!.runId }
              : {}),
          }
        : undefined;
    const tracked = replaceDocumentText(
      previous,
      edit.start,
      edit.end,
      before.text.slice(edit.start, edit.end),
      edit.replacement,
      id,
      attribute,
      insertionTarget,
    );
    if (projectDocument(tracked).text !== after.text)
      throw new Error(
        'This tracked edit changes multiple incompatible containers. Select a single text target.',
      );
    const rawRuns = new Map(
      paragraphsOf(next).flatMap((paragraph) =>
        paragraph.runs.map((run) => [run.id, run] as const),
      ),
    );
    const spans = projectDocument(tracked).spans;
    for (const paragraph of paragraphsOf(tracked))
      for (const run of paragraph.runs) {
        const change = tracked.changes.find(
          (change) =>
            change.id === run.changeId && !previous.changes.some((old) => old.id === change.id),
        );
        if (change?.kind !== 'insertion') continue;
        const span = spans.find((span) => span.runId === run.id)!;
        const raw = after.spans.find(
          (candidate) =>
            candidate.blockId === span.blockId &&
            candidate.start <= span.start &&
            candidate.end >= span.end,
        );
        if (!raw)
          throw new Error(
            'The inserted text crosses incompatible formatting. Use a single formatted target.',
          );
        run.style = { ...rawRuns.get(raw.runId ?? '')!.style };
      }
    return tracked;
  }
  // Formatting is tracked per exact resulting run/paragraph with its prior style.
  const result = structuredClone(next);
  const oldParagraphs = new Map(
    paragraphsOf(previous).map((paragraph) => [paragraph.id, paragraph]),
  );
  for (const paragraph of paragraphsOf(result)) {
    const old = oldParagraphs.get(paragraph.id);
    if (!old) continue;
    if (canonicalDocument(old.style) !== canonicalDocument(paragraph.style))
      result.changes.push({
        ...attribute,
        id: id(),
        kind: 'paragraphFormat',
        targetRunIds: [],
        targetBlockIds: [paragraph.id],
        beforeParagraphStyle: { ...old.style },
        afterParagraphStyle: { ...paragraph.style },
      });
    let position = 0;
    const oldSpans: Array<{ start: number; end: number; run: DocumentRun }> = [];
    for (const run of old.runs.filter((run) => visibleRun(run, previous.changes, 'final'))) {
      const length = run.inlineImage ? 1 : run.text.length;
      oldSpans.push({ start: position, end: position + length, run });
      position += length;
    }
    position = 0;
    for (const run of paragraph.runs.filter((run) => visibleRun(run, result.changes, 'final'))) {
      const length = run.inlineImage ? 1 : run.text.length;
      const sources = oldSpans.filter(
        (span) => span.end > position && span.start < position + length,
      );
      position += length;
      if (run.inlineImage || !sources.length) continue;
      if (
        sources.some(
          (source) =>
            canonicalDocument(source.run.style) !== canonicalDocument(sources[0]!.run.style),
        )
      )
        throw new Error(
          'Tracked formatting crosses incompatible source styles. Select them separately.',
        );
      const original = sources[0]!.run;
      if (canonicalDocument(original.style) === canonicalDocument(run.style)) continue;
      const insertion = previous.changes.find((change) => change.id === original.changeId);
      if (insertion && canContinueManualChange(insertion, actorId)) continue;
      if (
        previous.changes.some(
          (change) => change.status === 'pending' && change.targetRunIds.includes(original.id),
        )
      )
        throw new Error('Resolve the pending formatting in this target first.');
      result.changes.push({
        ...attribute,
        id: id(),
        kind: 'format',
        targetRunIds: [run.id],
        beforeStyle: { ...original.style },
        afterStyle: { ...run.style },
      });
    }
  }
  return carryManualTargets(previous, result, actorId);
}

/** Semantic edits use paragraph identities and complete graphemes. Continuing
 * an owned pending insertion retains its record and run IDs, including empty
 * targets when its provisional text is erased. */
export function editManualParagraphText(
  document: ProserDocument,
  blockId: string,
  text: string,
  actorId: number | undefined,
  track: boolean,
  id: () => string,
): ProserDocument {
  const projection = projectDocument(document);
  const paragraph = paragraphsOf(document).find((paragraph) => paragraph.id === blockId);
  if (!paragraph) throw new Error('This paragraph changed before editing.');
  // Separators also carry the following paragraph ID, but are not part of
  // its editable textarea. Keep actual run spans, including protected images.
  const spans = projection.spans.filter(
    (span) => span.blockId === blockId && span.runId !== undefined,
  );
  const first = spans[0];
  const last = spans.at(-1);
  if (!first || !last) throw new Error('This paragraph has no editable text scope.');
  const source = projection.text.slice(first.start, last.end);
  const edit = minimalTextEdit(source, text);
  if (source === text) return document;
  let position = 0;
  const ranges = paragraph.runs
    .filter((run) => visibleRun(run, document.changes, 'final'))
    .map((run) => {
      const start = position;
      position += run.inlineImage ? 1 : run.text.length;
      return { run, start, end: position };
    });
  const affected = ranges.filter((range) =>
    edit.start === edit.end
      ? range.start <= edit.start && range.end >= edit.start
      : range.end > edit.start && range.start < edit.end,
  );
  const owned = affected.filter((range) =>
    document.changes.some(
      (change) => change.id === range.run.changeId && canContinueManualChange(change, actorId),
    ),
  );
  if (owned.length && (edit.start === edit.end || owned.length === affected.length)) {
    const next = structuredClone(document);
    const target = paragraphsOf(next).find((paragraph) => paragraph.id === blockId)!;
    let inserted = false;
    for (const range of owned) {
      const run = target.runs.find((run) => run.id === range.run.id)!;
      const from = Math.max(0, edit.start - range.start);
      const to = Math.min(run.text.length, edit.end - range.start);
      run.text = run.text.slice(0, from) + (inserted ? '' : edit.replacement) + run.text.slice(to);
      inserted = true;
    }
    if (
      projectDocument(next).text !==
      projection.text.slice(0, first.start) + text + projection.text.slice(last.end)
    )
      throw new Error('The manual edit crosses an incompatible pending target.');
    return carryManualTargets(document, next, actorId);
  }
  return replaceDocumentText(
    document,
    first.start + edit.start,
    first.start + edit.end,
    source.slice(edit.start, edit.end),
    edit.replacement,
    id,
    track && actorId
      ? {
          authorId: actorId,
          authorName: 'You',
          createdAt: new Date().toISOString(),
          origin: 'manual',
          status: 'pending',
        }
      : undefined,
    edit.start === edit.end
      ? { blockId, ...(affected.length === 1 ? { runId: affected[0]!.run.id } : {}) }
      : undefined,
  );
}
