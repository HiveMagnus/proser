import {
  projectDocument,
  paragraphSelection,
  paragraphsOf,
  visibleRun,
  type DocumentSelection,
} from '@cheftaco/proser-editor';
import type { DocumentSearchHit } from '@cheftaco/proser-contracts';
import type { SavedSceneDocument } from './document-api';
/** Restore only immutable returned identities, never a quotation search. */
export async function selectionForDocumentSearch(
  saved: SavedSceneDocument,
  hit: DocumentSearchHit,
): Promise<DocumentSelection> {
  if (
    !hit.editable ||
    saved.sceneId !== hit.sceneId ||
    saved.revisionId !== hit.sceneRevisionId ||
    saved.contentHash !== hit.sceneContentHash
  )
    throw new Error(
      'This search result belongs to a different saved revision. Refresh the search.',
    );
  const projection = projectDocument(saved.document);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(projection.text)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== hit.projectionSha256 || projection.text.slice(hit.from, hit.to) !== hit.sourceText)
    throw new Error('The search result no longer matches its exact source projection.');
  const paragraphs = paragraphsOf(saved.document);
  const byBlock = new Map<string, { from: number; to: number }>();
  for (const anchor of hit.anchors) {
    const paragraph = paragraphs.find((block) => block.id === anchor.blockId);
    if (!paragraph) throw new Error('A search anchor is orphaned. Refresh the search.');
    const runs = paragraph.runs.filter((run) => visibleRun(run, saved.document.changes, 'final'));
    const index = runs.findIndex((run) => run.id === anchor.runId);
    const run = runs[index];
    if (!run || run.inlineImage || run.text.slice(anchor.start, anchor.end) !== anchor.sourceText)
      throw new Error('A search anchor changed its text or protected object. Refresh the search.');
    const prefix = runs
      .slice(0, index)
      .reduce((length, item) => length + (item.inlineImage ? 1 : item.text.length), 0);
    const old = byBlock.get(anchor.blockId);
    const from = prefix + anchor.start,
      to = prefix + anchor.end;
    if (old && from > old.to)
      throw new Error('This result has discontinuous anchors. Select it in reading mode.');
    byBlock.set(anchor.blockId, {
      from: Math.min(old?.from ?? from, from),
      to: Math.max(old?.to ?? to, to),
    });
  }
  let selection: DocumentSelection | undefined;
  for (const [blockId, range] of byBlock) {
    const paragraph = paragraphs.find((block) => block.id === blockId)!;
    const text = paragraph.runs
      .filter((run) => visibleRun(run, saved.document.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('');
    const part = paragraphSelection(saved.document, blockId, range.from, range.to, text)!;
    if (!selection) selection = part;
    else {
      if (JSON.stringify(part.container) !== JSON.stringify(selection.container))
        throw new Error(
          'Search spans multiple protected containers. Open it without a text selection.',
        );
      selection.targets.push(...part.targets);
      selection.runs.push(...part.runs);
    }
  }
  if (!selection?.targets.length) throw new Error('This result has no editable text anchors.');
  return selection;
}
