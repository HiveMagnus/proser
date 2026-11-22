import {assertPendingBoundary} from './boundaryReview';
import {attestDetachedBoundary} from './boundaryHistory';
import { canonicalDocument, paragraphsOf, type ProserDocument } from './model';
import { DocumentError } from './errors';
import {appendChangeResolution,creationReviewAudit,type ReviewResolutionContext,type DocumentReviewAudit} from './reviewResolution';
/** Identity comes from authentication, never document JSON or inference text. */
export function stampDocumentReview(next: ProserDocument, previous: ProserDocument | undefined, actor: { id: number; name: string }, origin: 'manual' | 'ai' | 'workflow' | 'import' = 'manual', trustedImport = false, resolutionContext?:ReviewResolutionContext):DocumentReviewAudit[] {
  const now = new Date().toISOString();
  const events:DocumentReviewAudit[]=[];
  const beforeParagraphs = previous ? new Map(paragraphsOf(previous, true).map((paragraph) => [paragraph.id, paragraph])) : new Map<string, ReturnType<typeof paragraphsOf>[number]>();
  for(const source of resolutionContext?.sourceDocuments??[])for(const paragraph of source.document?paragraphsOf(source.document,true):[])if(!beforeParagraphs.has(paragraph.id))beforeParagraphs.set(paragraph.id,paragraph);
  const afterParagraphs = new Map(paragraphsOf(next, true).map((paragraph) => [paragraph.id, paragraph]));
  const beforeRuns = new Map([...beforeParagraphs.values()].flatMap((paragraph) => paragraph.runs.map((run) => [run.id, run] as const)));
  const afterRuns = new Map([...afterParagraphs.values()].flatMap((paragraph) => paragraph.runs.map((run) => [run.id, run] as const)));
  const placements=(document:ProserDocument)=>{const locations=new Map<string,string>();for(const paragraph of document.layout.header)locations.set(paragraph.id,'header');for(const paragraph of document.layout.footer)locations.set(paragraph.id,'footer');for(const block of document.blocks)if(block.type==='paragraph')locations.set(block.id,'body');else if(block.type==='table')for(const row of block.rows)for(const cell of row.cells)for(const paragraph of cell.paragraphs)locations.set(paragraph.id,canonicalDocument({tableId:block.id,rowId:row.id,cellId:cell.id}));return locations;};
  const beforeLocations=previous?placements(previous):new Map<string,string>();for(const source of resolutionContext?.sourceDocuments??[])if(source.document)for(const [id,place]of placements(source.document))if(!beforeLocations.has(id))beforeLocations.set(id,place);
  const afterLocations=placements(next);const beforeRunParents=new Map([...beforeParagraphs.values()].flatMap((paragraph)=>paragraph.runs.map((run)=>[run.id,paragraph.id] as const)));const afterRunParents=new Map([...afterParagraphs.values()].flatMap((paragraph)=>paragraph.runs.map((run)=>[run.id,paragraph.id] as const)));

  if (previous?.changes.some((change) => change.status === 'pending' && !next.changes.some((entry) => entry.id === change.id))) throw new DocumentError('DOCUMENT_REVIEW_STATE_MISSING', 'Resolve pending changes explicitly instead of discarding their review records.', 409);
  if (previous?.changes.some((change) => (change.kind === 'paragraphSplit' || change.kind === 'paragraphJoin') && !next.changes.some((entry) => entry.id === change.id))) throw new DocumentError('DOCUMENT_REVIEW_STATE_MISSING', 'Paragraph-boundary review history must be retained when re-editing.', 409);
  for (const change of next.changes) {
    const old = previous?.changes.find((entry) => entry.id === change.id);
    if(canonicalDocument(change.resolutionHistory??[])!==canonicalDocument(old?.resolutionHistory??[]))throw new DocumentError('DOCUMENT_REVIEW_HISTORY_INVALID','Change resolution history is server-owned and cannot be fabricated, removed or rewritten.',422);
    if(old?.resolutionHistory!==undefined)change.resolutionHistory=structuredClone(old.resolutionHistory);else delete change.resolutionHistory;
    const ownContinuation = Boolean(old?.status === 'pending' && change.status === 'pending' && origin === 'manual' && old.origin === 'manual' && old.authorId === actor.id && old.importedAuthor === undefined && (old.kind === 'insertion' || old.kind === 'paragraphInsertion'));
    if (old && canonicalDocument({ ...old, status: change.status, ...(ownContinuation ? old.kind === 'insertion' ? { targetRunIds: change.targetRunIds } : { targetBlockIds: change.targetBlockIds } : {}) }) !== canonicalDocument(change)) throw new DocumentError('DOCUMENT_REVIEW_ATTRIBUTION_INVALID', 'Existing change attribution cannot be rewritten.', 422);
    if (old && ownContinuation) {
      if (old.kind === 'insertion') {
        if (old.targetRunIds.some((id) => !change.targetRunIds.includes(id)) || change.targetRunIds.some((id) => afterRuns.get(id)?.changeId !== old.id || (!old.targetRunIds.includes(id) && beforeRuns.has(id)))) throw new DocumentError('DOCUMENT_REVIEW_TARGET_EXPANSION_INVALID', 'Manual insertion continuation requires linked existing or fresh runs without reattributing original text.', 409);
      } else {
        if ((old.targetBlockIds ?? []).some((id) => !change.targetBlockIds?.includes(id)) || (change.targetBlockIds ?? []).some((id) => afterParagraphs.get(id)?.changeId !== old.id || (!old.targetBlockIds?.includes(id) && beforeParagraphs.has(id)))) throw new DocumentError('DOCUMENT_REVIEW_TARGET_EXPANSION_INVALID', 'Manual paragraph continuation requires linked existing or fresh paragraph identities.', 409);
      }
    }
    attestDetachedBoundary(next, previous, old, change, resolutionContext);
    if (old) assertPendingBoundary(previous, next, old, change, actor.id, origin, resolutionContext?.sourceDocuments?.flatMap((source) => source.document ? [source.document] : []) ?? []);
    if (old && old.status !== 'pending' && change.status !== old.status) throw new DocumentError('DOCUMENT_REVIEW_ALREADY_RESOLVED', 'Restore a complete revision to undo an already resolved change.', 409);
    if(old?.status==='pending'&&change.status==='pending'&&old.kind==='format')for(const id of old.targetRunIds){const before=beforeRuns.get(id);const after=afterRuns.get(id);if(!before||!after||canonicalDocument(before.style)!==canonicalDocument(after.style))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Resolve this pending formatting proposal before changing its properties.',409);}
    if (old?.status === 'pending') {
      if (!ownContinuation && (old.kind === 'insertion' || old.kind === 'deletion')) {
        for (const id of old.targetRunIds) {
          const before = beforeRuns.get(id);
          const after = afterRuns.get(id);
          if (!before || !after || canonicalDocument(before) !== canonicalDocument(after)) throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED', 'Resolve this pending insertion/deletion before editing its content or formatting.', 409);
        }
      }
      if (!ownContinuation && (old.kind === 'paragraphInsertion' || old.kind === 'paragraphDeletion')) {
        for (const id of old.targetBlockIds ?? []) {
          const before = beforeParagraphs.get(id); const after = afterParagraphs.get(id);
          if (!before || !after || canonicalDocument(before) !== canonicalDocument(after)) throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED', 'Resolve this pending paragraph insertion/deletion before editing its content or formatting.', 409);
        }
      }
    }
    if(old?.status==='pending'&&change.status!=='pending'){
      for(const id of old.targetRunIds){const before=beforeRunParents.get(id);const after=afterRunParents.get(id);if(!before||before!==after||beforeLocations.get(before)!==afterLocations.get(after))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','The original review run/paragraph/container identity changed; save and revalidate separately.',409);}
      for(const id of old.targetBlockIds??[])if(beforeLocations.get(id)!==afterLocations.get(id))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','The original review paragraph/container identity changed; save and revalidate separately.',409);
    }
    if(old?.status==='pending'&&change.status!=='pending'){
      // Match exactly the target payload that resolveChange would produce.
      // Accepting does not authorize rewriting the source under its old author.
      if(old.kind==='format')for(const id of old.targetRunIds){const before=beforeRuns.get(id);const after=afterRuns.get(id);const expected=before?{...before,...(change.status==='rejected'?{style:old.beforeStyle??{}}:{})}:undefined;if(!expected||!after||canonicalDocument(expected)!==canonicalDocument(after))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Save edits separately before resolving this exact formatting target.',409);}
      if(old.kind==='paragraphFormat')for(const id of old.targetBlockIds??[]){const before=beforeParagraphs.get(id);const after=afterParagraphs.get(id);const expected=before?{...before,...(change.status==='rejected'?{style:old.beforeParagraphStyle??{}}:{})}:undefined;if(!expected||!after||canonicalDocument(expected)!==canonicalDocument(after))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Save edits separately before resolving this exact paragraph formatting target.',409);}
      if(old.kind==='paragraphSplit'||old.kind==='paragraphJoin')for(const id of old.targetBlockIds??[]){const before=beforeParagraphs.get(id);const after=afterParagraphs.get(id);if(!before||!after||canonicalDocument(before)!==canonicalDocument(after))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Save edits separately before resolving this exact paragraph boundary target.',409);}
    }
    if(old?.status==='pending'&&change.status!=='pending'){
      if(origin!=='manual'&&origin!=='workflow')throw new DocumentError('DOCUMENT_REVIEW_RESOLUTION_AUTHORITY_INVALID','Resolve existing changes through an authenticated review or authorized workflow decision.',409);
      const attested=resolutionContext?.sourceDocuments?.find((source)=>source.document?.changes.some((entry)=>entry.id===old.id&&canonicalDocument(entry)===canonicalDocument(old)));
      const context=attested&&resolutionContext?{...resolutionContext,...(attested.sourceKind==='layout-story'?{sourceKind:'layout-story' as const,sourceStoryId:attested.storyId,sourceLayoutRevisionId:attested.revisionId}:{sourceKind:'scene' as const,sourceSceneId:attested.sceneId,sourceSceneRevisionId:attested.revisionId})}:resolutionContext;
      events.push(appendChangeResolution(change,actor,origin,'resolved',context));
    }
    if (!old) {
      change.authorId = actor.id; change.authorName = actor.name; change.origin = origin; if (!trustedImport) { change.createdAt = now; delete change.importedAuthor; }
      if(change.status!=='pending'){
        if(trustedImport){events.push(creationReviewAudit(change,actor,'import-document-review-state',resolutionContext));}
        else if(origin==='workflow'){events.push(appendChangeResolution(change,actor,'workflow','created-and-resolved',resolutionContext));}
        else if(origin==='manual'&&change.status==='accepted'&&(change.kind==='paragraphSplit'||change.kind==='paragraphJoin')){events.push(creationReviewAudit(change,actor,'create-direct-structural-change',resolutionContext));}
        else throw new DocumentError('DOCUMENT_REVIEW_CREATION_INVALID','New tracked edits must remain pending; direct accepted structural typing and authorized workflow automation have separate provenance.',409);
      }
    }
  }
  for (const comment of next.comments) {
    const old = previous?.comments.find((entry) => entry.id === comment.id);
    if (old && (old.authorId !== comment.authorId || old.authorName !== comment.authorName || old.createdAt !== comment.createdAt || old.importedAuthor !== comment.importedAuthor)) throw new DocumentError('DOCUMENT_REVIEW_ATTRIBUTION_INVALID', 'Existing comment attribution cannot be rewritten.', 422);
    if (!old) { comment.authorId = actor.id; comment.authorName = actor.name; if (!trustedImport) { comment.createdAt = now; delete comment.importedAuthor; } }
  }
  return events;
}
