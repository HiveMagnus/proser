import {
  canonicalDocument,
  paragraphBoundaryVisible,
  paragraphsOf,
  projectDocument,
  type ProserDocument,
  type DocumentParagraph,
  type DocumentRun,
  type DocumentBlock,
  type DocumentAnchorLineage,
} from './document-model';
import { moveDocumentBlocks } from './window-operations';
export interface SceneBoundaryResult {
  left: ProserDocument;
  right: ProserDocument;
  anchorLineage: DocumentAnchorLineage[];
}
function sameLayout(left: ProserDocument, right: ProserDocument) {
  if (canonicalDocument(left.layout) !== canonicalDocument(right.layout))
    throw new Error('Reconcile the scene layouts before changing their formatted boundary.');
}
export function movedBlockLineage(
  blocks: DocumentBlock[],
  sourceSceneId: number,
  targetSceneId: number,
  kind: DocumentAnchorLineage['kind'] = 'move',
): DocumentAnchorLineage[] {
  return paragraphsOf({ blocks } as ProserDocument).flatMap((paragraph) =>
    paragraph.runs
      .filter((run) => !run.inlineImage && run.text.length)
      .map((run) => ({
        kind,
        source: {
          sceneId: sourceSceneId,
          blockId: paragraph.id,
          runId: run.id,
          from: 0,
          to: run.text.length,
        },
        target: {
          sceneId: targetSceneId,
          blockId: paragraph.id,
          runId: run.id,
          from: 0,
          to: run.text.length,
        },
      })),
  );
}
/** Split an explicit canonical paragraph caret into the following scene. All
 * following complete blocks transfer atomically; crossing review is rejected. */
export function splitDocumentSceneBoundary(
  left: ProserDocument,
  right: ProserDocument,
  leftSceneId: number,
  rightSceneId: number,
  blockId: string,
  offset: number,
  id: () => string,
): SceneBoundaryResult {
  sameLayout(left, right);
  const index = left.blocks.findIndex((block) => block.id === blockId);
  const block = left.blocks[index];
  if (!block || block.type !== 'paragraph')
    throw new Error('Select a body paragraph caret before splitting scenes.');
  const runIds = new Set(block.runs.map((run) => run.id));
  if (
    block.boundaryChangeId ||
    block.changeId ||
    left.changes.some(
      (change) =>
        change.targetBlockIds?.includes(blockId) ||
        change.targetRunIds.some((runId) => runIds.has(runId)),
    ) ||
    left.comments.some((comment) => comment.anchors.some((anchor) => anchor.blockId === blockId))
  )
    throw new Error(
      'This paragraph has review anchors. Move its complete blocks to preserve them.',
    );
  const text = block.runs.map((run) => (run.inlineImage ? '\ufffc' : run.text)).join('');
  const boundaries = new Set([
    0,
    text.length,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (entry) => entry.index,
    ),
  ]);
  if (!Number.isSafeInteger(offset) || !boundaries.has(offset))
    throw new Error('The scene boundary must be a complete Unicode grapheme.');
  const first = { ...structuredClone(block), runs: [] as DocumentRun[] };
  const second: DocumentParagraph = {
    type: 'paragraph',
    id: id(),
    style: structuredClone(block.style),
    runs: [],
  };
  const anchorLineage: DocumentAnchorLineage[] = [];
  let position = 0;
  for (const run of block.runs) {
    const length = run.inlineImage ? 1 : run.text.length;
    const cut = Math.max(0, Math.min(length, offset - position));
    if (cut === length) first.runs.push(structuredClone(run));
    else if (cut === 0) {
      second.runs.push(structuredClone(run));
      if (!run.inlineImage && length)
        anchorLineage.push({
          kind: 'split',
          source: { sceneId: leftSceneId, blockId, runId: run.id, from: 0, to: length },
          target: { sceneId: rightSceneId, blockId: second.id, runId: run.id, from: 0, to: length },
        });
    } else {
      if (run.inlineImage) throw new Error('A scene boundary cannot split an inline image.');
      first.runs.push({ ...structuredClone(run), text: run.text.slice(0, cut) });
      const fragment = { ...structuredClone(run), id: id(), text: run.text.slice(cut) };
      second.runs.push(fragment);
      anchorLineage.push({
        kind: 'split',
        source: { sceneId: leftSceneId, blockId, runId: run.id, from: cut, to: length },
        target: {
          sceneId: rightSceneId,
          blockId: second.id,
          runId: fragment.id,
          from: 0,
          to: fragment.text.length,
        },
      });
    }
    position += length;
  }
  if (!first.runs.length) first.runs.push({ id: id(), text: '', style: {} });
  if (!second.runs.length) second.runs.push({ id: id(), text: '', style: {} });
  const following = left.blocks.slice(index + 1);
  const moved = following.length
    ? moveDocumentBlocks(
        left,
        right,
        following.map((block) => block.id),
        'start',
      )
    : { source: structuredClone(left), destination: structuredClone(right) };
  moved.source.blocks[index] = first;
  moved.destination.blocks.unshift(second);
  anchorLineage.push(...movedBlockLineage(following, leftSceneId, rightSceneId));
  return { left: moved.source, right: moved.destination, anchorLineage };
}
/** Keep both physical paragraphs when joining the scene boundary. A resolved
 * manual boundary record gives all projections the direct edit; manual tracking
 * leaves it pending so original and final remain independently reviewable. */
export function joinDocumentSceneBoundary(
  left: ProserDocument,
  right: ProserDocument,
  leftSceneId: number,
  rightSceneId: number,
  id: () => string,
  track = false,
): SceneBoundaryResult {
  sameLayout(left, right);
  const last = left.blocks.at(-1);
  const first = right.blocks[0];
  if (last?.type !== 'paragraph' || first?.type !== 'paragraph')
    throw new Error('The scene boundary must contain two body paragraphs.');
  if (canonicalDocument(last.style) !== canonicalDocument(first.style))
    throw new Error(
      'The boundary paragraphs have incompatible styles. Reconcile their styles before joining.',
    );
  if (last.boundaryChangeId)
    throw new Error('Resolve the existing paragraph boundary before joining another scene.');
  const leftText = projectDocument({ ...left, blocks: [last] }).text;
  const joinedText = leftText + projectDocument({ ...right, blocks: [first] }).text;
  const boundaries = new Set([
    0,
    joinedText.length,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(joinedText),
      (entry) => entry.index,
    ),
  ]);
  if (!boundaries.has(leftText.length))
    throw new Error('Joining this boundary would split a Unicode grapheme across paragraphs.');
  const group: DocumentParagraph[] = [first];
  while (right.blocks[group.length]?.type === 'paragraph') {
    const next = right.blocks[group.length] as DocumentParagraph;
    if (paragraphBoundaryVisible(group.at(-1)!, next, right.changes, 'final')) break;
    group.push(next);
  }
  const moved = moveDocumentBlocks(
    right,
    left,
    group.map((block) => block.id),
    'end',
  );
  const changeId = id();
  const boundary = moved.destination.blocks.find(
    (block) => block.id === last.id,
  ) as DocumentParagraph;
  boundary.boundaryChangeId = changeId;
  moved.destination.changes.push({
    id: changeId,
    kind: 'paragraphJoin',
    targetRunIds: [],
    targetBlockIds: [last.id, first.id],
    origin: 'manual',
    status: track ? 'pending' : 'accepted',
    authorId: 0,
    authorName: '',
    createdAt: new Date().toISOString(),
  });
  return {
    left: moved.destination,
    right: moved.source,
    anchorLineage: movedBlockLineage(group, rightSceneId, leftSceneId, 'join'),
  };
}
export const reverseAnchorLineage = (lineage: DocumentAnchorLineage[]): DocumentAnchorLineage[] =>
  lineage.map((mapping) => ({
    // Identity-changing inverses are valid only with an exact owned revision restoration.
    kind: 'restore',
    source: { ...mapping.target },
    target: { ...mapping.source },
  }));
