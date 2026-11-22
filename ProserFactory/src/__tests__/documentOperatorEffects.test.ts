import { randomUUID } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { runOperatorEffect,readOperatorEffect,cancelOperatorEffect } from '@/documents/operatorEffects';
import { reviseOwnedOperatorScene } from '@/documents/operatorCommands';
import { SceneProseService } from '@/services/sceneProseService';
import { InferenceTerminalError } from '@/lib/ai/terminalReason';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>((done)=>{resolve=done;});return {promise,resolve};};
describe('retained revision-bound CLI operator provider effects',()=>{
 const db=()=>databaseService.client;let userId:number;let bookId:number;let sceneId:number;const previousAuthority=process.env.DOCUMENT_AUTHORITY_ENABLED;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';userId=(await db().user.create({data:{githubId:`operator-${randomUUID()}`,username:'Operator fixture'}})).id;});
 beforeEach(async()=>{const book=await db().book.create({data:{userId,title:'Operator fixture',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:{sceneNumber:1,prose:'A preserved phrase.'}}}}}}},include:{acts:{include:{chapters:{include:{scenes:true}}}}}});bookId=book.id;sceneId=book.acts[0].chapters[0].scenes[0].id;await documentService.initialize(userId,bookId);});
 afterEach(async()=>{await db().documentOperatorEffect.deleteMany({where:{bookId}});await db().documentLegacyRevisionMapping.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});jest.restoreAllMocks();});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});if(previousAuthority===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=previousAuthority;});
 const descriptor=()=>({id:randomUUID(),userId,bookId,kind:'cli-outline' as const,intent:{acts:3}});
 test('completed output and original frozen source are recovered exactly once after later formatting edits',async()=>{
  const effect=descriptor();const prepare=jest.fn(async()=>({prompt:'complete original concept',model:'fixture'}));const invoke=jest.fn(async()=>({raw:'known output',model:'reported-model'}));
  const first=await runOperatorEffect(effect,prepare,invoke);
  const source=await documentService.read(userId,bookId,sceneId);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.size=24;await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:source.document}]});
  expect(await runOperatorEffect(effect,prepare,invoke)).toEqual(first);expect(prepare).toHaveBeenCalledTimes(1);expect(invoke).toHaveBeenCalledTimes(1);
  await expect(runOperatorEffect({...effect,intent:{acts:4}},prepare,invoke)).rejects.toMatchObject({code:'DOCUMENT_OPERATION_CONFLICT'});
  await expect(readOperatorEffect(userId+999999,bookId,effect.id)).rejects.toThrow('Book not found');
 });
 test('unknown acknowledgement is never automatically replayed',async()=>{
  const effect=descriptor();const invoke=jest.fn(async()=>{throw new Error('lost acknowledgement');});
  await expect(runOperatorEffect(effect,async()=>({prompt:'complete context'}),invoke)).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_EFFECT_UNKNOWN'});
  await expect(runOperatorEffect(effect,async()=>({prompt:'rebased context'}),invoke)).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_EFFECT_UNKNOWN'});expect(invoke).toHaveBeenCalledTimes(1);
  expect((await readOperatorEffect(userId,bookId,effect.id)).request).toEqual({prompt:'complete context'});
  await expect(runOperatorEffect({...effect,id:randomUUID()},async()=>({prompt:'new ID cannot repeat unknown intent'}),invoke)).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_UNRESOLVED_EFFECT',details:{operationId:effect.id,status:'unknown'}});expect(invoke).toHaveBeenCalledTimes(1);
 });
 test('owner cancellation retains a late known response and suppresses application',async()=>{
  const effect=descriptor();const started=deferred<void>();const response=deferred<{raw:string}>();const running=runOperatorEffect(effect,async()=>({prompt:'context'}),async()=>{started.resolve();return response.promise;});
  await started.promise;expect(await cancelOperatorEffect(userId,bookId,effect.id)).toMatchObject({status:'cancelled'});response.resolve({raw:'late known bytes'});
  await expect(running).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_EFFECT_CANCELLED'});
  const row=await readOperatorEffect(userId,bookId,effect.id);expect(row.status).toBe('cancelled');expect(row.result).toMatchObject({providerOutcome:'completed',data:{raw:'late known bytes'}});
 });
 test('deadline stops waiting even when provider ignores abort; later acknowledgement is recoverable',async()=>{
  const effect={...descriptor(),timeoutMs:1000};const started=deferred<void>();const response=deferred<{raw:string}>();const provider=jest.fn(async()=>{started.resolve();return response.promise;});
  const running=runOperatorEffect(effect,async()=>({prompt:'frozen'}),provider);await started.promise;
  await expect(running).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_EFFECT_UNKNOWN'});expect((await readOperatorEffect(userId,bookId,effect.id)).status).toBe('unknown');
  response.resolve({raw:'late confirmed bytes'});
  for(let attempts=0;attempts<100;attempts++){if((await readOperatorEffect(userId,bookId,effect.id)).status==='completed')break;await new Promise((done)=>setTimeout(done,10));}
  expect((await runOperatorEffect(effect,async()=>({prompt:'must not replace source'}),provider)).result).toEqual({raw:'late confirmed bytes'});expect(provider).toHaveBeenCalledTimes(1);
 });
 test('known terminal failures preserve exact partial bytes and cannot be replayed',async()=>{
  const effect=descriptor();const provider=jest.fn(async()=>{throw new InferenceTerminalError('INFERENCE_TRUNCATED','length','structured','  partial 😀\n');});
  await expect(runOperatorEffect(effect,async()=>({prompt:'context'}),provider)).rejects.toMatchObject({code:'INFERENCE_TRUNCATED'});
  const row=await readOperatorEffect(userId,bookId,effect.id);expect(row.status).toBe('failed');expect(row.result).toMatchObject({providerOutcome:'terminal',data:{partialOutput:'  partial 😀\n'}});
  await expect(runOperatorEffect(effect,async()=>({prompt:'context'}),provider)).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_EFFECT_FAILED'});expect(provider).toHaveBeenCalledTimes(1);
 });
 test('explicit instruction without findings becomes a tracked formatting-preserving revision and its exact retry uses no inference',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style={bold:true,font:'Georgia',size:18};
  await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:source.document}]});
  const review=jest.spyOn(SceneProseService.prototype,'reviewProse').mockResolvedValue({revised:'A preserved sentence.'});const input={bookId,sceneId,operationId:randomUUID(),instruction:'Change phrase to sentence.'};
  const first=await reviseOwnedOperatorScene(userId,input);expect(await reviseOwnedOperatorScene(userId,input)).toEqual(first);expect(review).toHaveBeenCalledTimes(1);
  const saved=await documentService.read(userId,bookId,sceneId);expect(saved.projection.text).toBe('A preserved sentence.');expect(saved.document.changes.every((change)=>change.status==='pending'&&change.authorId===userId&&change.origin==='ai')).toBe(true);
  const current=saved.document.blocks[0];if(current.type!=='paragraph')throw new Error('fixture');expect(current.runs.every((run)=>run.style.bold&&run.style.font==='Georgia'&&run.style.size===18)).toBe(true);
 });
 test('a formatting-only race during inference retains response and prevents stale application',async()=>{
  jest.spyOn(SceneProseService.prototype,'reviewProse').mockImplementation(async()=>{const source=await documentService.read(userId,bookId,sceneId);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.size=24;await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:source.document}]});return {revised:'Stale replacement.'};});
  const input={bookId,sceneId,operationId:randomUUID(),instruction:'Make a revision.'};await expect(reviseOwnedOperatorScene(userId,input)).rejects.toMatchObject({status:412});
  expect((await readOperatorEffect(userId,bookId,input.operationId)).status).toBe('completed');const current=await documentService.read(userId,bookId,sceneId);expect(current.projection.text).toBe('A preserved phrase.');expect(current.document.blocks[0]).toMatchObject({runs:[{style:{size:24}}]});
 });
});
