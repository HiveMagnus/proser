import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Prisma} from '@prisma/client';
import {databaseService} from '@/lib/database';
import {canonicalDocument} from '@/documents/model';
import {DocumentError} from '@/documents/errors';
import {documentService} from '@/documents/service';
import {currentDocumentMutationContext} from '@/services/documentMutationContext';
import {currentWorkflowExecution} from '@/services/workflowExecutionContext';
import {withVerifiedReleaseMaintenance,type ReleaseMaintenanceAction,type VerifiedReleaseMaintenance} from './releaseAdmission';
import {validateReleaseProof} from './releaseTransition';
const schema=z.object({operationId:z.string().uuid(),releaseId:z.string().uuid(),generation:z.number().int().nonnegative(),candidateSha:z.string().regex(/^[a-f0-9]{40}$/),proofSha:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['backfill-document-authority','register-selected-artwork','recover-search-index','verify-document-bridge']),userId:z.number().int().positive(),bookIds:z.array(z.number().int().positive()).min(1).max(100),operator:z.string().min(1).max(200)}).strict();
export type ReleaseMaintenanceInput=z.infer<typeof schema>;
const hash=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
/** Local, action/scope-specific migration work. Generic body/catalog/provider
 * methods cannot use this context and no HTTP request can mint it. */
export async function runReleaseMaintenance(raw:ReleaseMaintenanceInput,proofBytes:Uint8Array){
 if(currentDocumentMutationContext()||currentWorkflowExecution())throw new DocumentError('DOCUMENT_OPERATOR_REQUIRED','Release maintenance is a local operator action, not an HTTP/workflow grant.',403);
 const input=schema.parse(raw);if(new Set(input.bookIds).size!==input.bookIds.length)throw new DocumentError('RELEASE_MAINTENANCE_INVALID','Select each owned book exactly once.',422);
 if(proofBytes.byteLength>128*1024||createHash('sha256').update(proofBytes).digest('hex')!==input.proofSha)throw new DocumentError('RELEASE_PROOF_MISMATCH','Exact reviewed proof bytes are required.',409);
 const proof=validateReleaseProof(JSON.parse(Buffer.from(proofBytes).toString('utf8')),{...input,action:'close',expectedGeneration:input.generation});
 const allowed=proof.maintenance?.find(scope=>scope.action===input.action&&scope.userId===input.userId&&input.bookIds.every(id=>scope.bookIds.includes(id)));
 if(!allowed)throw new DocumentError('RELEASE_MAINTENANCE_SCOPE_INVALID','Proof does not authorize this maintenance action and these owned book IDs.',403);
 const requestHash=hash(input);const db=databaseService.client;const previous=await db.releaseFenceReceipt.findUnique({where:{operationId:input.operationId}});
 if(previous){if(previous.requestHash!==requestHash)throw new DocumentError('RELEASE_OPERATION_CONFLICT','Recover the exact original maintenance operation.',409);return previous.result;}
 await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM release_admission_fence WHERE id=1 FOR SHARE`;
  const current=await tx.releaseAdmissionFence.findUniqueOrThrow({where:{id:1}});if(current.phase!=='fenced'||current.releaseId!==input.releaseId||current.generation!==input.generation||current.candidateSha!==input.candidateSha||current.proofSha!==input.proofSha)throw new DocumentError('RELEASE_MAINTENANCE_STALE','Maintenance proof belongs to another release generation.',412);
  if(await tx.book.count({where:{id:{in:input.bookIds},userId:input.userId,deletedAt:{}}})!==input.bookIds.length)throw new DocumentError('RELEASE_MAINTENANCE_SCOPE_INVALID','All selected books must be owned, including explicit archived scopes.',404);
  const admitted=await tx.releaseMutationAdmission.findUnique({where:{id:input.operationId}});if(admitted){if(admitted.requestHash!==requestHash||admitted.kind!=='release-maintenance')throw new DocumentError('RELEASE_OPERATION_CONFLICT','Maintenance admission changed.',409);}else await tx.releaseMutationAdmission.create({data:{id:input.operationId,instanceId:input.releaseId,userId:input.userId,kind:'release-maintenance',scope:`${input.action}:${input.bookIds.join(',')}`,requestHash,generation:input.generation}});
 });
 const context:VerifiedReleaseMaintenance={...input,action:input.action as ReleaseMaintenanceAction,requestHash};
 const result=await withVerifiedReleaseMaintenance(context,async()=>{
  const books:Array<{bookId:number;result:unknown}>=[];
  for(const bookId of input.bookIds){let outcome:unknown;
   if(input.action==='backfill-document-authority')outcome={revisionId:await documentService.initialize(input.userId,bookId,{includeDeleted:true,source:'operator-backfill'})};
   else if(input.action==='verify-document-bridge')outcome=await documentService.ensureRevisionBridge(input.userId,bookId,undefined,[],{includeDeleted:true,source:'operator-backfill'});
   else if(input.action==='register-selected-artwork')outcome=await documentService.registerSelectedArtworkForRelease(input.userId,bookId);
   else{let after:string|undefined;let inserted=0;let verified=0;do{const page=await documentService.recoverSearchIndexForRelease(input.userId,bookId,after);inserted+=page.inserted;verified+=page.verified;after=page.nextAfter;}while(after);outcome={inserted,verified};}
   const source=await db.bookDocumentHead.findUnique({where:{bookId},select:{revisionId:true,manifest:true}});
   await db.releaseAdmissionBinding.createMany({data:[{id:hash({operationId:input.operationId,bookId}),admissionId:input.operationId,domainKind:input.action,domainId:String(bookId),sourceBookId:bookId,sourceRevisionId:source?.revisionId,sourceHash:source?hash(source.manifest):hash(outcome)}],skipDuplicates:true});books.push({bookId,result:outcome});
  }
  return {schemaVersion:1,operationId:input.operationId,status:'completed',action:input.action,releaseId:input.releaseId,generation:input.generation,books};
 });
 await db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM release_admission_fence WHERE id=1 FOR SHARE`;const current=await tx.releaseAdmissionFence.findUniqueOrThrow({where:{id:1}});if(current.generation!==input.generation||current.releaseId!==input.releaseId||current.phase!=='fenced')throw new DocumentError('RELEASE_MAINTENANCE_STALE','Release changed before durable maintenance acknowledgement; recover exact admission/book revision evidence.',412);const existing=await tx.releaseFenceReceipt.findUnique({where:{operationId:input.operationId}});if(existing){if(existing.requestHash!==requestHash)throw new DocumentError('RELEASE_OPERATION_CONFLICT','Maintenance receipt changed.',409);return;}await tx.releaseFenceReceipt.create({data:{operationId:input.operationId,releaseId:input.releaseId,action:input.action,requestHash,expectedGeneration:input.generation,operator:input.operator,result:JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue}});});return result;
}
