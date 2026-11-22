import { canonicalDocument, paragraphsOf, minimalTextEdit, projectDocument, replaceDocumentText, type ProserDocument } from '@/documents/model';
import { frozenTarget, verifyTargets, protectedObjects } from '@/documents/targets';
import { SceneProseService } from '@/services/sceneProseService';
import type { DocumentProposalProviderResult, DocumentDiscussionSnapshot } from '@/documents/proposal-model';
import { documentProposalOutputSchema } from '@/documents/proposalValidation';
import { documentCorpusHash, loadDocumentCorpus, loadDocumentExpected, type DocumentCorpusCase } from './documentCorpus';

function boundedProvider<T>(signal:AbortSignal,effect:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('Document benchmark cancelled'));signal.addEventListener('abort',abort,{once:true});
    void effect().then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
function applyCase(item:DocumentCorpusCase,replacement:string):ProserDocument {
  const source=item.input.document;const current=structuredClone(item.input.currentDocument??source);
  const target=frozenTarget(source,item.input.target,'00000000-0000-4000-8000-000000000001');verifyTargets(current,[target]);
  if(!target.editable)throw new Error(target.sourceText.includes('\uFFFC')?'Protected image prevents editing this target':'Pending review prevents editing this target');
  if(replacement.includes('\n\n'))throw new Error('Unsupported paragraph operation');
  const first=projectDocument(current).spans.find((span)=>span.blockId===target.blockId&&span.editable);if(!first)throw new Error('Missing editable target');
  const diff=minimalTextEdit(target.sourceText,replacement);let sequence=0;
  return replaceDocumentText(current,first.start+target.from+diff.start,first.start+target.from+diff.end,target.sourceText.slice(diff.start,diff.end),diff.replacement,()=>`fixture-edit-${sequence++}`,{authorId:0,authorName:'Quality Lab fixture',createdAt:'2026-10-05T00:00:00.000Z',origin:'ai',status:'pending'},{blockId:target.blockId});
}
function preserved(source:ProserDocument,result:ProserDocument,targetBlockId:string){
  const unaffected=(doc:ProserDocument)=>paragraphsOf(doc,true).filter((paragraph)=>paragraph.id!==targetBlockId);
  const targetBefore=paragraphsOf(source).find((paragraph)=>paragraph.id===targetBlockId);const targetAfter=paragraphsOf(result).find((paragraph)=>paragraph.id===targetBlockId);
  return canonicalDocument(unaffected(source))===canonicalDocument(unaffected(result))&&canonicalDocument(protectedObjects(source))===canonicalDocument(protectedObjects(result))
    &&canonicalDocument(source.layout)===canonicalDocument(result.layout)&&canonicalDocument(source.comments)===canonicalDocument(result.comments)
    &&canonicalDocument(targetBefore?.style)===canonicalDocument(targetAfter?.style)
    &&(targetAfter?.runs.every((run)=>targetBefore?.runs.some((prior)=>canonicalDocument(prior.style)===canonicalDocument(run.style)))??false);
}
export async function runDocumentBenchmark(options:{maximumLiveCases?:number;signal?:AbortSignal;provider?:Pick<SceneProseService,'proposeDocumentEdits'>}={}){
  const loaded=await loadDocumentCorpus();const rows=[];let liveCalls=0;const maximumLiveCases=Math.min(2,Math.max(0,options.maximumLiveCases??0));
  for(const item of loaded.cases){
    options.signal?.throwIfAborted();const started=performance.now();let outcome:'applied'|'rejected'='rejected';let error='';let candidate=item.input.replacement;let providerFailure:string|undefined;let providerAttempted=false;let responseHash:string|undefined;let providerResponse:string|undefined;let responseBytes:number|undefined;let provenance:DocumentProposalProviderResult['provenance']|undefined;let result=structuredClone(item.input.currentDocument??item.input.document);
    // Reject stale/protected/ambiguous fixtures before sending any provider request.
    try {
      applyCase(item,candidate);
      if(options.provider&&liveCalls<maximumLiveCases){
        liveCalls++;providerAttempted=true;const target=frozenTarget(item.input.document,item.input.target,'00000000-0000-4000-8000-000000000001');
        const snapshot:DocumentDiscussionSnapshot={schemaVersion:1,sceneId:1,sessionId:'fixture-session',projection:'final',sourceBookRevisionId:'fixture-book',sourceSceneRevisionId:'fixture-scene',sourceContentHash:documentCorpusHash(item.input.document),bookLayoutHash:documentCorpusHash(item.input.document.layout),localDraftDigest:documentCorpusHash(item.input.document),unsaved:false,targets:[target],blocks:paragraphsOf(item.input.document).filter((paragraph)=>paragraph.id===target.blockId),codex:[],omitted:{blockIds:paragraphsOf(item.input.document).filter((paragraph)=>paragraph.id!==target.blockId).map((paragraph)=>paragraph.id),codexIds:[]},maxPromptBytes:16000,maxOutputTokens:2048,templateVersion:'1.0.0',conversation:[],omittedProposalIds:[],omittedEarlierTurnCount:0};
        const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
        try {const response=await boundedProvider(signal,()=>options.provider!.proposeDocumentEdits(snapshot,item.input.instruction,{signal,retries:1,noTransportReplay:true,timeoutMs:45000}));provenance=response.provenance;responseHash=documentCorpusHash(response.raw);responseBytes=Buffer.byteLength(response.raw);if(responseBytes>65536)throw new Error('Bounded provider response exceeds 64 KiB; digest retained');providerResponse=response.raw;const output=documentProposalOutputSchema.parse(JSON.parse(response.raw));if(output.edits.length!==1||output.edits[0].targetId!==target.targetId||output.edits[0].sourceText!==target.sourceText)throw new Error('Provider returned an invalid exact target');candidate=output.edits[0].replacement;}
        catch(failure){providerFailure=failure instanceof Error?failure.message:String(failure);throw new Error('Live provider failed or returned an invalid target');}
      }
      result=applyCase(item,candidate);outcome='applied';
    }catch(failure){error=failure instanceof Error?failure.message:String(failure);}
    // Hidden outcomes are loaded only after output and target verification are sealed.
    const expected=await loadDocumentExpected(item.id);const base=item.input.currentDocument??item.input.document;
    const preservation=outcome==='rejected'?canonicalDocument(result)===canonicalDocument(base):preserved(base,result,item.input.target.blockId);
    const finalText=projectDocument(result).text;const matched=outcome===expected.outcome&&(!expected.errorIncludes||error.includes(expected.errorIncludes))&&(!expected.finalText||provenance!==undefined||finalText===expected.finalText);
    rows.push({id:item.id,caseVersion:item.caseVersion,tags:item.tags,inputHash:item.inputHash,expectedHash:item.expectedHash,outcome,matched,preservation,error:error||undefined,sourceHash:documentCorpusHash(base),resultHash:documentCorpusHash(result),outputHash:documentCorpusHash(candidate),replacement:candidate,resultDocument:result,responseHash,responseBytes,providerResponse,providerFailure,providerOutcome:providerAttempted?(responseHash?'acknowledged':providerFailure?'unknown':'pending'):'not-started',provenance:provenance??{providerId:providerAttempted?'unacknowledged-provider':'deterministic-fixture',params:{},recipe:'document-editing-v1',recipeVersion:'1.0.0'},latencyMs:Math.round(performance.now()-started),inferenceTokens:provenance?.usage?.totalTokens??0});
  }
  return {suiteKey:loaded.manifest.suiteKey,suiteVersion:loaded.manifest.suiteVersion,caseCount:rows.length,liveCalls,maximumLiveCases,deterministic:liveCalls===0,passed:rows.every((row)=>row.matched&&row.preservation&&!row.providerFailure),rows};
}
