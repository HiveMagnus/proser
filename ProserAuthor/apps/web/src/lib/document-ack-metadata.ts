import { type ProserDocument } from '@hivemagnus/proser-editor';
/** Durable acknowledgement can arrive after more typing. Preserve that body,
 * but carry authenticated attribution and server-derived annotation evidence
 * into its next request instead of replaying provisional metadata. */
export function mergeDocumentAcknowledgement(
  current: ProserDocument,
  committed: ProserDocument,
  request: ProserDocument,
): ProserDocument {
  const result = structuredClone(current);
  for (const change of result.changes) {
    const saved = committed.changes.find((item) => item.id === change.id);
    const sent = request.changes.find((item) => item.id === change.id);
    if (!saved || !sent) continue;
    const status = change.status !== sent.status ? change.status : saved.status;
    const targetRunIds = change.targetRunIds;
    const targetBlockIds = change.targetBlockIds;
    Object.assign(change, structuredClone(saved), { status });
    if (saved.status === 'pending' && saved.origin === 'manual' && !saved.importedAuthor) {
      if (saved.kind === 'insertion')
        change.targetRunIds = [...new Set([...saved.targetRunIds, ...targetRunIds])];
      if (saved.kind === 'paragraphInsertion')
        change.targetBlockIds = [
          ...new Set([...(saved.targetBlockIds ?? []), ...(targetBlockIds ?? [])]),
        ];
    }
  }
  for (const comment of result.comments) {
    const saved = committed.comments.find((item) => item.id === comment.id);
    if (!saved) continue;
    comment.authorId = saved.authorId;
    comment.authorName = saved.authorName;
    comment.createdAt = saved.createdAt;
    if (saved.importedAuthor === undefined) delete comment.importedAuthor;
    else comment.importedAuthor = saved.importedAuthor;
    if (saved.anchorStates === undefined) delete comment.anchorStates;
    else comment.anchorStates = structuredClone(saved.anchorStates);
    if (saved.resolutionHistory === undefined) delete comment.resolutionHistory;
    else comment.resolutionHistory = structuredClone(saved.resolutionHistory);
  }
  return result;
}
