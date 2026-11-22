import {createHash} from 'node:crypto';
import type {Prisma} from '@prisma/client';
import {canonicalDocument,paragraphsOf,visibleParagraph,visibleRun,MAX_DOCUMENT_BYTES,type ProserDocument,type DocumentAnchor,type DocumentComment,type DocumentAnchorLineage} from './model';
import {documentSchema,validateDocument} from './validation';
import {DocumentError} from './errors';
import {validateBookLayout} from './scopeValidation';
export type CommentAnchorState=NonNullable<DocumentComment['anchorStates']>[number];
export type CommentSource = {revisionId:string;contentHash:string;document?:ProserDocument} & (
 {sourceKind?:'scene';sceneId:number}
 | {sourceKind:'layout-story';storyId:string}
);
export interface CommentResolution {commentId:string;action:'resolved'|'reopened'|'reanchored';anchors?:DocumentAnchor[]}
export type ValidatedCommentLineage=DocumentAnchorLineage&{sourceTextSha256:string;styleSha256:string};
const hash=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
/** Incoming attachment validation is deferred until an owned immutable source
 * is loaded. Body, schema, size and Unicode validation remain mandatory. */
export function parseCommentCandidateDocument(raw:unknown):ProserDocument {
 if(Buffer.byteLength(JSON.stringify(raw)??'')>MAX_DOCUMENT_BYTES)throw new DocumentError('DOCUMENT_TOO_LARGE','Document exceeds 2 MiB',413);
 let parsed:ProserDocument;try{parsed=documentSchema.parse(raw);}catch{throw new DocumentError('DOCUMENT_INVALID','Invalid canonical document schema.',422);}
 // Review history/state coherence is checked after the owned source guard;
 // this permits a stale decision to receive its explicit conflict error.
 const body=validateDocument({...parsed,comments:[]},{reviewCandidates:true});
 const unicode=(value:unknown):void=>{if(typeof value==='string'&&(/\u0000/.test(value)||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)))throw new DocumentError('DOCUMENT_INVALID','Comment evidence requires valid Unicode.',422);if(Array.isArray(value))value.forEach(unicode);else if(value&&typeof value==='object')Object.values(value).forEach(unicode);};unicode(parsed.comments);
 body.comments=parsed.comments;return body;
}
function index(document:ProserDocument){
 const containers=new Map<string,string>();for(const paragraph of document.layout.header)containers.set(paragraph.id,'header');for(const paragraph of document.layout.footer)containers.set(paragraph.id,'footer');
 for(const block of document.blocks)if(block.type==='table')for(const row of block.rows)for(const cell of row.cells)for(const paragraph of cell.paragraphs)containers.set(paragraph.id,canonicalDocument({tableId:block.id,rowId:row.id,cellId:cell.id}));
 return new Map(paragraphsOf(document,true).flatMap((paragraph)=>paragraph.runs.map((run)=>[run.id,{paragraph,run,container:containers.get(paragraph.id)??'body',visible:visibleParagraph(paragraph,document.changes,'markup')&&visibleRun(run,document.changes,'markup')}] as const)));
}
const commentSegmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
function boundary(text:string,offset:number){return offset===0||offset===text.length||commentSegmenter.segment(text).containing(offset)?.index===offset;}
function attached(anchor:DocumentAnchor,runs:ReturnType<typeof index>,visible=true){const location=runs.get(anchor.runId);if(!location||visible&&!location.visible||location.paragraph.id!==anchor.blockId)return false;if(location.run.inlineImage)return anchor.start===0&&anchor.end===0&&anchor.sourceText==='';return anchor.end>=anchor.start&&anchor.end<=location.run.text.length&&location.run.text.slice(anchor.start,anchor.end)===anchor.sourceText&&boundary(location.run.text,anchor.start)&&boundary(location.run.text,anchor.end);}
export function validateAttachedCommentAnchors(document:ProserDocument,anchors:DocumentAnchor[]){const runs=index(document);if(!anchors.length||anchors.some((anchor)=>!attached(anchor,runs)))throw new DocumentError('DOCUMENT_COMMENT_TARGET_STALE','Choose exact visible text identities and grapheme boundaries for the comment.',409);}
function mapLineage(anchor:DocumentAnchor,source:CommentSource,targetSceneId:number,mappings:ValidatedCommentLineage[],runs:ReturnType<typeof index>):DocumentAnchor[]|null{
 if(source.sourceKind==='layout-story')return null;
 if(anchor.start===anchor.end){const points=mappings.filter((mapping)=>mapping.source.sceneId===source.sceneId&&mapping.target.sceneId===targetSceneId&&mapping.source.blockId===anchor.blockId&&mapping.source.runId===anchor.runId&&mapping.source.from===anchor.start&&mapping.source.to===anchor.end);if(points.length!==1)return null;const point=points[0];const mapped={blockId:point.target.blockId,runId:point.target.runId,start:point.target.from,end:point.target.to,sourceText:''};return attached(mapped,runs)?[mapped]:null;}
 const spans=mappings.filter((mapping)=>mapping.source.sceneId===source.sceneId&&mapping.target.sceneId===targetSceneId&&mapping.source.blockId===anchor.blockId&&mapping.source.runId===anchor.runId&&mapping.source.from<anchor.end&&mapping.source.to>anchor.start).sort((left,right)=>left.source.from-right.source.from);if(!spans.length)return null;
 let cursor=anchor.start;const result:DocumentAnchor[]=[];
 for(const mapping of spans){const start=Math.max(cursor,mapping.source.from);const end=Math.min(anchor.end,mapping.source.to);if(start!==cursor||end<=start)return null;const mapped={blockId:mapping.target.blockId,runId:mapping.target.runId,start:mapping.target.from+start-mapping.source.from,end:mapping.target.from+end-mapping.source.from,sourceText:anchor.sourceText.slice(start-anchor.start,end-anchor.start)};if(!attached(mapped,runs))return null;result.push(mapped);cursor=end;}
 return cursor===anchor.end?result:null;
}
/** Derive attachment only from stable identities or
 * server-validated operation lineage. Never search for a quotation. */
export function reconcileDocumentComments(previous:ProserDocument,next:ProserDocument,source:CommentSource,actor:{id:number;name:string},operationId:string,options:{lineage?:ValidatedCommentLineage[];sourceDocuments?:CommentSource[];resolution?:CommentResolution}={}){
 const before=index(previous);const after=index(next);const sources=options.sourceDocuments??[source];
 for(const old of previous.comments)if(!next.comments.some((comment)=>comment.id===old.id)&&!old.resolved)throw new DocumentError('DOCUMENT_COMMENT_RECORD_MISSING','Resolve this comment explicitly instead of removing its retained evidence.',409);
 for(const comment of next.comments){
  const old=previous.comments.find((entry)=>entry.id===comment.id);const resolution=options.resolution?.commentId===comment.id?options.resolution:undefined;
  if(!old){if(comment.anchorStates?.length||comment.resolutionHistory?.length)throw new DocumentError('DOCUMENT_COMMENT_EVIDENCE_INVALID','New comments cannot supply server source proofs or resolution history.',422);validateAttachedCommentAnchors(next,comment.anchors);continue;}
  if(canonicalDocument(comment.anchorStates??[])!==canonicalDocument(old.anchorStates??[])||canonicalDocument(comment.resolutionHistory??[])!==canonicalDocument(old.resolutionHistory??[]))throw new DocumentError('DOCUMENT_COMMENT_EVIDENCE_INVALID','Existing comment source proofs and resolution history are server-owned.',422);
  const priorAnchors=structuredClone(old.anchors);const priorStates=structuredClone(old.anchorStates??[]);const originalInput=canonicalDocument(comment.anchors);
  if(resolution?.action==='reanchored'){
   if(!resolution.anchors)throw new DocumentError('DOCUMENT_COMMENT_TARGET_REQUIRED','Explicit reattachment anchors are required.',428);validateAttachedCommentAnchors(next,resolution.anchors);comment.anchors=structuredClone(resolution.anchors);delete comment.anchorStates;
  }else{
   const anchors:DocumentAnchor[]=[];const states:CommentAnchorState[]=[];
   for(const [anchorIndex,anchor]of old.anchors.entries()){
    const retained=old.anchorStates?.find((state)=>state.anchorIndex===anchorIndex);if(retained){states.push({...structuredClone(retained),anchorIndex:anchors.length});anchors.push(structuredClone(anchor));continue;}
    const ownedSource=sources.find((entry)=>entry.document?.comments.some((item)=>item.id===old.id&&item.anchors.some((itemAnchor)=>canonicalDocument(itemAnchor)===canonicalDocument(anchor))))??source;
    const oldRun=before.get(anchor.runId)??(ownedSource.document?index(ownedSource.document).get(anchor.runId):undefined);const newRun=after.get(anchor.runId);let mapped:DocumentAnchor[]|null=null;const sameImage=oldRun?.run.inlineImage&&newRun?.run.inlineImage?oldRun.run.inlineImage.assetId===newRun.run.inlineImage.assetId&&oldRun.run.inlineImage.sha256===newRun.run.inlineImage.sha256:!oldRun?.run.inlineImage&&!newRun?.run.inlineImage;
    if(sameImage&&oldRun&&newRun&&attached(anchor,after)&&oldRun.container===newRun.container&&oldRun.run.text===newRun.run.text)mapped=[structuredClone(anchor)];
    if(!mapped&&source.sourceKind!=='layout-story')mapped=mapLineage(anchor,ownedSource,source.sceneId,options.lineage??[],after);
    if(mapped)anchors.push(...mapped);else{const reason=!newRun?'target-removed':newRun.container!==oldRun?.container||newRun.paragraph.id!==anchor.blockId?'target-container-changed':!newRun.visible?'target-hidden':!sameImage?'target-image-changed':'target-text-changed';const sourceProof=ownedSource.sourceKind==='layout-story'?{sourceKind:'layout-story' as const,sourceStoryId:ownedSource.storyId,sourceLayoutRevisionId:ownedSource.revisionId}:{sourceSceneId:ownedSource.sceneId,sourceSceneRevisionId:ownedSource.revisionId};states.push({anchorIndex:anchors.length,status:reason==='target-removed'?'orphaned':'stale',reason,...sourceProof,sourceContentHash:ownedSource.contentHash,sourceAnchor:structuredClone(anchor)});anchors.push(structuredClone(anchor));}
   }
   if(originalInput!==canonicalDocument(priorAnchors)&&originalInput!==canonicalDocument(anchors))throw new DocumentError('DOCUMENT_COMMENT_REATTACHMENT_REQUIRED','Reattach a comment through its explicit guarded review operation.',409);
   comment.anchors=anchors;if(states.length)comment.anchorStates=states;else delete comment.anchorStates;
  }
  if(resolution?.action==='resolved')comment.resolved=true;if(resolution?.action==='reopened')comment.resolved=false;
  const action=resolution?.action??(comment.resolved!==old.resolved?(comment.resolved?'resolved':'reopened'):undefined);
  if(action){const sourceProof=source.sourceKind==='layout-story'?{sourceKind:'layout-story' as const,sourceStoryId:source.storyId,sourceLayoutRevisionId:source.revisionId}:{sourceSceneRevisionId:source.revisionId};comment.resolutionHistory=[...structuredClone(old.resolutionHistory??[]),{operationId,action,actorId:actor.id,actorName:actor.name,createdAt:new Date().toISOString(),...sourceProof,previousAnchors:priorAnchors,...(priorStates.length?{previousAnchorStates:priorStates}:{})}];}
 }
 return validateDocument(next,{reviewCandidates:true});
}
/** Every retained orphan proof is checked against an immutable owned revision;
 * a caller cannot use a foreign scene or invent historical source text. */
export async function assertOwnedCommentEvidence(tx:Prisma.TransactionClient,userId:number,bookId:number,document:ProserDocument|ProserDocument[]){
 if(!await tx.book.findFirst({where:{id:bookId,userId,deletedAt:{}},select:{id:true}}))throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND','Book not found.',404);
 const groups=new Map<string,{state:CommentAnchorState;proofs:Array<{commentId:string;anchor:DocumentAnchor;storyId?:string}>}>();
 for(const current of Array.isArray(document)?document:[document])for(const comment of current.comments)for(const state of [...(comment.anchorStates??[]),...(comment.resolutionHistory??[]).flatMap((event)=>event.previousAnchorStates??[])]){
  const key=state.sourceKind==='layout-story'?canonicalDocument(['layout-story',state.sourceLayoutRevisionId,state.sourceContentHash]):canonicalDocument(['scene',state.sourceSceneRevisionId,state.sourceSceneId,state.sourceContentHash]);let group=groups.get(key);if(!group){group={state,proofs:[]};groups.set(key,group);}group.proofs.push({commentId:comment.id,anchor:state.sourceAnchor,...(state.sourceKind==='layout-story'?{storyId:state.sourceStoryId}:{})});
 }
 // Materialize one historical document at a time. Retain only the small proof
 // groups across iterations, never a manuscript-sized document cache.
 for(const {state,proofs}of groups.values()){
  if(state.sourceKind==='layout-story'){
   const row=await tx.bookDocumentScopeRevision.findFirst({where:{id:state.sourceLayoutRevisionId,kind:'layout',bookId}});if(!row||row.contentHash!==state.sourceContentHash||hash(row.content)!==row.contentHash)throw new DocumentError('DOCUMENT_COMMENT_SOURCE_INVALID','Retained layout comment source is unavailable, foreign or checksum-invalid.',409);
   const layout=validateBookLayout(row.content);const stories=[...layout.frontMatter,...layout.backMatter,...(layout.headerFooterStories??[])];
   for(const storyId of new Set(proofs.map((proof)=>proof.storyId))){const story=stories.find((story)=>story.id===storyId);if(!story)throw new DocumentError('DOCUMENT_COMMENT_SOURCE_INVALID','Retained layout story identity is unavailable.',409);const original=validateDocument(story.document);const runs=index(original);const anchors=new Map(original.comments.map((comment)=>[comment.id,new Set(comment.anchors.map((anchor)=>canonicalDocument(anchor)))]));for(const proof of proofs.filter((proof)=>proof.storyId===storyId))if(!anchors.get(proof.commentId)?.has(canonicalDocument(proof.anchor))||!attached(proof.anchor,runs,false))throw new DocumentError('DOCUMENT_COMMENT_SOURCE_INVALID','Retained layout comment differs from its exact immutable story identity.',409);}
   continue;
  }
  const row=await tx.sceneDocumentRevision.findFirst({where:{id:state.sourceSceneRevisionId,sceneId:state.sourceSceneId,bookId}});if(!row||row.contentHash!==state.sourceContentHash||hash(row.document)!==row.contentHash)throw new DocumentError('DOCUMENT_COMMENT_SOURCE_INVALID','Retained comment source is unavailable, foreign or checksum-invalid.',409);
  const original=validateDocument(row.document);const runs=index(original);const anchors=new Map(original.comments.map((comment)=>[comment.id,new Set(comment.anchors.map((anchor)=>canonicalDocument(anchor)))]));
  for(const proof of proofs)if(!anchors.get(proof.commentId)?.has(canonicalDocument(proof.anchor))||!attached(proof.anchor,runs,false))throw new DocumentError('DOCUMENT_COMMENT_SOURCE_INVALID','Retained comment quotation differs from its exact immutable identity.',409);
 }
}
