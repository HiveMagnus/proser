import type { SkillFinding } from '@/lib/skills/types';
import { Prisma } from '@prisma/client';
import { SceneProseService } from '@/services/sceneProseService';
import { defaultModelRouter } from '@/lib/ai/router';
import { VllmService } from '@/lib/ai/vllm';
import { withRetry } from '@/lib/resilience';
import { TERMINAL_REASON_POLICIES } from '@/lib/ai/terminalReason';
import { readScope } from './scopes';
import { validateDocument } from './validation';
import { projectDocument } from './model';
import { runOperatorEffect, assertOperatorApplication } from './operatorEffects';
import { documentService } from './service';
import { DocumentError } from './errors';
import type { DocumentMutationPreconditions } from './scope-model';

export async function reviseOwnedOperatorScene(userId:number,input:{bookId:number;sceneId:number;operationId:string;instruction?:string}){
 const retained=await runOperatorEffect({id:input.operationId,userId,bookId:input.bookId,sceneId:input.sceneId,kind:'cli-revise',intent:{instruction:input.instruction??null}},async(tx,manifest)=>{
  const reference=manifest.scenes.find((scene)=>scene.sceneId===input.sceneId&&!scene.deletedAt);if(!reference)throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND','Owned scene not found.',404);
  const body=await tx.sceneDocumentRevision.findFirstOrThrow({where:{id:reference.revisionId,bookId:input.bookId,sceneId:input.sceneId}});
  const source=validateDocument(body.document);const original=projectDocument(source).text;
  const skill=await tx.skillRun.findFirst({where:{bookId:input.bookId,sceneId:input.sceneId,findings:{not:Prisma.DbNull}},orderBy:[{createdAt:'desc'},{id:'desc'}]});
  let findings=(skill?.findings??[]) as unknown as SkillFinding[];
  if(!Array.isArray(findings))throw new DocumentError('DOCUMENT_OPERATOR_FINDINGS_INVALID','Saved findings need explicit review.',409);
  const unbound = findings.some((finding) => { const proof=finding.metadata?.proserDocumentSource as { sceneRevisionId?: string; contentHash?: string }|undefined; return proof?.sceneRevisionId!==reference.revisionId||proof.contentHash!==body.contentHash; });
  if(unbound&&!input.instruction)throw new DocumentError('DOCUMENT_FINDINGS_SOURCE_STALE','Saved findings have no exact current document proof. Rerun revision-bound review or give an explicit instruction.',409);
  if(unbound)findings=[];
  const provider=defaultModelRouter.forRequest('generic');
  return {providerId:provider.id,model:provider.getModel?.(),bookRevisionId:manifest.revisionId,sceneRevisionId:reference.revisionId,sourceContentHash:body.contentHash,original,instruction:input.instruction??'Revise based on quality findings',findings,skillRunId:unbound?null:skill?.id??null,omittedStaleSkillRunId:unbound?skill?.id??null:null};
 },async(request,signal)=>{
  const prose=new SceneProseService();
  if(!request.findings.length&&input.instruction)return prose.reviewProse(request.original,{instruction:request.instruction},{signal,selectedModel:request.model,noTransportReplay:true,retries:1});
  return prose.reviseFromFindings(request.original,request.findings,{instruction:request.instruction},{signal,selectedModel:request.model,noTransportReplay:true,retries:1});
 });
 const receipt=await documentService.mutateCatalog(userId,input.bookId,{operationId:input.operationId,expectedRevisionId:retained.sourceBookRevision,expectedScopes:{},payload:{command:'cli-revise-retained',sceneId:input.sceneId,sourceSceneRevision:retained.request.sceneRevisionId,revised:retained.result.revised}},async(tx)=>{
  await assertOperatorApplication(tx,userId,input.bookId,input.operationId,retained.sourceBookRevision,retained.result);
  const document=await documentService.replacementDocument(tx,input.bookId,input.sceneId,retained.request.sceneRevisionId,retained.result.revised,userId,'ai');
  return {result:{sceneId:input.sceneId},changedDocuments:[{sceneId:input.sceneId,expectedRevisionId:retained.request.sceneRevisionId,document}]};
 },'ai');
 return {sceneId:input.sceneId,operationId:input.operationId,documentRevision:{operationId:input.operationId,bookRevisionId:receipt.revisionId,contentHash:receipt.contentHash,scopes:receipt.manifest.scopes}};
}
export async function generateOwnedOperatorBookText(userId:number,input:{bookId:number;operationId:string;kind:'cli-outline'|'cli-characters';intent:unknown;expectedRevisionId:string;makePrompt:(book:{title:string|null;summary:string|null;genre:string|null})=>string}){
 const retained=await runOperatorEffect({id:input.operationId,userId,bookId:input.bookId,kind:input.kind,intent:input.intent,expectedBookRevision:input.expectedRevisionId},async(tx,manifest)=>{
  if(!manifest.scopes)throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED','Canonical scopes are required before generation.',409);
  const structure=await readScope(tx,input.bookId,'structure',manifest.scopes.structure);
  const ai=new VllmService();
  return {bookMetadata:{title:structure.book.title,summary:structure.book.summary,genre:structure.book.genre},prompt:input.makePrompt(structure.book),model:ai.getModel(),sourceBookRevision:manifest.revisionId,scopeReferences:manifest.scopes,options:{temperature:0.7,maxTokens:8192},disclosure:{included:['complete saved book title','complete saved concept/summary','complete saved genre'],omitted:['scene prose','canon entries'],sourceContentHash:manifest.contentHash}};
 },async(request,signal)=>{
  const ai=new VllmService(request.model,{noTransportReplay:true});
  const raw=await withRetry((timeoutSignal)=>ai.generateText({prompt:request.prompt,params:request.options,signal:AbortSignal.any([signal,timeoutSignal]),terminalPolicy:TERMINAL_REASON_POLICIES.structured}),1,undefined,{timeoutMs:120000});
  const metadata=ai.getLastInferenceMetadata();
  return {raw,provenance:{providerId:ai.id,configuredModel:request.model,reportedModel:metadata?.reportedModel,usage:metadata?.usage,params:request.options}};
 });
 const expected:DocumentMutationPreconditions={operationId:input.operationId,expectedRevisionId:retained.sourceBookRevision,expectedScopes:{[input.kind==='cli-outline'?'structure':'canon']:retained.request.scopeReferences[input.kind==='cli-outline'?'structure':'canon'].revisionId}};
 return {...retained,expected};
}
