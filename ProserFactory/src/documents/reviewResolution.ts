import type {Prisma} from '@prisma/client';
import type {DocumentChange,DocumentChangeResolution,DocumentChangeResolutionSource} from './model';
import {DocumentError} from './errors';
import type {CommentSource} from './commentAnchors';
export type ReviewResolutionContext=DocumentChangeResolutionSource&{
 operationId:string;sourceBookRevisionId:string;sourceContentHash:string;workflowRunId?:string;sourceDocuments?:CommentSource[];
};
export type DocumentReviewAudit = {
 changeId:string;action:'resolve-document-change';resolution:DocumentChangeResolution;
} | {
 changeId:string;action:'create-direct-structural-change'|'import-document-review-state';
 status:DocumentChange['status'];actorId:number;actorName:string;createdAt:string;source:ReviewResolutionContext;
};
function required(context:ReviewResolutionContext|undefined):ReviewResolutionContext{
 if(!context)throw new DocumentError('DOCUMENT_REVIEW_CONTEXT_REQUIRED','The authenticated operation and immutable revision source are required for a review decision.',428);
 return context;
}
/** The context comes only from the guarded document transaction. Callers may
 * request a decision; they cannot supply the resulting actor/history record. */
export function appendChangeResolution(change:DocumentChange,actor:{id:number;name:string},origin:'manual'|'workflow',phase:DocumentChangeResolution['phase'],context:ReviewResolutionContext|undefined):DocumentReviewAudit{
 const source=required(context);
 if(change.status==='pending'||(origin==='workflow'&&!source.workflowRunId)||(source.sourceKind==='scene-creation'&&phase!=='created-and-resolved'))throw new DocumentError('DOCUMENT_REVIEW_RESOLUTION_AUTHORITY_INVALID','The decision requires an exact authenticated manual source or live workflow run.',409);
 const {sourceDocuments:_documents,...binding}=source;
 const record:DocumentChangeResolution={...binding,actorId:actor.id,actorName:actor.name,createdAt:new Date().toISOString(),decision:change.status,origin,phase};
 change.resolutionHistory=[...(change.resolutionHistory??[]),record];return {changeId:change.id,action:'resolve-document-change',resolution:record};
}
export function creationReviewAudit(change:DocumentChange,actor:{id:number;name:string},action:'create-direct-structural-change'|'import-document-review-state',context:ReviewResolutionContext|undefined):DocumentReviewAudit{
 const {sourceDocuments:_documents,...source}=required(context);return {changeId:change.id,action,status:change.status,actorId:actor.id,actorName:actor.name,createdAt:new Date().toISOString(),source};
}
/** One durable action record per change, in the same transaction as its body
 * and book/layout revision. Operation recovery does not run this helper again. */
export async function persistDocumentReviewAudits(tx:Prisma.TransactionClient,userId:number,bookId:number,outputRevisionId:string,events:DocumentReviewAudit[],authenticatedActor?:string){
 if(!events.length)return;
 await tx.auditLog.createMany({data:events.map((event)=>{
  const source='resolution' in event?event.resolution:event.source;
  const payload='resolution' in event?{changeId:event.changeId,action:event.action,resolution:event.resolution.origin==='workflow'?'authorized-workflow-automation':'authenticated-review-decision',reviewResolution:event.resolution,decision:event.resolution.decision,workflowRunId:event.resolution.workflowRunId}:event;
  const sourceRevisionId=source.sourceKind==='scene'?source.sourceSceneRevisionId:source.sourceKind==='layout-story'?source.sourceLayoutRevisionId:source.sourceBookRevisionId;
  return {userId,entityType:source.sourceKind==='layout-story'?'book':'scene',entityId:source.sourceKind==='layout-story'?bookId:source.sourceSceneId,action:'update',metadata:JSON.parse(JSON.stringify({...payload,operationId:source.operationId,sourceBookRevisionId:source.sourceBookRevisionId,sourceRevisionId,outputRevisionId,authenticatedActor})) as Prisma.InputJsonValue};
 })});
}
