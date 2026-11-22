import {randomUUID} from 'node:crypto';
import { documentFromText, type ProserDocument, type DocumentBlock } from './model';
function identities(blocks: DocumentBlock[]): {
  blocks: Set<string>;
  runs: Set<string>;
  all: Set<string>;
} {
  const result = { blocks: new Set<string>(), runs: new Set<string>(), all: new Set<string>() };
  for (const block of blocks) {
    result.blocks.add(block.id);
    result.all.add(block.id);
    if (block.type === 'paragraph')
      for (const run of block.runs) {
        result.runs.add(run.id);
        result.all.add(run.id);
      }
    if (block.type === 'table')
      for (const row of block.rows) {
        result.all.add(row.id);
        for (const cell of row.cells) {
          result.all.add(cell.id);
          for (const paragraph of cell.paragraphs) {
            result.blocks.add(paragraph.id);
            result.all.add(paragraph.id);
            for (const run of paragraph.runs) {
              result.runs.add(run.id);
              result.all.add(run.id);
            }
          }
        }
      }
  }
  return result;
}
/** Move whole canonical blocks between owned scenes. No quotation lookup or
 * formatting reconstruction participates; objects and fully-contained review
 * records retain their identities. Mixed-scope annotations fail visibly. */
export function moveDocumentBlocks(
  source: ProserDocument,
  destination: ProserDocument,
  blockIds: string[],
  placement: 'start' | 'end',
  id: () => string = randomUUID,
): { source: ProserDocument; destination: ProserDocument } {
  if (!blockIds.length || new Set(blockIds).size !== blockIds.length)
    throw new Error('Select distinct complete blocks to move.');
  // Scene.layout is an immutable compatibility snapshot. The endpoint binds
  // the owned source/destination layout scopes; each saved scene keeps its own snapshot.
  const chosen = new Set(blockIds);
  const blocks = source.blocks.filter((block) => chosen.has(block.id));
  if (blocks.length !== blockIds.length)
    throw new Error('A selected block identity is stale. Select the blocks again.');
  const moved = identities(blocks);
  const existing = identities(destination.blocks);
  if ([...moved.all].some((id) => existing.all.has(id)))
    throw new Error('The destination already contains one of these identities.');
  const changes = source.changes.filter((change) => {
    const targets = [...change.targetRunIds, ...(change.targetBlockIds ?? [])];
    const inside = targets.filter((id) => moved.runs.has(id) || moved.blocks.has(id));
    if (inside.length && inside.length !== targets.length)
      throw new Error(
        'A review change crosses the move boundary. Resolve it or select its complete target.',
      );
    return inside.length > 0;
  });
  const comments = source.comments.filter((comment) => {
    const inside = comment.anchors.filter(
      (anchor) => moved.blocks.has(anchor.blockId) && moved.runs.has(anchor.runId),
    );
    if (inside.length && inside.length !== comment.anchors.length)
      throw new Error('A comment crosses the move boundary. Move its complete anchor range.');
    return inside.length > 0;
  });
  if (
    changes.some((change) => destination.changes.some((existing) => existing.id === change.id)) ||
    comments.some((comment) => destination.comments.some((existing) => existing.id === comment.id))
  )
    throw new Error('The destination already contains this review identity.');
  const nextSource = structuredClone(source);
  const nextDestination = structuredClone(destination);
  nextSource.blocks = nextSource.blocks.filter((block) => !chosen.has(block.id));
  if (!nextSource.blocks.length) nextSource.blocks = documentFromText('',id).blocks;
  nextSource.changes = nextSource.changes.filter(
    (change) => !changes.some((moved) => moved.id === change.id),
  );
  nextSource.comments = nextSource.comments.filter(
    (comment) => !comments.some((moved) => moved.id === comment.id),
  );
  const ownedBlocks = structuredClone(blocks);
  nextDestination.blocks =
    placement === 'start'
      ? [...ownedBlocks, ...nextDestination.blocks]
      : [...nextDestination.blocks, ...ownedBlocks];
  nextDestination.changes.push(...structuredClone(changes));
  nextDestination.comments.push(...structuredClone(comments));
  return { source: nextSource, destination: nextDestination };
}
