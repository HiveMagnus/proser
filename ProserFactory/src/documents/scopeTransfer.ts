import { canonicalDocument, paragraphsOf, type ProserDocument } from './model';
import { DocumentError } from './errors';
/** Preserve review provenance only for exact records explicitly transferred
 * between atomically committed scenes. The complete anchored objects move too. */
export function transferredReviewSources(scopes: Array<{ sceneId: number; previous: ProserDocument; next: ProserDocument }>, verifiedRestorations: ReadonlySet<number> = new Set()): Map<number, ProserDocument> {
  const identities = (document: ProserDocument) => {
    const blocks = new Set(paragraphsOf(document).map((paragraph) => paragraph.id));
    const runs = new Set(paragraphsOf(document).flatMap((paragraph) => paragraph.runs.map((run) => run.id)));
    const objects = new Set(document.blocks.flatMap((block) => block.type === 'table' ? [block.id, ...block.rows.flatMap((row) => [row.id, ...row.cells.map((cell) => cell.id)])] : block.type === 'paragraph' ? [] : [block.id]));
    return { blocks, runs, objects };
  };
  const nextIds = new Map(scopes.map((scope) => [scope.sceneId, identities(scope.next)]));
  const seen = new Set<string>();
  for (const scope of scopes) for (const id of [...nextIds.get(scope.sceneId)!.blocks, ...nextIds.get(scope.sceneId)!.runs, ...nextIds.get(scope.sceneId)!.objects]) {
    if (seen.has(id)) throw new DocumentError('DOCUMENT_SCOPE_IDENTITY_CONFLICT', 'An identity cannot belong to two committed scenes.', 409);
    seen.add(id);
  }
  const result = new Map(scopes.map((scope) => [scope.sceneId, structuredClone(scope.previous)]));
  for (const source of scopes) {
    if (verifiedRestorations.has(source.sceneId)) continue;
    for (const change of source.previous.changes) {
      const destinations = scopes.filter((scope) => scope.sceneId !== source.sceneId && !verifiedRestorations.has(scope.sceneId) && scope.next.changes.some((entry) => entry.id === change.id));
      if (!destinations.length) continue;
      const destination = destinations[0]!; const ids = nextIds.get(destination.sceneId)!;
      const retained = destination.next.changes.find((entry) => entry.id === change.id)!;
      if (destinations.length !== 1 || source.next.changes.some((entry) => entry.id === change.id) || canonicalDocument(change) !== canonicalDocument(retained) || !change.targetRunIds.every((id) => ids.runs.has(id)) || !(change.targetBlockIds ?? []).every((id) => ids.blocks.has(id))) throw new DocumentError('DOCUMENT_REVIEW_TRANSFER_INVALID', 'Move the complete unchanged review record and its anchored objects atomically.', 409);
      result.get(source.sceneId)!.changes = result.get(source.sceneId)!.changes.filter((entry) => entry.id !== change.id);
      const prior = result.get(destination.sceneId)!;
      if (prior.changes.some((entry) => entry.id === change.id)) throw new DocumentError('DOCUMENT_REVIEW_TRANSFER_INVALID', 'Review identity already belongs to another scope.', 409);
      prior.changes.push(structuredClone(change));
    }
    for (const comment of source.previous.comments) {
      const destinations = scopes.filter((scope) => scope.sceneId !== source.sceneId && !verifiedRestorations.has(scope.sceneId) && scope.next.comments.some((entry) => entry.id === comment.id));
      if (!destinations.length) continue;
      const destination = destinations[0]!; const ids = nextIds.get(destination.sceneId)!;
      const retained = destination.next.comments.find((entry) => entry.id === comment.id)!;
      const paragraphs = paragraphsOf(destination.next, true);
      if (destinations.length !== 1 || source.next.comments.some((entry) => entry.id === comment.id) || canonicalDocument(comment) !== canonicalDocument(retained) || !comment.anchors.every((anchor) => ids.blocks.has(anchor.blockId) && ids.runs.has(anchor.runId) && paragraphs.find((paragraph) => paragraph.id === anchor.blockId)?.runs.find((run) => run.id === anchor.runId)?.text.slice(anchor.start,anchor.end) === anchor.sourceText)) throw new DocumentError('DOCUMENT_REVIEW_TRANSFER_INVALID', 'Move the complete unchanged comment and its anchored content atomically.', 409);
      result.get(source.sceneId)!.comments = result.get(source.sceneId)!.comments.filter((entry) => entry.id !== comment.id);
      const prior = result.get(destination.sceneId)!;
      if (prior.comments.some((entry) => entry.id === comment.id)) throw new DocumentError('DOCUMENT_REVIEW_TRANSFER_INVALID', 'Comment identity already belongs to another scope.', 409);
      prior.comments.push(structuredClone(comment));
    }
  }
  return result;
}
