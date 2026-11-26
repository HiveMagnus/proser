import {
  minimalTextEdit,
  type DocumentPassage,
  type DocumentPassageCommit,
  type DocumentPassageTextEdit,
} from '@hivemagnus/proser-contracts';

/** A replacement concerns the displayed fragment of one immutable canonical run. */
export interface PassageRunDraft {
  blockId: string;
  runId: string;
  text: string;
}
function graphemeBoundary(text: string, offset: number) {
  if (offset === 0 || offset === text.length) return true;
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).some(
    (segment) => segment.index === offset,
  );
}
/** Never infer a target from quotation matches or join different style/container scopes. */
export function passageRunEdits(
  passage: DocumentPassage,
  drafts: PassageRunDraft[],
): DocumentPassageTextEdit[] {
  const seen = new Set<string>();
  const edits = drafts.flatMap((draft) => {
    const key = JSON.stringify([draft.blockId, draft.runId]);
    if (seen.has(key)) throw new Error('A passage contains duplicate run targets.');
    seen.add(key);
    const scopes = passage.paragraphs.filter((scope) => scope.paragraph.id === draft.blockId);
    if (scopes.length !== 1) throw new Error('This paragraph is outside the retained passage.');
    const scope = scopes[0]!;
    const sources = scope.runs.filter((run) => run.runId === draft.runId);
    const runs = scope.paragraph.runs.filter((run) => run.id === draft.runId);
    if (sources.length !== 1 || runs.length !== 1)
      throw new Error('This run changed before editing.');
    const source = sources[0]!;
    const run = runs[0]!;
    if (run.inlineImage) throw new Error('An inline image is a protected object.');
    if (source.to - source.from !== run.text.length)
      throw new Error('This passage fragment has inconsistent source offsets.');
    if (
      draft.text.length > 32768 ||
      draft.text.includes(String.fromCharCode(0)) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(draft.text)
    )
      throw new Error('This passage edit exceeds the text limit or contains invalid Unicode.');
    const edit = minimalTextEdit(run.text, draft.text);
    if (run.text === draft.text) return [];
    if (!graphemeBoundary(run.text, edit.start) || !graphemeBoundary(run.text, edit.end))
      throw new Error('This edit splits a Unicode grapheme.');
    return [
      {
        blockId: draft.blockId,
        runId: draft.runId,
        sourceHash: source.sourceHash,
        from: source.from + edit.start,
        to: source.from + edit.end,
        expectedText: run.text.slice(edit.start, edit.end),
        replacement: edit.replacement,
      },
    ];
  });
  if (edits.length > 32) throw new Error('Save at most thirty-two passage targets together.');
  return edits;
}
export function passageCommit(
  passage: DocumentPassage,
  drafts: PassageRunDraft[],
  operationId: string,
  tracking: boolean,
  bounds: { maxCharacters?: number; maxParagraphs?: number } = {},
): DocumentPassageCommit {
  const edits = passageRunEdits(passage, drafts);
  if (!edits.length) throw new Error('This passage has no changed text.');
  return {
    schemaVersion: 1,
    operationId,
    expectedRevisionId: passage.bookRevisionId,
    expectedSceneRevisionId: passage.sceneRevisionId,
    windowHash: passage.windowHash,
    cursor: structuredClone(passage.cursor),
    ...bounds,
    edits,
    tracking,
  };
}
