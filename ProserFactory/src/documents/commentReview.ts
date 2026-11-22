import {databaseService} from '@/lib/database';
import {documentService} from './service';
import {DocumentError} from './errors';
import {canonicalDocument,type DocumentAnchor} from './model';
import {validateDocument} from './validation';
import {validateBookLayout} from './scopeValidation';
import {assertOwnedCommentEvidence,validateAttachedCommentAnchors,type CommentResolution} from './commentAnchors';
import type {SceneCommentReviewSource,LayoutStoryCommentReviewSource,SceneCommentRevalidationResponse,LayoutStoryCommentRevalidationResponse,SceneCommentsResponse,LayoutStoryCommentsResponse,DocumentCommentReviewReceipt,SceneCommentResolutionResult,LayoutStoryCommentResolutionResult} from './comment-review-model';
export type CommentReviewSource=SceneCommentReviewSource;
export async function revalidateSceneComment(userId:number,bookId:number,sceneId:number,commentId:string,input:CommentReviewSource&{anchors?:DocumentAnchor[]}):Promise<SceneCommentRevalidationResponse>{
 const source=await documentService.read(userId,bookId,sceneId);if(source.bookRevisionId!==input.expectedRevisionId||source.revisionId!==input.expectedSceneRevisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','Save and reconcile this scene before reviewing comment attachments.',412,{currentRevisionId:source.bookRevisionId,currentSceneRevisionId:source.revisionId});
 return documentService.sideRecord(userId,bookId,async(tx)=>{
  const head=await tx.bookDocumentHead.findUniqueOrThrow({where:{bookId}});if(head.revisionId!==source.bookRevisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','The source changed during comment review.',412);
  const comment=source.document.comments.find((entry)=>entry.id===commentId);if(!comment)throw new DocumentError('DOCUMENT_COMMENT_NOT_FOUND','Comment not found.',404);
  await assertOwnedCommentEvidence(tx,userId,bookId,source.document);if(input.anchors)validateAttachedCommentAnchors(source.document,input.anchors);
  return {schemaVersion:1 as const,sceneId,commentId,bookRevisionId:source.bookRevisionId,sceneRevisionId:source.revisionId,contentHash:source.contentHash,comment,attachment:comment.anchorStates?.length?'detached' as const:'attached' as const,...(input.anchors?{proposedAnchors:input.anchors}:{})};
 });
}
export async function resolveSceneComment(userId:number,bookId:number,sceneId:number,commentId:string,input:CommentReviewSource&{operationId:string;action:CommentResolution['action'];anchors?:DocumentAnchor[]}):Promise<DocumentCommentReviewReceipt<SceneCommentResolutionResult>>{
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{kind:'document-comment-review',sceneId,commentId,input}},async(tx)=>{
  const row=await tx.sceneDocumentRevision.findFirst({where:{id:input.expectedSceneRevisionId,sceneId,bookId}});if(!row)throw new DocumentError('DOCUMENT_SOURCE_STALE','The scene revision changed.',412);
  const document=validateDocument(row.document);const comment=document.comments.find((entry)=>entry.id===commentId);if(!comment)throw new DocumentError('DOCUMENT_COMMENT_NOT_FOUND','Comment not found.',404);
  await assertOwnedCommentEvidence(tx,userId,bookId,document);
  if(input.action==='reanchored'){if(!input.anchors)throw new DocumentError('DOCUMENT_COMMENT_TARGET_REQUIRED','Select explicit current target identities for reattachment.',428);validateAttachedCommentAnchors(document,input.anchors);}
  else if(input.anchors)throw new DocumentError('DOCUMENT_COMMENT_REVIEW_INVALID','Only an explicit reattachment may replace comment anchors.',422);
  if(input.anchors&&new Set(input.anchors.map((anchor)=>canonicalDocument(anchor))).size!==input.anchors.length)throw new DocumentError('DOCUMENT_COMMENT_REVIEW_INVALID','Repeated attachment ranges are invalid.',422);
  return {result:{sceneId,commentId,action:input.action},changedDocuments:[{sceneId,expectedRevisionId:row.id,document}],commentResolution:{commentId,action:input.action,anchors:input.anchors}};
 });
}
export async function readSceneComments(userId:number,bookId:number,sceneId:number):Promise<SceneCommentsResponse>{const source=await documentService.read(userId,bookId,sceneId);await databaseService.client.$transaction((tx)=>assertOwnedCommentEvidence(tx,userId,bookId,source.document));return {schemaVersion:1,sceneId,bookRevisionId:source.bookRevisionId,sceneRevisionId:source.revisionId,contentHash:source.contentHash,comments:source.document.comments};}

export type LayoutCommentReviewSource=LayoutStoryCommentReviewSource;
function layoutStory(layout:import('./scope-model').BookLayoutSnapshot,storyId:string){
 const story=[...layout.frontMatter,...layout.backMatter,...(layout.headerFooterStories??[])].find((entry)=>entry.id===storyId);
 if(!story)throw new DocumentError('DOCUMENT_STORY_NOT_FOUND','Owned layout story not found.',404);return story;
}
export async function readLayoutStoryComments(userId:number,bookId:number,storyId:string):Promise<LayoutStoryCommentsResponse>{
 const source=await documentService.scope(userId,bookId,'layout');const story=layoutStory(source.content,storyId);
 await databaseService.client.$transaction((tx)=>assertOwnedCommentEvidence(tx,userId,bookId,story.document));
 return {schemaVersion:1 as const,sourceKind:'layout-story' as const,storyId,bookRevisionId:source.bookRevisionId,layoutRevisionId:source.revisionId,contentHash:source.contentHash,comments:story.document.comments};
}
export async function revalidateLayoutStoryComment(userId:number,bookId:number,storyId:string,commentId:string,input:LayoutCommentReviewSource&{anchors?:DocumentAnchor[]}):Promise<LayoutStoryCommentRevalidationResponse>{
 const source=await documentService.scope(userId,bookId,'layout');if(source.bookRevisionId!==input.expectedRevisionId||source.revisionId!==input.expectedLayoutRevisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','Save and reconcile this layout before reviewing story comments.',412,{currentRevisionId:source.bookRevisionId,currentLayoutRevisionId:source.revisionId});
 return documentService.sideRecord(userId,bookId,async(tx)=>{
  const head=await tx.bookDocumentHead.findUniqueOrThrow({where:{bookId}});if(head.revisionId!==source.bookRevisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','The source changed during layout comment review.',412);
  const story=layoutStory(source.content,storyId);const comment=story.document.comments.find((entry)=>entry.id===commentId);if(!comment)throw new DocumentError('DOCUMENT_COMMENT_NOT_FOUND','Comment not found.',404);
  await assertOwnedCommentEvidence(tx,userId,bookId,story.document);if(input.anchors)validateAttachedCommentAnchors(story.document,input.anchors);
  return {schemaVersion:1 as const,sourceKind:'layout-story' as const,storyId,commentId,bookRevisionId:source.bookRevisionId,layoutRevisionId:source.revisionId,contentHash:source.contentHash,comment,attachment:comment.anchorStates?.length?'detached' as const:'attached' as const,...(input.anchors?{proposedAnchors:input.anchors}:{})};
 });
}
export async function resolveLayoutStoryComment(userId:number,bookId:number,storyId:string,commentId:string,input:LayoutCommentReviewSource&{operationId:string;action:CommentResolution['action'];anchors?:DocumentAnchor[]}):Promise<DocumentCommentReviewReceipt<LayoutStoryCommentResolutionResult>>{
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{layout:input.expectedLayoutRevisionId},payload:{kind:'layout-story-comment-review',storyId,commentId,input}},async(tx)=>{
  const row=await tx.bookDocumentScopeRevision.findFirst({where:{id:input.expectedLayoutRevisionId,bookId,kind:'layout'}});if(!row)throw new DocumentError('DOCUMENT_SOURCE_STALE','The layout revision changed.',412);
  const layout=validateBookLayout(row.content);const document=layoutStory(layout,storyId).document;const comment=document.comments.find((entry)=>entry.id===commentId);if(!comment)throw new DocumentError('DOCUMENT_COMMENT_NOT_FOUND','Comment not found.',404);
  await assertOwnedCommentEvidence(tx,userId,bookId,document);
  if(input.action==='reanchored'){if(!input.anchors)throw new DocumentError('DOCUMENT_COMMENT_TARGET_REQUIRED','Select explicit current target identities for reattachment.',428);validateAttachedCommentAnchors(document,input.anchors);}
  else if(input.anchors)throw new DocumentError('DOCUMENT_COMMENT_REVIEW_INVALID','Only explicit reattachment may replace comment anchors.',422);
  if(input.anchors&&new Set(input.anchors.map((anchor)=>canonicalDocument(anchor))).size!==input.anchors.length)throw new DocumentError('DOCUMENT_COMMENT_REVIEW_INVALID','Repeated attachment ranges are invalid.',422);
  return {result:{storyId,commentId,action:input.action},layout,layoutCommentResolution:{storyId,commentId,action:input.action,anchors:input.anchors}};
 });
}
