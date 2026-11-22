import type {Prisma} from '@prisma/client';
import {documentService} from './service';
import {validateDocument} from './validation';
import {DocumentError} from './errors';
import {passageContext,committedContext} from './passage';
import {documentPassage,passageHash,committedPassageCursor} from './passageProjection';
import {passageOperationParagraphSource,passageOperationRunSource} from './passageOperationSources';
import {moveDocumentBlocks} from './scopeBlockOperations';
import {movedBlockLineage,splitDocumentSceneBoundary,joinDocumentSceneBoundary} from './scopeBoundaryOperations';
import {canonicalDocument,type DocumentManifest,type ProserDocument} from './model';
import {passageScopeTransferSchema,passageScopeRestoreSchema} from './scopePassageValidation';
import type {PassageScopeSource,PassageScopeTransfer,PassageScopeRestore,PassageScopeResult,PassageScopeReceipt} from './scope-passage-model';
export function scopeSceneBoundaryHash(left:ProserDocument,right:ProserDocument){return passageHash({leftHash:passageHash(left.blocks.at(-1)),rightHash:passageHash(right.blocks[0])});}
async function source(tx:Prisma.TransactionClient,bookId:number,bookRevisionId:string,input:PassageScopeSource){
 const row=await tx.sceneDocumentRevision.findFirst({where:{id:input.expectedSceneRevisionId,sceneId:input.sceneId,bookId}});
 if(!row||passageHash(row.document)!==row.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Owned scene source is unavailable or checksum-invalid.',412);
 const owned=await passageContext(tx,bookId,bookRevisionId,input.sceneId,row.id,row.contentHash),document=validateDocument(row.document);
 const window=documentPassage(document,{bookRevisionId,sceneId:input.sceneId,sceneRevisionId:row.id,contentHash:row.contentHash},input.window,owned);
 if(window.windowHash!==input.windowHash||passageHash(window.sourceFrame)!==passageHash(input.sourceFrame)||input.sourceFrame.projection!=='final')throw new DocumentError('DOCUMENT_SOURCE_STALE','Qualified scene passage, layout or ownership changed.',412);
 return {input,row,owned,document,window};
}
const fresh=(operationId:string)=>{let sequence=0;return ()=>`scope-${operationId}-${sequence++}`;};
export async function transferPassageScopes(userId:number,bookId:number,raw:PassageScopeTransfer):Promise<PassageScopeReceipt>{
 if(!raw?.operationId||!raw.expectedRevisionId||!raw.source?.expectedSceneRevisionId||!raw.destination?.expectedSceneRevisionId)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Book, both scenes, windows and operation preconditions are required.',428);
 const parsed=passageScopeTransferSchema.safeParse(raw);if(!parsed.success)throw new DocumentError('DOCUMENT_SCOPE_OPERATION_INVALID','Invalid qualified scene transfer.',422);const input=parsed.data;
 if(input.source.sceneId===input.destination.sceneId)throw new DocumentError('DOCUMENT_SCOPE_OPERATION_INVALID','A cross-scene operation requires distinct scenes.',409);
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{command:'bounded-scope-transfer',...input}},async tx=>{
  const left=await source(tx,bookId,input.expectedRevisionId,input.source),right=await source(tx,bookId,input.expectedRevisionId,input.destination);
  let nextLeft:ProserDocument,nextRight:ProserDocument;let lineage:ReturnType<typeof movedBlockLineage>=[];
  if(input.kind==='move-blocks'){
   const visible=new Set((left.window.items??[]).map(item=>item.placement.before.neighborId));
   for(const target of input.blocks){const block=left.document.blocks.find(block=>block.id===target.blockId);if(!block||!visible.has(block.id)||passageHash(block)!==target.sourceHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','An exact selected complete block changed or is outside the captured passage.',412);}
   const blocks=left.document.blocks.filter(block=>input.blocks.some(target=>target.blockId===block.id));
   const result=moveDocumentBlocks(left.document,right.document,input.blocks.map(item=>item.blockId),input.placement,fresh(input.operationId));nextLeft=result.source;nextRight=result.destination;lineage=movedBlockLineage(blocks,input.source.sceneId,input.destination.sceneId);
  }else{
   const book=await tx.bookDocumentRevision.findUniqueOrThrow({where:{id:input.expectedRevisionId}}),manifest=book.manifest as unknown as DocumentManifest,ids=manifest.scenes.filter(ref=>!ref.deletedAt).map(ref=>ref.sceneId);
   if(ids.indexOf(input.destination.sceneId)!==ids.indexOf(input.source.sceneId)+1)throw new DocumentError('DOCUMENT_SCOPE_OPERATION_INVALID','Scene split/join requires the exact next manuscript scene.',409);
   if(input.kind==='split-scene'){
    if(input.target.from!==input.target.to||input.expectedText!=='')throw new DocumentError('DOCUMENT_SCOPE_OPERATION_INVALID','Scene split requires an exact caret.',409);
    const paragraph=left.document.blocks.find(block=>block.id===input.target.blockId);if(paragraph?.type!=='paragraph')throw new DocumentError('DOCUMENT_SOURCE_STALE','The scene split needs a body paragraph.',412);
    const run=paragraph.runs.find(run=>run.id===input.target.runId),captured=left.window.paragraphs.find(item=>item.paragraph.id===paragraph.id)?.runs.find(item=>item.runId===input.target.runId&&item.from<=input.target.from&&item.to>=input.target.to);
    if(!run||!captured||canonicalDocument(passageOperationRunSource(left.document,paragraph.id,run.id,input.target.from,input.target.to))!==canonicalDocument(input.target))throw new DocumentError('DOCUMENT_SOURCE_STALE','The qualified scene split caret changed.',412);
    const offset=paragraph.runs.slice(0,paragraph.runs.findIndex(item=>item.id===run.id)).reduce((sum,item)=>sum+(item.inlineImage?1:item.text.length),0)+input.target.from;
    const result=splitDocumentSceneBoundary(left.document,right.document,input.source.sceneId,input.destination.sceneId,paragraph.id,offset,fresh(input.operationId));nextLeft=result.left;nextRight=result.right;lineage=result.anchorLineage;
   }else{
    const end=left.document.blocks.at(-1),start=right.document.blocks[0];
    if(end?.type!=='paragraph'||start?.type!=='paragraph'||input.left.blockId!==end.id||input.right.blockId!==start.id||!left.window.paragraphs.some(item=>item.paragraph.id===end.id)||!right.window.paragraphs.some(item=>item.paragraph.id===start.id)||canonicalDocument(passageOperationParagraphSource(left.document,end.id))!==canonicalDocument(input.left)||canonicalDocument(passageOperationParagraphSource(right.document,start.id))!==canonicalDocument(input.right)||scopeSceneBoundaryHash(left.document,right.document)!==input.boundaryHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','The exact scene-end/start paragraph boundary changed or is outside the captured windows.',412);
    const result=joinDocumentSceneBoundary(left.document,right.document,input.source.sceneId,input.destination.sceneId,fresh(input.operationId),input.tracking);nextLeft=result.left;nextRight=result.right;lineage=result.anchorLineage;
   }
  }
  const initial:PassageScopeResult={passages:[left.window,right.window],sourceBookRevisionId:input.expectedRevisionId,sceneIds:[input.source.sceneId,input.destination.sceneId],anchorLineage:lineage.slice(0,64)};
  return {result:initial,changedDocuments:[{sceneId:input.source.sceneId,expectedRevisionId:left.row.id,document:nextLeft},{sceneId:input.destination.sceneId,expectedRevisionId:right.row.id,document:nextRight}],anchorLineage:lineage,receiptProjection:'references' as const,
   projectCommitted:({revisionId,manifest,scenes})=>{const result={...initial,passages:[left,right].map(scope=>{const saved=scenes.find(scene=>scene.sceneId===scope.input.sceneId)!;return documentPassage(saved.document,{bookRevisionId:revisionId,sceneId:saved.sceneId,sceneRevisionId:saved.revisionId,contentHash:saved.contentHash},{...scope.input.window,cursor:committedPassageCursor(saved.document,scope.input.window.cursor??{paragraph:0,offset:0})},committedContext(scope.owned,revisionId,manifest,saved));})};if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw new DocumentError('DOCUMENT_SCOPE_RECEIPT_TOO_LARGE','Bounded scope receipt exceeds 1 MiB.',413);return result;},
  };
 }) as Promise<PassageScopeReceipt>;
}
export async function restorePassageScopes(userId:number,bookId:number,raw:PassageScopeRestore):Promise<PassageScopeReceipt>{
 if(!raw?.operationId||!raw.expectedRevisionId||!raw.restoreFromBookRevisionId||!raw.scenes?.length)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Book/source revision, affected scenes and operation preconditions are required.',428);
 const parsed=passageScopeRestoreSchema.safeParse(raw);if(!parsed.success)throw new DocumentError('DOCUMENT_SCOPE_OPERATION_INVALID','Invalid bounded scope restoration.',422);const input=parsed.data;
 if(new Set(input.scenes.map(item=>item.sceneId)).size!==input.scenes.length)throw new DocumentError('DOCUMENT_SCOPE_OPERATION_INVALID','Restoration requires distinct complete scopes.',409);
 return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{kind:'bounded-scope-restore',...input}},async tx=>{
  const target=await tx.bookDocumentRevision.findFirst({where:{id:input.restoreFromBookRevisionId,bookId}}),current=await tx.bookDocumentRevision.findFirst({where:{id:input.expectedRevisionId,bookId}});
  if(!target||!current||passageHash(target.manifest)!==target.contentHash||passageHash(current.manifest)!==current.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Owned restoration manifest is unavailable or checksum-invalid.',412);
  const from=target.manifest as unknown as DocumentManifest,to=current.manifest as unknown as DocumentManifest,selected=new Set(input.scenes.map(item=>item.sceneId));
  const membership=(manifest:DocumentManifest)=>manifest.scenes.map(({revisionId:_revision,contentHash:_hash,wordCount:_words,...rest})=>rest);
  if(canonicalDocument(membership(from))!==canonicalDocument(membership(to))||from.scopes?.structure.contentHash!==to.scopes?.structure.contentHash||from.scopes?.layout.contentHash!==to.scopes?.layout.contentHash||to.scenes.some(ref=>!selected.has(ref.sceneId)&&from.scenes.find(old=>old.sceneId===ref.sceneId)?.revisionId!==ref.revisionId))throw new DocumentError('DOCUMENT_SCOPE_RESTORE_INCOMPATIBLE','Other scopes or structure changed; restore the complete affected journal operation instead.',409);
  const scopes=await Promise.all(input.scenes.map(item=>source(tx,bookId,input.expectedRevisionId,item))),documents=[];
  for(const scope of scopes){const ref=from.scenes.find(item=>item.sceneId===scope.input.sceneId&&!item.deletedAt);if(!ref)throw new DocumentError('DOCUMENT_SCOPE_RESTORE_INCOMPATIBLE','Selected revision does not contain the live scene scope.',409);const row=await tx.sceneDocumentRevision.findFirst({where:{id:ref.revisionId,sceneId:ref.sceneId,bookId}});if(!row||passageHash(row.document)!==ref.contentHash)throw new DocumentError('DOCUMENT_SOURCE_STALE','Owned complete restoration document is unavailable.',412);documents.push({sceneId:ref.sceneId,expectedRevisionId:scope.row.id,restoreFromRevisionId:row.id,document:validateDocument(row.document)});}
  const initial:PassageScopeResult={passages:scopes.map(scope=>scope.window),sourceBookRevisionId:input.expectedRevisionId,sceneIds:input.scenes.map(item=>item.sceneId),restoredFromBookRevisionId:input.restoreFromBookRevisionId};
  return {result:initial,changedDocuments:documents,receiptProjection:'references' as const,projectCommitted:({revisionId,manifest,scenes})=>({...initial,passages:scopes.map(scope=>{const saved=scenes.find(scene=>scene.sceneId===scope.input.sceneId)!;return documentPassage(saved.document,{bookRevisionId:revisionId,sceneId:saved.sceneId,sceneRevisionId:saved.revisionId,contentHash:saved.contentHash},{...scope.input.window,cursor:committedPassageCursor(saved.document,scope.input.window.cursor??{paragraph:0,offset:0})},committedContext(scope.owned,revisionId,manifest,saved));})})};
 }) as Promise<PassageScopeReceipt>;
}
