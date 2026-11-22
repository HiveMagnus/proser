import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { createDocumentDiscussion } from '@/documents/proposals';
import { SceneProseService } from '@/services/sceneProseService';
describe('owned disclosed inline and feedback preview consumers',()=>{
 let userId:number;let bookId:number;let sceneId:number;let githubId:string;const db=()=>databaseService.client;const old=process.env.DOCUMENT_AUTHORITY_ENABLED;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';githubId=`ancillary-${randomUUID()}`;userId=(await db().user.create({data:{githubId,username:'Preview fixture'}})).id;});
 beforeEach(async()=>{const b=await db().book.create({data:{userId,title:'Disposable preview',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:{sceneNumber:1,prose:'Exact selected passage.'}}}}}}},include:{acts:{include:{chapters:{include:{scenes:true}}}}}});bookId=b.id;sceneId=b.acts[0].chapters[0].scenes[0].id;await documentService.initialize(userId,bookId);});
 afterEach(async()=>{jest.restoreAllMocks();await db().documentProposalValidation.deleteMany({where:{bookId}});await db().documentProposal.deleteMany({where:{bookId}});await db().documentDiscussion.deleteMany({where:{bookId}});await db().documentLegacyRevisionMapping.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{if(old===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=old;await db().user.delete({where:{id:userId}});});
 const auth=(r:request.Test)=>r.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Preview fixture');
 test.each([['inline-suggestion','context'],['feedback','content']] as const)('%s preserves owned source, rejects arbitrary/foreign context and recovers one typed result',async(route,field)=>{
  const infer=jest.spyOn(SceneProseService.prototype,'proposeDocumentEdits').mockImplementation(async(snapshot)=>({raw:JSON.stringify({reply:'An exact suggestion.',edits:[{targetId:snapshot.targets[0].targetId,sourceText:snapshot.targets[0].sourceText,replacement:'Exact proposed passage.'}]}),provenance:{providerId:'fixture',params:{},recipe:'document-proposal',recipeVersion:'fixture-v1'}}));
  const path=`/api/generate/${route}`;const raw=await auth(request(app).post(path)).send({bookId,sceneId,[field]:'Arbitrary content.'});expect(raw.status).toBe(428);expect(infer).not.toHaveBeenCalled();
  const source=await documentService.read(userId,bookId,sceneId);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');const text=source.projection.text;
  const discussion=await createDocumentDiscussion(userId,bookId,{schemaVersion:1,operationId:randomUUID(),sessionId:randomUUID(),sceneId,expectedRevisionId:source.bookRevisionId,expectedSceneRevisionId:source.revisionId,expectedContentHash:source.contentHash,projection:'final',targets:[{blockId:paragraph.id,from:0,to:text.length,sourceText:text}]});
  const body={bookId,sceneId,documentPreview:{discussionId:discussion.id,operationId:randomUUID()}};
  expect((await auth(request(app).post(path)).send({...body,[field]:'A wrong quotation.'})).status).toBe(409);expect((await auth(request(app).post(path)).send({...body,sceneId:sceneId+100000})).status).toBe(409);expect(infer).not.toHaveBeenCalled();
  const result=await auth(request(app).post(path)).send(body);expect(result.status).toBe(200);expect(result.body.data).toMatchObject({schemaVersion:1,projection:'final',proposalId:body.documentPreview.operationId,source:{sceneRevisionId:source.revisionId},proposal:{status:'ready'}});
  expect((await auth(request(app).post(path)).send(body)).status).toBe(200);expect(infer).toHaveBeenCalledTimes(1);expect((await documentService.read(userId,bookId,sceneId)).contentHash).toBe(source.contentHash);
 });
});
