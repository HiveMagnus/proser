/** HTTP/service adapter: complete canonical bodies never leave Factory. */
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { documentService } from './service';
import { DocumentError } from './errors';
import { validateDocument } from './validation';
import { documentPassage, passageHash, committedPassageCursor } from './passageProjection';
import { passageContext, committedContext } from './passage';
import { applyPassageOperations } from './passageOperations';
import { passageOperationsSchema } from './passageOperationValidation';
import { documentPassageRestoreSchema } from './passageValidation';
import { refreshPassageOperationMappings, passageReviewHistoryPage } from './passageOperationSources';
import type { DocumentPassageReceipt } from './passage-model';
import type { DocumentPassageOperationCommit, DocumentPassageOperationAcknowledgement, PassageReviewPageRequest } from './passage-operations-model';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const reference=z.object({revisionId:z.string().uuid(),contentHash:sha}).strict();
export const finalPassageSourceFrameSchema=z.object({bookId:z.number().int().positive(),actId:z.number().int().positive(),chapterId:z.number().int().positive(),sceneId:z.number().int().positive(),bookRevisionId:z.string().uuid(),bookContentHash:sha,sceneRevisionId:z.string().uuid(),sceneContentHash:sha,qualifiedMembershipHash:sha,structureScope:reference,layoutScope:reference,effectiveStyleLayoutHash:sha,projection:z.literal('final')}).strict();
const finalPassageOperationCommitSchema=documentPassageRestoreSchema.omit({restoreFromRevisionId:true,restoreCursor:true}).extend({
 sourceFrame:finalPassageSourceFrameSchema,
 operations:passageOperationsSchema,tracking:z.boolean().optional(),
}).strict();
export const passageOperationCommitSchema=finalPassageOperationCommitSchema.extend({
 sourceFrame:finalPassageSourceFrameSchema.extend({projection:z.enum(['final','markup'])}),
}).refine(input=>input.sourceFrame.projection==='final'||input.operations.every(operation=>operation.kind==='resolve-change'),{
 message:'Markup accepts tracked-change decisions only.',
 path:['operations'],
});
async function assets(tx:Prisma.TransactionClient,userId:number,bookId:number,input:DocumentPassageOperationCommit){
 const ids=input.operations.flatMap(op=>'image' in op?[op.image.assetId]:[]);
 const result=new Map<number,string>();
 for(const row of await tx.imageAsset.findMany({where:{id:{in:ids},userId,bookId},select:{id:true,configJson:true}})){
  try{const value=JSON.parse(row.configJson??'{}') as {sha256?:unknown};if(typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256))result.set(row.id,value.sha256);}catch{/* unverified objects fail in the engine */}
 }return result;
}
export async function commitPassageOperations(userId:number,bookId:number,sceneId:number,input:DocumentPassageOperationCommit):Promise<DocumentPassageReceipt<DocumentPassageOperationAcknowledgement>>{
 if(!input?.operationId||!input.expectedRevisionId||!input.expectedSceneRevisionId||!input.windowHash||!input.sourceFrame)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Book, scene, source frame, passage and operation preconditions are required.',428);
 const parsed=passageOperationCommitSchema.safeParse(input);
 if(!parsed.success)throw new DocumentError('DOCUMENT_PASSAGE_INVALID','Invalid typed passage operation request.',422);
 input=parsed.data;
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{kind:'typed-scene-passage',sceneId,...input}},async tx=>{
  const row=await tx.sceneDocumentRevision.findFirst({where:{id:input.expectedSceneRevisionId,bookId,sceneId}});
  if(!row||passageHash(row.document)!==row.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Scene source is unavailable.',412);
  const document=validateDocument(row.document);
  const owned=await passageContext(tx,bookId,input.expectedRevisionId,sceneId,row.id,row.contentHash);
  const projection=input.sourceFrame.projection;
  const window=documentPassage(document,{bookRevisionId:input.expectedRevisionId,sceneId,sceneRevisionId:row.id,contentHash:row.contentHash},{...input,projection},owned);
  if(window.windowHash!==input.windowHash||passageHash(window.sourceFrame)!==passageHash(input.sourceFrame))throw new DocumentError('DOCUMENT_SOURCE_STALE','Passage ownership, layout, selection or source changed.',412);
  const actor=await tx.user.findUniqueOrThrow({where:{id:userId},select:{username:true}});
  const items=window.items??[];
  const result=applyPassageOperations(document,input.operations,{operationId:input.operationId,sourceFrame:{...owned.sourceFrame,projection},tracking:input.tracking,actor:{id:userId,name:actor.username??String(userId),origin:'manual',createdAt:new Date().toISOString()},verifiedAssets:await assets(tx,userId,bookId,input),styles:owned.styles,window:{
   paragraphIds:window.paragraphs.map(p=>p.paragraph.id),
   runs:window.paragraphs.flatMap(p=>p.runs.map(run=>({blockId:p.paragraph.id,paragraphHash:p.paragraphHash!,containerHash:p.containerHash!,runId:run.runId,sourceHash:run.sourceHash,from:run.from,to:run.to}))),
   objectIds:[...items.flatMap(item=>'source' in item?[item.source.objectId]:[]),...window.paragraphs.flatMap(p=>p.paragraph.runs.filter(run=>run.inlineImage).map(run=>run.id))],
   neighborIds:[...new Set([...items.map(item=>item.placement.before.neighborId),...(window.emptyPlacement?[window.emptyPlacement.neighborId]:[])])],
   rowIds:items.flatMap(item=>item.type==='tableSlice'?item.rows.map(row=>row.id):[]),
   changeIds:window.changeSummaries?.map(change=>change.id)??[],
  }});
  return{result:{passage:window,operationMappings:result.operationMappings,introducedIds:result.introducedIds,touched:result.touched},changedDocuments:[{sceneId,expectedRevisionId:row.id,document:result.document}],anchorLineage:result.anchorLineage,receiptProjection:'references' as const,
   projectCommitted:({revisionId,scenes,manifest})=>{
    const saved=scenes.find(scene=>scene.sceneId===sceneId)!;
    const cursor=committedPassageCursor(saved.document,input.cursor,projection);
    const acknowledgement={passage:documentPassage(saved.document,{bookRevisionId:revisionId,sceneId,sceneRevisionId:saved.revisionId,contentHash:saved.contentHash},{...input,projection,cursor,reviewOffset:projection==='markup'?0:input.reviewOffset},committedContext(owned,revisionId,manifest,saved)),operationMappings:refreshPassageOperationMappings(saved.document,result.operationMappings),introducedIds:result.introducedIds,touched:result.touched};
    if(Buffer.byteLength(JSON.stringify(acknowledgement))>512*1024)throw new DocumentError('DOCUMENT_PASSAGE_RECEIPT_TOO_LARGE','Operation receipt exceeds 512 KiB; split the operation.',413);
    return acknowledgement;
   }
  };
 });
}
export const passageReviewQuery=z.object({bookRevisionId:z.string().uuid(),expectedSceneRevisionId:z.string().uuid(),changeId:z.string().min(1).max(128),recordHash:sha,offset:z.coerce.number().int().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(32).optional()}).strict();
export async function readPassageReviewHistory(userId:number,bookId:number,sceneId:number,request:PassageReviewPageRequest&{bookRevisionId:string}){
 const current=await documentService.manifest(userId,bookId);
 void current;
 const book=await databaseService.client.bookDocumentRevision.findFirst({where:{id:request.bookRevisionId,bookId}});
 const row=await databaseService.client.sceneDocumentRevision.findFirst({where:{id:request.expectedSceneRevisionId,bookId,sceneId}});
 if(!book||!row||passageHash(row.document)!==row.contentHash||passageHash(book.manifest)!==book.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Owned immutable review source is unavailable.',412);
 await passageContext(databaseService.client,bookId,book.id,sceneId,row.id,row.contentHash);
 return passageReviewHistoryPage(validateDocument(row.document),request);
}

export const passageBookCommitSchema=z.object({schemaVersion:z.literal(1),operationId:z.string().uuid(),expectedRevisionId:z.string().uuid(),scenes:z.array(finalPassageOperationCommitSchema.omit({schemaVersion:true,operationId:true,expectedRevisionId:true}).extend({sceneId:z.number().int().positive()}).strict()).min(1).max(8)}).strict();
export async function commitPassageOperationScopes(userId:number,bookId:number,input:import('./passage-operations-model').DocumentPassageBookCommit):Promise<DocumentPassageReceipt<import('./passage-operations-model').DocumentPassageBookAcknowledgement>>{
 if(!input.operationId||!input.expectedRevisionId)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Book and operation preconditions are required.',428);
 const parsed=passageBookCommitSchema.safeParse(input);if(!parsed.success)throw new DocumentError('DOCUMENT_PASSAGE_INVALID','Invalid compound passage operation request.',422);input=parsed.data;
 if(new Set(input.scenes.map(scene=>scene.sceneId)).size!==input.scenes.length)throw new DocumentError('DOCUMENT_PASSAGE_SCOPE_INVALID','Each changed scene appears exactly once.',409);
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{kind:'compound-passages',...input}},async tx=>{
  const actor=await tx.user.findUniqueOrThrow({where:{id:userId},select:{username:true}});
  const prepared:Array<{scope:import("./passage-operations-model").DocumentPassageScopeCommit;row:{id:string;contentHash:string};owned:import("./passageSource").PassageOwnedContext;window:import("./passage-model").DocumentPassage;result:import("./passage-operations-model").DocumentPassageOperationResult}>=[];
  for(const scope of input.scenes){
   const row=await tx.sceneDocumentRevision.findFirst({where:{id:scope.expectedSceneRevisionId,bookId,sceneId:scope.sceneId}});
   if(!row||passageHash(row.document)!==row.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Compound source scene is unavailable.',412);
   const document=validateDocument(row.document),owned=await passageContext(tx,bookId,input.expectedRevisionId,scope.sceneId,row.id,row.contentHash);
   const window=documentPassage(document,{bookRevisionId:input.expectedRevisionId,sceneId:scope.sceneId,sceneRevisionId:row.id,contentHash:row.contentHash},scope,owned);
   if(window.windowHash!==scope.windowHash||passageHash(window.sourceFrame)!==passageHash(scope.sourceFrame))throw new DocumentError('DOCUMENT_SOURCE_STALE','A compound passage source changed.',412);
   const full={schemaVersion:1 as const,operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,...scope};
   const result=applyPassageOperations(document,scope.operations,{operationId:input.operationId,sourceFrame:owned.sourceFrame,tracking:scope.tracking,actor:{id:userId,name:actor.username??String(userId),origin:'manual',createdAt:new Date().toISOString()},verifiedAssets:await assets(tx,userId,bookId,full),styles:owned.styles,window:{paragraphIds:window.paragraphs.map(p=>p.paragraph.id),runs:window.paragraphs.flatMap(p=>p.runs.map(run=>({blockId:p.paragraph.id,paragraphHash:p.paragraphHash!,containerHash:p.containerHash!,runId:run.runId,sourceHash:run.sourceHash,from:run.from,to:run.to}))),objectIds:[...(window.items??[]).flatMap(item=>'source' in item?[item.source.objectId]:[]),...window.paragraphs.flatMap(p=>p.paragraph.runs.filter(run=>run.inlineImage).map(run=>run.id))],neighborIds:[...new Set([...(window.items??[]).map(item=>item.placement.before.neighborId),...(window.emptyPlacement?[window.emptyPlacement.neighborId]:[])])],rowIds:(window.items??[]).flatMap(item=>item.type==='tableSlice'?item.rows.map(row=>row.id):[]),changeIds:window.changeSummaries?.map(change=>change.id)??[]}});
   prepared.push({scope,row,owned,window,result});
  }
  return {result:{passages:prepared.map(p=>({passage:p.window,operationMappings:p.result.operationMappings,introducedIds:p.result.introducedIds,touched:p.result.touched}))},changedDocuments:prepared.map(p=>({sceneId:p.scope.sceneId,expectedRevisionId:p.row.id,document:p.result.document})),anchorLineage:prepared.flatMap(p=>p.result.anchorLineage),receiptProjection:'references' as const,projectCommitted:({revisionId,scenes,manifest})=>{
   const value={passages:prepared.map(p=>{const saved=scenes.find(scene=>scene.sceneId===p.scope.sceneId)!;return {passage:documentPassage(saved.document,{bookRevisionId:revisionId,sceneId:saved.sceneId,sceneRevisionId:saved.revisionId,contentHash:saved.contentHash},{...p.scope,cursor:committedPassageCursor(saved.document,p.scope.cursor)},committedContext(p.owned,revisionId,manifest,saved)),operationMappings:refreshPassageOperationMappings(saved.document,p.result.operationMappings),introducedIds:p.result.introducedIds,touched:p.result.touched};})};
   if(Buffer.byteLength(JSON.stringify(value))>4*1024*1024)throw new DocumentError('DOCUMENT_PASSAGE_RECEIPT_TOO_LARGE','Compound receipt exceeds4MiB.',413);return value;
  }};
 });
}
