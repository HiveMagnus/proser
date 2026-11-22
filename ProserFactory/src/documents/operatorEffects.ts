import {assertNewReleaseAdmission,withReleaseRecovery,runReleaseProviderEffect,providerWasNotStarted} from '@/operations/releaseAdmission';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { currentDocumentMutationContext } from '@/services/documentMutationContext';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import { documentService, type DocumentManifest } from './service';
import { canonicalDocument } from './model';
import { DocumentError } from './errors';
const hash=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function retainOperatorTerminal(id:string,error:InferenceTerminalError){
 const db=databaseService.client;let data:unknown={code:error.code,reason:error.finishReason,context:error.context,partialOutput:error.partialOutput};
 const byteLength=Buffer.byteLength(canonicalDocument(data));const oversized=byteLength>8*1024*1024;
 if(oversized)data={retainedResult:false,byteLength,fullResultSha256:hash(error.partialOutput),code:error.code,reason:error.finishReason};
 const row=await db.documentOperatorEffect.findUniqueOrThrow({where:{id}});
 await db.documentOperatorEffect.updateMany({where:{id,status:row.status},data:{status:row.status==='cancelled'?'cancelled':'failed',result:json({providerOutcome:'terminal',data,sha256:hash(data)}),errorCode:oversized?'DOCUMENT_OPERATOR_RESULT_TOO_LARGE':error.code,completedAt:new Date()}});
 if(oversized)throw new DocumentError('DOCUMENT_OPERATOR_RESULT_TOO_LARGE','Known terminal provider output exceeded retention limit.',413);
}
export interface OperatorEffectDescriptor { id:string;userId:number;bookId:number;sceneId?:number;kind:'cli-revise'|'cli-outline'|'cli-characters';intent:unknown;expectedBookRevision?:string;timeoutMs?:number }
export interface RetainedOperatorResult<Request,Result> {operationId:string;sourceBookRevision:string;sourceContentHash:string;request:Request;result:Result}
export async function readOperatorEffect(userId:number,bookId:number,id:string){
 return withReleaseRecovery(()=>documentService.sideRecord(userId,bookId,async(tx)=>{
  let row=await tx.documentOperatorEffect.findFirst({where:{id,bookId,userId}});
  if(!row)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_NOT_FOUND','Owned operator operation not found.',404);
  const source=await tx.bookDocumentRevision.findFirst({where:{id:row.sourceBookRevision,bookId}});
  if(!source||source.contentHash!==row.sourceContentHash||hash(source.manifest)!==source.contentHash||hash(row.request)!==row.requestHash)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_INVALID','Retained operation evidence is invalid.',503);
  if(row.status==='running'&&row.startedAt&&Date.now()-row.startedAt.getTime()>row.timeoutMs+30000){await tx.documentOperatorEffect.updateMany({where:{id,status:'running'},data:{status:'unknown',errorCode:'PROVIDER_ACKNOWLEDGEMENT_EXPIRED'}});row=await tx.documentOperatorEffect.findUniqueOrThrow({where:{id}});}
  if(row.result){const output=row.result as {data:unknown;sha256:string};if(hash(output.data)!==output.sha256)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_INVALID','Retained provider result checksum is invalid.',503);}
  const applied=await tx.documentOperation.findFirst({where:{id,bookId,userId},select:{receipt:true}});
  const receipt=applied?.receipt as {revisionId?:string;contentHash?:string}|undefined;
  return {...row,application:applied?{status:'committed',operationId:id,revisionId:receipt?.revisionId,contentHash:receipt?.contentHash}:{status:'unapplied'}};
 }));
}
export async function cancelOperatorEffect(userId:number,bookId:number,id:string){return documentService.sideRecord(userId,bookId,async(tx)=>{
 const row=await tx.documentOperatorEffect.findFirst({where:{id,bookId,userId}});if(!row)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_NOT_FOUND','Owned operator operation not found.',404);
 if(['pending','running','completed'].includes(row.status)&&!await tx.documentOperation.findFirst({where:{id,bookId,userId}})){
  const changed=await tx.documentOperatorEffect.updateMany({where:{id,status:row.status},data:{status:'cancelled',errorCode:row.result?'OWNER_CANCELLED_KNOWN_UNAPPLIED_RESULT':row.startedAt?'OWNER_CANCELLED_PROVIDER_OUTCOME_UNCONFIRMED':'OWNER_CANCELLED_BEFORE_PROVIDER',completedAt:new Date()}});
  if(changed.count)await tx.auditLog.create({data:{userId,entityType:'book',entityId:bookId,action:'update',metadata:{action:'document-operator-cancelled',operationId:id,previousStatus:row.status,providerStarted:Boolean(row.startedAt),knownResult:Boolean(row.result)}}});
 }
 return {operationId:id,status:(await tx.documentOperatorEffect.findUniqueOrThrow({where:{id}})).status};
});}
/** Freeze owned canonical context before spending one provider effect. Repeated
 * commands recover known output and never replay running/unknown effects. */
export async function runOperatorEffect<Request,Result>(descriptor:OperatorEffectDescriptor,prepare:(tx:Prisma.TransactionClient,manifest:DocumentManifest&{revisionId:string;contentHash:string})=>Promise<Request>,invoke:(request:Request,signal:AbortSignal)=>Promise<Result>):Promise<RetainedOperatorResult<Request,Result>>{
 if(!z.string().uuid().safeParse(descriptor.id).success)throw new DocumentError('DOCUMENT_OPERATION_INVALID','Operator operation ID must be a UUID.',400);
 const db=databaseService.client;const intentHash=hash({kind:descriptor.kind,intent:descriptor.intent,sceneId:descriptor.sceneId??null});
 const timeoutMs=Math.min(600000,Math.max(1000,descriptor.timeoutMs??120000));
 let row=await documentService.sideRecord(descriptor.userId,descriptor.bookId,async(tx)=>{
  const previous=await tx.documentOperatorEffect.findUnique({where:{id:descriptor.id}});
  if(previous){if(previous.userId!==descriptor.userId||previous.bookId!==descriptor.bookId||previous.kind!==descriptor.kind||previous.intentHash!==intentHash)throw new DocumentError('DOCUMENT_OPERATION_CONFLICT','Operator ID belongs to a different retained command.',409);return previous;}
  const unresolved=await tx.documentOperatorEffect.findFirst({where:{userId:descriptor.userId,bookId:descriptor.bookId,sceneId:descriptor.sceneId??null,kind:descriptor.kind,intentHash,OR:[{status:{in:['pending','running','unknown']}},{status:'cancelled',startedAt:{not:null},result:{equals:Prisma.DbNull}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],select:{id:true,status:true}});
  if(unresolved)throw new DocumentError('DOCUMENT_OPERATOR_UNRESOLVED_EFFECT','Recover the original pending or uncertain provider operation before repeating this command with a new ID.',409,{operationId:unresolved.id,status:unresolved.status});
  const head=await tx.bookDocumentHead.findUnique({where:{bookId:descriptor.bookId}});const source=head?await tx.bookDocumentRevision.findFirst({where:{id:head.revisionId,bookId:descriptor.bookId}}):null;
  if(!head||!source||hash(head.manifest)!==source.contentHash)throw new DocumentError('DOCUMENT_MANIFEST_INVALID','Canonical source manifest is unavailable.',503);
  if(descriptor.expectedBookRevision&&descriptor.expectedBookRevision!==head.revisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','Book changed before operator inference admission.',412);
  const request=await prepare(tx,{...head.manifest as unknown as DocumentManifest,revisionId:head.revisionId,contentHash:source.contentHash});
  if(Buffer.byteLength(canonicalDocument(request))>8*1024*1024)throw new DocumentError('DOCUMENT_COMMIT_TOO_LARGE','Frozen operator request exceeds 8 MiB.',413);
  return tx.documentOperatorEffect.create({data:{id:descriptor.id,userId:descriptor.userId,bookId:descriptor.bookId,sceneId:descriptor.sceneId,kind:descriptor.kind,intentHash,sourceBookRevision:head.revisionId,sourceContentHash:source.contentHash,request:json(request),requestHash:hash(request),timeoutMs}});
 });
 if(hash(row.request)!==row.requestHash)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_INVALID','Frozen request checksum is invalid.',503);
 if(row.status==='pending'){
  const claimed=await documentService.sideRecord(descriptor.userId,descriptor.bookId,async(tx)=>{
   const head=await tx.bookDocumentHead.findUniqueOrThrow({where:{bookId:descriptor.bookId}});if(head.revisionId!==row.sourceBookRevision)throw new DocumentError('DOCUMENT_SOURCE_STALE','Saved source changed before provider dispatch.',412);
   await assertNewReleaseAdmission(tx);
   return tx.documentOperatorEffect.updateMany({where:{id:row.id,status:'pending'},data:{status:'running',startedAt:new Date()}});
  });
  if(claimed.count!==1)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_RUNNING','Recover the original operator operation.',409,{operationId:row.id});
  const controller=new AbortController();const caller=currentDocumentMutationContext()?.signal();const signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
  const deadline=setTimeout(()=>controller.abort(new Error('Operator inference deadline exceeded.')),timeoutMs);deadline.unref();let polling=false;
  const poll=setInterval(()=>{if(polling)return;polling=true;void db.documentOperatorEffect.findUnique({where:{id:row.id},select:{status:true}}).then((current)=>{if(!current||!['running','unknown'].includes(current.status))controller.abort(new Error('Retained operator operation was cancelled.'));}).catch(()=>controller.abort(new Error('Operator authority could not be verified.'))).finally(()=>{polling=false;});},1000);poll.unref();
  try{
   const invocation=runReleaseProviderEffect(()=>invoke(row.request as Request,signal),{kind:'operator-effect',id:row.id,bookId:row.bookId,revisionId:row.sourceBookRevision,hash:row.sourceContentHash}).then(async(result)=>{
    const output={providerOutcome:'completed',data:result,sha256:hash(result)};
    const byteLength=Buffer.byteLength(canonicalDocument(output));
    if(byteLength>8*1024*1024){
      const metadata={retainedResult:false,byteLength,fullResultSha256:hash(result)};
      await db.documentOperatorEffect.updateMany({where:{id:row.id,status:{in:['running','unknown']}},data:{status:'failed',result:json({providerOutcome:'completed',data:metadata,sha256:hash(metadata)}),errorCode:'DOCUMENT_OPERATOR_RESULT_TOO_LARGE',completedAt:new Date()}});
      throw new DocumentError('DOCUMENT_OPERATOR_RESULT_TOO_LARGE','Known provider output exceeded the retained 8 MiB limit.',413);
    }
    const current=await db.documentOperatorEffect.findUniqueOrThrow({where:{id:row.id}});
    await db.documentOperatorEffect.updateMany({where:{id:row.id,status:current.status},data:{result:json(output),status:current.status==='cancelled'?'cancelled':'completed',completedAt:new Date(),errorCode:null}});
    return result;
   }).catch(async(error:unknown)=>{if(error instanceof InferenceTerminalError)await retainOperatorTerminal(row.id,error);throw error;});
   let abortListener:(()=>void)|undefined;
   const interrupted=new Promise<never>((_resolve,reject)=>{abortListener=()=>reject(signal.reason??new Error('Operator inference interrupted.'));if(signal.aborted)abortListener();else signal.addEventListener('abort',abortListener,{once:true});});
   try{await Promise.race([invocation,interrupted]);}finally{if(abortListener)signal.removeEventListener('abort',abortListener);}
   if(signal.aborted)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_CANCELLED','The known provider response was retained; application was suppressed.',409,{operationId:row.id});
  }catch(error){
   if(providerWasNotStarted(error)){await db.documentOperatorEffect.updateMany({where:{id:row.id,status:'running'},data:{status:'pending',startedAt:null,errorCode:'PROVIDER_NOT_STARTED'}});throw error;}
   if(error instanceof InferenceTerminalError){await retainOperatorTerminal(row.id,error);throw error;}
   if(error instanceof DocumentError&&['DOCUMENT_OPERATOR_EFFECT_CANCELLED','DOCUMENT_OPERATOR_RESULT_TOO_LARGE'].includes(error.code))throw error;
   await db.documentOperatorEffect.updateMany({where:{id:row.id,status:'running'},data:{status:'unknown',errorCode:error instanceof DocumentError?error.code:'PROVIDER_OUTCOME_UNKNOWN'}});
   throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_UNKNOWN','Provider outcome is uncertain. Recover this operation before any retry.',409,{operationId:row.id});
  }finally{clearTimeout(deadline);clearInterval(poll);}
  row=await db.documentOperatorEffect.findUniqueOrThrow({where:{id:row.id}});
 }
 const verified=await readOperatorEffect(descriptor.userId,descriptor.bookId,row.id);
 if(verified.status!=='completed'||!verified.result)throw new DocumentError(`DOCUMENT_OPERATOR_EFFECT_${verified.status.toUpperCase()}`,'Retained provider operation cannot be repeated or applied.',409,{operationId:row.id,status:verified.status});
 const envelope=verified.result as {data:Result;sha256:string};
 return {operationId:row.id,sourceBookRevision:verified.sourceBookRevision,sourceContentHash:verified.sourceContentHash,request:verified.request as Request,result:envelope.data};
}
/** Check this inside the same book-locked catalog callback as applying output. */
export async function assertOperatorApplication(tx:Prisma.TransactionClient,userId:number,bookId:number,id:string,sourceRevision:string,result:unknown){
 const row=await tx.documentOperatorEffect.findFirst({where:{id,userId,bookId}});const envelope=row?.result as {data:unknown;sha256:string}|undefined;
 if(!row||row.status!=='completed'||row.sourceBookRevision!==sourceRevision||!envelope||hash(envelope.data)!==envelope.sha256||hash(result)!==envelope.sha256)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_NOT_APPLICABLE','Operator evidence was cancelled, changed or belongs to another source.',409,{operationId:id});
}
