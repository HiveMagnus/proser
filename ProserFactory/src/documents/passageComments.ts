import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { databaseService } from '@/lib/database';
import { documentService } from './service';
import { DocumentError } from './errors';
import { validateDocument, commentAnchorSchema } from './validation';
import { validateAttachedCommentAnchors } from './commentAnchors';
import { documentPassageRestoreSchema } from './passageValidation';
import { documentPassage, passageHash, committedPassageCursor } from './passageProjection';
import { passageContext, committedContext } from './passage';
import type { PassageCommentCommit, PassageCommentPageRequest } from './passage-model';
const sha=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(128);
const base=documentPassageRestoreSchema.omit({restoreFromRevisionId:true,restoreCursor:true});
const anchors=z.array(commentAnchorSchema).min(1).max(64);
export const passageCommentCommitSchema=z.union([
 base.extend({action:z.literal('create'),text:z.string().min(1).max(10000),anchors}).strict(),
 base.extend({action:z.enum(['resolved','reopened']),commentId:id,recordHash:sha}).strict(),
 base.extend({action:z.literal('reanchored'),commentId:id,recordHash:sha,anchors}).strict(),
]);
export async function commitPassageComment(userId:number,bookId:number,sceneId:number,input:PassageCommentCommit){
 if(!input.operationId||!input.expectedRevisionId||!input.expectedSceneRevisionId||!input.windowHash)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Exact comment source and operation preconditions are required.',428);
 const parsed=passageCommentCommitSchema.safeParse(input);if(!parsed.success)throw new DocumentError('DOCUMENT_COMMENT_REVIEW_INVALID','Invalid bounded comment operation.',422);input=parsed.data;
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{kind:'passage-comment',sceneId,...input}},async tx=>{
  const row=await tx.sceneDocumentRevision.findFirst({where:{id:input.expectedSceneRevisionId,bookId,sceneId}});if(!row||passageHash(row.document)!==row.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Comment source changed.',412);
  const document=validateDocument(row.document),owned=await passageContext(tx,bookId,input.expectedRevisionId,sceneId,row.id,row.contentHash);
  const window=documentPassage(document,{bookRevisionId:input.expectedRevisionId,sceneId,sceneRevisionId:row.id,contentHash:row.contentHash},input,owned);
  if(window.windowHash!==input.windowHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Comment passage changed.',412);
  if('anchors' in input){
   for(const anchor of input.anchors){const paragraph=window.paragraphs.find(p=>p.paragraph.id===anchor.blockId),run=paragraph?.runs.find(run=>run.runId===anchor.runId);
    if(!run||anchor.start<run.from||anchor.end>run.to)throw new DocumentError('DOCUMENT_COMMENT_TARGET_INVALID','Comment anchors must be qualified visible passage ranges.',409);
   }validateAttachedCommentAnchors(document,input.anchors);
  }
  let commentId:string;
  if(input.action==='create'){
   const actor=await tx.user.findUniqueOrThrow({where:{id:userId},select:{username:true}});commentId=randomUUID();document.comments.push({id:commentId,authorId:userId,authorName:actor.username??String(userId),createdAt:new Date().toISOString(),text:input.text,anchors:structuredClone(input.anchors),resolved:false});
  }else{
   commentId=input.commentId;const record=document.comments.find(comment=>comment.id===commentId);
   if(!record||passageHash(record)!==input.recordHash||!window.commentSummaries?.some(comment=>comment.id===commentId))throw new DocumentError('DOCUMENT_COMMENT_TARGET_STALE','Comment is not the exact visible immutable record.',412);
  }
  return{result:{commentId,action:input.action,passage:window},changedDocuments:[{sceneId,expectedRevisionId:row.id,document}],...(input.action==='create'?{}:{commentResolution:{commentId,action:input.action,...('anchors' in input?{anchors:input.anchors}:{})}}),receiptProjection:'references' as const,projectCommitted:({revisionId,scenes,manifest})=>{const saved=scenes.find(scene=>scene.sceneId===sceneId)!;return{commentId,action:input.action,passage:documentPassage(saved.document,{bookRevisionId:revisionId,sceneId,sceneRevisionId:saved.revisionId,contentHash:saved.contentHash},{...input,cursor:committedPassageCursor(saved.document,input.cursor)},committedContext(owned,revisionId,manifest,saved))};}};
 });
}
export const passageCommentPageQuery=z.object({bookRevisionId:z.string().uuid(),expectedSceneRevisionId:z.string().uuid(),recordHash:sha,offset:z.coerce.number().int().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(8).optional()}).strict();
export async function readPassageComment(userId:number,bookId:number,sceneId:number,commentId:string,input:PassageCommentPageRequest){
 await documentService.manifest(userId,bookId);
 const row=await databaseService.client.sceneDocumentRevision.findFirst({where:{id:input.expectedSceneRevisionId,sceneId,bookId}});
 if(!row||passageHash(row.document)!==row.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Comment source is unavailable.',412);
 await passageContext(databaseService.client,bookId,input.bookRevisionId,sceneId,row.id,row.contentHash);
 const comment=validateDocument(row.document).comments.find(comment=>comment.id===commentId);
 if(!comment||passageHash(comment)!==input.recordHash)throw new DocumentError('DOCUMENT_COMMENT_TARGET_STALE','Comment record changed.',412);
 const offset=input.offset??0,limit=input.limit??4;if(offset>comment.anchors.length||offset<0||limit<1||limit>8)throw new DocumentError('DOCUMENT_COMMENT_PAGE_INVALID','Invalid anchor page.',422);
 const {anchors:_anchors,anchorStates:_states,resolutionHistory:_history,...metadata}=comment;
 const next=offset+limit,result={...metadata,recordHash:input.recordHash,offset,total:comment.anchors.length,resolutionCount:comment.resolutionHistory?.length??0,anchors:comment.anchors.slice(offset,next),anchorStates:comment.anchorStates?.filter(state=>state.anchorIndex>=offset&&state.anchorIndex<next)??[],...(next<comment.anchors.length?{nextOffset:next}:{})};
 if(Buffer.byteLength(JSON.stringify(result))>256*1024)throw new DocumentError('DOCUMENT_COMMENT_PAGE_TOO_LARGE','Comment page exceeds256KiB; reduce limit.',413);return result;
}
