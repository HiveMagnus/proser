import {
  paragraphSelection,
  paragraphsOf,
  visibleRun,
  type ProserDocument,
} from '@cheftaco/proser-editor';
export interface VerifiedImageChoice {
  id: string;
  sha256: string;
  width?: number;
  height?: number;
}
/** Insert beside an exact, grapheme-safe caret. Existing images and runs are retained. */
export function insertDocumentImage(
  document: ProserDocument,
  blockId: string,
  offset: number,
  sourceText: string,
  asset: VerifiedImageChoice,
  alt: string,
  id: () => string,
): ProserDocument {
  if (
    !Number.isSafeInteger(Number(asset.id)) ||
    Number(asset.id) <= 0 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  )
    throw new Error('Choose a Factory-verified image.');
  paragraphSelection(document, blockId, offset, offset, sourceText, true);
  const next = structuredClone(document);
  const paragraph = paragraphsOf(next).find((block) => block.id === blockId)!;
  if (
    paragraph.changeId ||
    next.changes.some(
      (change) =>
        change.status === 'pending' &&
        (change.targetBlockIds?.includes(blockId) ||
          paragraph.runs.some((run) => change.targetRunIds.includes(run.id))),
    )
  )
    throw new Error('Resolve pending review in this paragraph before inserting an image.');
  const width = asset.width && asset.width > 0 ? asset.width : 320;
  const height = asset.height && asset.height > 0 ? asset.height : 240;
  const image = {
    id: id(),
    text: '',
    style: {},
    inlineImage: { assetId: Number(asset.id), sha256: asset.sha256, alt, width, height },
  };
  let position = 0;
  for (let index = 0; index < paragraph.runs.length; index++) {
    const run = paragraph.runs[index]!;
    if (!visibleRun(run, next.changes, 'final')) continue;
    const length = run.inlineImage ? 1 : run.text.length;
    if (offset === position) {
      paragraph.runs.splice(index, 0, image);
      return next;
    }
    if (offset > position && offset < position + length) {
      if (run.inlineImage) throw new Error('An inline image is a protected object.');
      if (
        next.comments.some((comment) => comment.anchors.some((anchor) => anchor.runId === run.id))
      )
        throw new Error(
          'This run has anchored comments. Insert at its boundary or explicitly reconcile the comment first.',
        );
      const cut = offset - position;
      paragraph.runs.splice(index, 1, { ...run, text: run.text.slice(0, cut) }, image, {
        ...run,
        id: id(),
        text: run.text.slice(cut),
      });
      return next;
    }
    position += length;
  }
  if (offset !== position) throw new Error('The image caret is stale.');
  paragraph.runs.push(image);
  return next;
}
