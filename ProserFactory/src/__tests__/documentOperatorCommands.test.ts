jest.mock('@/cli/utils/output',()=>({output:{json:jest.fn(),data:jest.fn(),failSpinner:jest.fn(),error:jest.fn()}}));
import { randomUUID } from 'node:crypto';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { outlineCommand } from '@/cli/commands/outline';
import { charactersCommand } from '@/cli/commands/characters';
import { output } from '@/cli/utils/output';
import * as cliDatabase from '@/cli/utils/database';
import { VllmService } from '@/lib/ai/vllm';
import { booksService } from '@/services/booksService';
import request from 'supertest';
import app from '@/index';
import { runOperatorEffect } from '@/documents/operatorEffects';

describe('native CLI structure/canon effect recovery and owned inspector',()=>{
 const db=()=>databaseService.client;let userId:number;let githubId:string;let bookId:number;let sceneId:number;const previousAuthority=process.env.DOCUMENT_AUTHORITY_ENABLED;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';githubId=`operator-commands-${randomUUID()}`;userId=(await db().user.create({data:{githubId,username:'Operator CLI fixture'}})).id;});
 beforeEach(async()=>{jest.spyOn(cliDatabase,'closeDatabase').mockResolvedValue(undefined);const book=await db().book.create({data:{userId,title:null,acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:{sceneNumber:1,prose:'Styled original.'}}}}}}},include:{acts:{include:{chapters:{include:{scenes:true}}}}}});bookId=book.id;sceneId=book.acts[0].chapters[0].scenes[0].id;await documentService.initialize(userId,bookId);const source=await documentService.read(userId,bookId,sceneId);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.bold=true;await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:source.document}]});});
 afterEach(async()=>{await db().documentOperatorEffect.deleteMany({where:{bookId}});await db().documentLegacyRevisionMapping.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});jest.restoreAllMocks();});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});if(previousAuthority===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=previousAuthority;});
 const auth=(call:request.Test)=>call.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Operator CLI fixture');
 test('outline exact retry after newer book metadata recovers its original receipt and preserves existing styled IDs',async()=>{
  const invoke=jest.spyOn(VllmService.prototype,'generateText').mockResolvedValue(JSON.stringify({acts:[{title:'Generated act',chapters:[{title:'Generated chapter',scenes:[{outline:'Generated outline'}]}]}]}));
  const handler=outlineCommand.handler;if(typeof handler!=='function')throw new Error('handler');const operationId=randomUUID();const argv={_:['outline'],$0:'proser',bookId,acts:1,'chapters-per-act':1,chaptersPerAct:1,'scenes-per-chapter':1,scenesPerChapter:1,'user-id':userId,'operation-id':operationId,json:true};
  const source=await documentService.read(userId,bookId,sceneId);await handler(argv);expect(output.json).toHaveBeenLastCalledWith(expect.objectContaining({success:true,operationId}));
  const head=await documentService.manifest(userId,bookId);await booksService.updateBook(userId,bookId,{title:'Later title'},{operationId:randomUUID(),expectedRevisionId:head.revisionId,expectedScopes:{structure:head.scopes!.structure.revisionId}});
  await handler(argv);expect(output.json).toHaveBeenLastCalledWith(expect.objectContaining({success:true,operationId}));expect(invoke).toHaveBeenCalledTimes(1);expect(await db().act.count({where:{bookId}})).toBe(2);expect((await documentService.read(userId,bookId,sceneId)).document).toEqual(source.document);
 });
 test('characters recover generated fallback descriptions from the frozen original title after later metadata edits',async()=>{
  const invoke=jest.spyOn(VllmService.prototype,'generateText').mockResolvedValue(JSON.stringify({characters:[{name:'Mira',role:'protagonist'}]}));const handler=charactersCommand.handler;if(typeof handler!=='function')throw new Error('handler');const operationId=randomUUID();const argv={_:['characters'],$0:'proser',bookId,'user-id':userId,'operation-id':operationId,json:true};
  await handler(argv);const entry=await db().codexEntry.findFirstOrThrow({where:{bookId}});expect(entry.entryDescription).toContain('Untitled');const head=await documentService.manifest(userId,bookId);await booksService.updateBook(userId,bookId,{title:'Later title'},{operationId:randomUUID(),expectedRevisionId:head.revisionId,expectedScopes:{structure:head.scopes!.structure.revisionId}});await handler(argv);
  expect(output.json).toHaveBeenLastCalledWith(expect.objectContaining({success:true,operationId}));expect(invoke).toHaveBeenCalledTimes(1);expect(await db().codexEntry.count({where:{bookId}})).toBe(1);expect((await db().codexEntry.findUniqueOrThrow({where:{id:entry.id}})).entryDescription).toBe(entry.entryDescription);
 });
 test('operator inspector is paged, private and cancellation leaves the original effect unreplayed',async()=>{
  const operationId=randomUUID();await runOperatorEffect({id:operationId,userId,bookId,kind:'cli-outline',intent:{fixture:true}},async()=>({prompt:'x'.repeat(5000)}),async()=>({raw:'known output'}));
  const status=await auth(request(app).get(`/api/books/${bookId}/document-operator-effects/${operationId}`));expect(status.status).toBe(200);expect(status.headers['cache-control']).toBe('private, no-store');expect(status.body.data.request).toBeUndefined();expect(status.body.data.result).toBeUndefined();
  const page=await auth(request(app).get(`/api/books/${bookId}/document-operator-effects/${operationId}?view=request&limit=1024`));expect(page.status).toBe(200);expect(page.body.data.content).toHaveLength(1024);expect(page.body.data.nextOffset).toBe(1024);
  const listed=await auth(request(app).get(`/api/books/${bookId}/document-operator-effects?limit=1`));expect(listed.body.data.operations[0].id).toBe(operationId);
  const cancelled=await auth(request(app).post(`/api/books/${bookId}/document-operator-effects/${operationId}/cancel`)).send({});expect(cancelled.body.data.status).toBe('cancelled');
  await expect(runOperatorEffect({id:operationId,userId,bookId,kind:'cli-outline',intent:{fixture:true}},async()=>({prompt:'must not replace'}),async()=>({raw:'must not resend'}))).rejects.toMatchObject({code:'DOCUMENT_OPERATOR_EFFECT_CANCELLED'});
 });
});
