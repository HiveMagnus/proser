import {createHash} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {databaseService} from '@/lib/database';
import {canonicalDocument} from '@/documents/model';
import {DocumentError} from '@/documents/errors';
const sha=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
const proofSchema=z.object({schemaVersion:z.literal(1),releaseId:z.string().uuid(),candidateSha:z.string().regex(/^[a-f0-9]{40}$/),approvedBy:z.string().min(1).max(200),reviewed:z.literal(true),actions:z.array(z.enum(['close','reopen'])).min(1),targetDatabase:z.string().min(1).max(300),enforcementSqlSha:z.string().regex(/^[a-f0-9]{64}$/),compatibilityRevision:z.string().regex(/^[a-f0-9]{40}$/),backupEvidenceSha:z.string().regex(/^[a-f0-9]{64}$/),restoreEvidenceSha:z.string().regex(/^[a-f0-9]{64}$/),admissionFenceSupport:z.literal(true),maintenance:z.array(z.object({action:z.enum(['backfill-document-authority','register-selected-artwork','recover-search-index','verify-document-bridge']),userId:z.number().int().positive(),bookIds:z.array(z.number().int().positive()).min(1).max(100)}).strict()).max(100).optional(),environment:z.enum(['isolated-rehearsal','production'])}).strict();
export type ReleaseProof=z.infer<typeof proofSchema>;
export interface ReleaseQueue {name:string;isPaused():Promise<boolean>;pause():Promise<void>;resume():Promise<void>}
export interface ReleaseTransition {operationId:string;releaseId:string;action:'close'|'reopen';expectedGeneration:number;candidateSha:string;proofSha:string;proof:ReleaseProof;operator:string}
interface Receipt {schemaVersion:1;phase:'open'|'fenced';generation:number;releaseId:string;queues:Array<{name:string;previouslyPaused:boolean}>;crossStore:'queue-actions-recoverable';}
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function databaseReleaseIdentity(value=process.env.DATABASE_URL??''){const url=new URL(value);return `${url.hostname}:${url.port||'5432'}${url.pathname}`;}
export function validateReleaseProof(proof:unknown,input:Omit<ReleaseTransition,'proof'|'operator'>){const parsed=proofSchema.parse(proof);if(parsed.releaseId!==input.releaseId||parsed.candidateSha!==input.candidateSha||!parsed.actions.includes(input.action)||parsed.targetDatabase!==databaseReleaseIdentity())throw new DocumentError('RELEASE_PROOF_MISMATCH','Reviewed proof does not authorize this candidate, database, release and action.',409);if(parsed.environment==='isolated-rehearsal'&&!/^127\.0\.0\.1:55441\/proser_canvas_[a-z0-9_]+$/.test(parsed.targetDatabase))throw new DocumentError('RELEASE_PROOF_MISMATCH','Isolated proof cannot authorize another database.',409);return parsed;}
/** Each queue action is idempotent and recoverable from the immutable DB
 * receipt. No attempt to make PostgreSQL and Redis appear one atomic store. */
export async function transitionRelease(input:ReleaseTransition,queues:ReleaseQueue[]):Promise<Receipt>{
 return databaseService.client.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(7661,2200)::text`;return transitionReleaseLocked(input,queues);},{timeout:60000});
}
async function transitionReleaseLocked(input:ReleaseTransition,queues:ReleaseQueue[]):Promise<Receipt>{
 z.string().uuid().parse(input.operationId);z.number().int().nonnegative().parse(input.expectedGeneration);z.string().regex(/^[a-f0-9]{64}$/).parse(input.proofSha);validateReleaseProof(input.proof,input);
 if(new Set(queues.map(queue=>queue.name)).size!==queues.length||!input.operator.trim())throw new DocumentError('RELEASE_TRANSITION_INVALID','Explicit operator and unique known queue identities are required.',422);
 const requestHash=sha({...input,proof:input.proof});const db=databaseService.client;
 const prior=await db.releaseFenceReceipt.findUnique({where:{operationId:input.operationId}});
 if(prior&&prior.requestHash!==requestHash)throw new DocumentError('RELEASE_OPERATION_CONFLICT','Recover the original transition ID with its exact request.',409);
 let receipt=prior?.result as unknown as Receipt|undefined;
 if(!receipt){
  const observed=await db.releaseAdmissionFence.findUniqueOrThrow({where:{id:1}});
  if(observed.generation!==input.expectedGeneration)throw new DocumentError('RELEASE_GENERATION_STALE','Release fence generation changed.',412,{generation:observed.generation});
  let queueStates:Array<{name:string;previouslyPaused:boolean}>;
  if(input.action==='close')queueStates=await Promise.all(queues.map(async queue=>({name:queue.name,previouslyPaused:await queue.isPaused()})));
  else{const close=await db.releaseFenceReceipt.findFirst({where:{releaseId:input.releaseId,action:'close'},orderBy:{createdAt:'desc'}});if(!close)throw new DocumentError('RELEASE_RECEIPT_REQUIRED','Recover the exact close receipt before reopening.',409);queueStates=(close.result as unknown as Receipt).queues;}
  if(canonicalDocument(queueStates.map(q=>q.name).sort())!==canonicalDocument(queues.map(q=>q.name).sort()))throw new DocumentError('RELEASE_QUEUE_SCOPE_MISMATCH','Known queue identities changed; reconcile the original release.',409);
  // Reopening queues while the DB remains fenced cannot start guarded work.
  // A failure keeps the durable admission barrier closed; recover the same ID.
  if(input.action==='reopen'){if(observed.phase!=='fenced'||observed.releaseId!==input.releaseId)throw new DocumentError('RELEASE_SCOPE_MISMATCH','The closed fence belongs to another release.',409);for(const state of queueStates)if(!state.previouslyPaused)await queues.find(q=>q.name===state.name)!.resume();}
  receipt=await db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM release_admission_fence WHERE id = 1 FOR UPDATE`;
   const recovered=await tx.releaseFenceReceipt.findUnique({where:{operationId:input.operationId}});if(recovered){if(recovered.requestHash!==requestHash)throw new DocumentError('RELEASE_OPERATION_CONFLICT','Transition ID changed.',409);return recovered.result as unknown as Receipt;}
   const current=await tx.releaseAdmissionFence.findUniqueOrThrow({where:{id:1}});if(current.generation!==input.expectedGeneration)throw new DocumentError('RELEASE_GENERATION_STALE','Fence changed before transition.',412,{generation:current.generation});
   if(input.action==='close'&&current.phase!=='open'||input.action==='reopen'&&(current.phase!=='fenced'||current.releaseId!==input.releaseId))throw new DocumentError('RELEASE_SCOPE_MISMATCH','Fence phase does not match the reviewed action.',409);
   await tx.$queryRaw`SELECT set_config('proser.release_operator', ${input.proofSha}, true)`;
   const result:Receipt={schemaVersion:1,phase:input.action==='close'?'fenced':'open',generation:current.generation+1,releaseId:input.releaseId,queues:queueStates,crossStore:'queue-actions-recoverable'};
   await tx.releaseAdmissionFence.update({where:{id:1},data:{phase:result.phase,generation:result.generation,releaseId:input.releaseId,candidateSha:input.candidateSha,proofSha:input.proofSha,operator:input.operator,cutoff:input.action==='close'?new Date():current.cutoff}});
   await tx.releaseFenceReceipt.create({data:{operationId:input.operationId,releaseId:input.releaseId,action:input.action,requestHash,expectedGeneration:input.expectedGeneration,operator:input.operator,result:json(result)}});return result;
  });
 }
 if(input.action==='close'){const current=await db.releaseAdmissionFence.findUniqueOrThrow({where:{id:1}});if(current.generation===receipt.generation&&current.phase==='fenced'&&current.releaseId===receipt.releaseId)for(const state of receipt.queues)await queues.find(queue=>queue.name===state.name)!.pause();}
 return receipt;
}
/** Bounded, content-free inventory. Domain journals—not admission facts—own
 * provider outcomes. Unbound/unknown effects remain explicit handoff items. */
export async function releaseInventory(cursor?:string,limit=50,domainCursors:Partial<Record<'workflows'|'inference'|'operators'|'publications'|'workflowEffects'|'proposals'|'analyses'|'sharedResources'|'storyProposals',string>>={},bindingCursor?:string){
 const db=databaseService.client;limit=Math.max(1,Math.min(100,limit));const observedAt=new Date().toISOString();const fence=await db.releaseAdmissionFence.findUniqueOrThrow({where:{id:1}});
 const rows=await db.releaseMutationAdmission.findMany({where:cursor?{id:{gt:cursor}}:undefined,orderBy:{id:'asc'},take:limit+1});const page=rows.slice(0,limit);const bindings=await db.releaseAdmissionBinding.findMany({where:{admissionId:{in:page.map(row=>row.id)},...(bindingCursor?{id:{gt:bindingCursor}}:{})},orderBy:{id:'asc'},take:1001});
 const workflows=await db.workflowRun.findMany({where:{status:{in:['queued','running','failed','paused']},...(domainCursors.workflows?{id:{gt:domainCursors.workflows}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,status:true,sourceRevisionId:true,resultRevisionId:true,leaseOwner:true,leaseExpiresAt:true,failureClass:true,finishedAt:true}});
 const inference=await db.documentInferenceOperation.findMany({where:{OR:[{status:{in:['pending','running','unknown']}},{status:{in:['failed','cancelled']},startedAt:{not:null},result:{equals:Prisma.DbNull}}],...(domainCursors.inference?{id:{gt:domainCursors.inference}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,status:true,sourceBookRevision:true,sourceContentHash:true,startedAt:true,errorCode:true}});
 const operators=await db.documentOperatorEffect.findMany({where:{OR:[{status:{in:['pending','running','unknown']}},{status:{in:['failed','cancelled']},startedAt:{not:null},result:{equals:Prisma.DbNull}}],...(domainCursors.operators?{id:{gt:domainCursors.operators}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,status:true,sourceBookRevision:true,sourceContentHash:true,startedAt:true,errorCode:true}});
 const publications=await db.documentPublication.findMany({where:{status:{in:['pending','running','unknown']},...(domainCursors.publications?{id:{gt:domainCursors.publications}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,status:true,revisionId:true,errorCode:true}});
 const workflowEffects=await db.documentWorkflowEffect.findMany({where:{OR:[{status:{in:['pending','running','unknown']}},{status:{in:['failed','cancelled']},startedAt:{not:null},result:{equals:Prisma.DbNull}}],...(domainCursors.workflowEffects?{id:{gt:domainCursors.workflowEffects}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,runId:true,status:true,sourceBookRevision:true,sourceContentHash:true,leaseOwner:true,startedAt:true,errorCode:true}});
 const proposals=await db.documentProposal.findMany({where:{OR:[{status:{in:['pending','running','unknown']}},{status:{in:['failed','cancelled']},startedAt:{not:null},result:{equals:Prisma.DbNull}}],...(domainCursors.proposals?{id:{gt:domainCursors.proposals}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,discussionId:true,status:true,requestHash:true,applicationOperationId:true,startedAt:true,errorCode:true}});
 const analyses=await db.documentTraceAnalysis.findMany({where:{OR:[{status:{in:['pending','running','unknown']}},{status:{in:['failed','cancelled']},startedAt:{not:null},result:{equals:Prisma.DbNull}}],...(domainCursors.analyses?{id:{gt:domainCursors.analyses}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,status:true,sourceBookRevision:true,sourceSceneRevision:true,sourceContentHash:true,startedAt:true,errorCode:true}});
 const sharedResources=await db.sharedResourceOperation.findMany({where:{state:{in:['admitted','running','unknown']},...(domainCursors.sharedResources?{operationId:{gt:domainCursors.sharedResources}}:{})},orderBy:{operationId:'asc'},take:101,select:{operationId:true,state:true,claimSha256:true,requestSha256:true,executionKind:true,executionId:true,leaseId:true,startedAt:true}});
 const storyProposals=await db.documentStoryProposal.findMany({where:{OR:[{status:{in:['pending','running','unknown']}},{status:{in:['failed','cancelled']},startedAt:{not:null},result:{equals:Prisma.DbNull}}],...(domainCursors.storyProposals?{id:{gt:domainCursors.storyProposals}}:{})},orderBy:{id:'asc'},take:101,select:{id:true,bookId:true,storyId:true,discussionId:true,status:true,requestHash:true,applicationOperationId:true,startedAt:true,errorCode:true}});
 const allDomains={workflows,inference,operators,publications,workflowEffects,proposals,analyses,sharedResources,storyProposals};
 return {schemaVersion:1,observedAt,fence,admissions:page,bindings:bindings.slice(0,1000),nextBindingCursor:bindings.length>1000?bindings[999].id:null,nextCursor:rows.length>limit?page.at(-1)!.id:null,domains:Object.fromEntries(Object.entries(allDomains).map(([name,rows])=>[name,rows.slice(0,100)])),domainCursors:Object.fromEntries(Object.entries(allDomains).map(([name,rows])=>[name,rows.length>100?('id' in rows[99]?rows[99].id:rows[99].operationId):null])),domainInventoryTruncated:Object.values(allDomains).some(rows=>rows.length>100),providerEvidence:'Admission records authorize dispatch; recover exact domain journals for outcomes. Unknown or unbound admissions cannot be inferred complete.'};
}
