import {randomUUID} from 'node:crypto';
import {databaseService} from '@/lib/database';
import {documentService} from '@/documents/service';
import {readDocumentPassage} from '@/documents/passage';
import {commitPassageOperationScopes} from '@/documents/passageOperationCommits';
import {projectDocument} from '@/documents/model';
import type {DocumentPassageBookCommit,DocumentPassageScopeCommit} from '@/documents/passage-operations-model';
describe('bounded compound passage mutation atomicity',()=>{
 const db=()=>databaseService.client;let userId:number,bookId:number,sceneIds:number[];
 beforeAll(async()=>{userId=(await db().user.create({data:{githubId:`compound-${randomUUID()}`,username:'Compound owner'}})).id;});
 beforeEach(async()=>{
  const book=await db().book.create({
   data:{userId,title:'Compound fixture',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:[{sceneNumber:1,prose:'First exact.'},{sceneNumber:2,prose:'Second exact.'},{sceneNumber:3,prose:'Unchanged third.'}]}}}}}},
   include:{acts:{include:{chapters:{include:{scenes:{orderBy:{sceneNumber:'asc'}}}}}}},
  });
  bookId=book.id;sceneIds=book.acts[0]!.chapters[0]!.scenes.map(scene=>scene.id);await documentService.initialize(userId,bookId);
 });
 afterEach(async()=>{await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});});
 async function input():Promise<DocumentPassageBookCommit>{
  const scopes:DocumentPassageScopeCommit[]=[];
  for(const sceneId of sceneIds.slice(0,2)){
   const window=await readDocumentPassage(userId,bookId,sceneId,{maxCharacters:128});const paragraph=window.paragraphs[0]!,run=paragraph.runs[0]!;
   scopes.push({sceneId,expectedSceneRevisionId:window.sceneRevisionId,sourceFrame:window.sourceFrame!,windowHash:window.windowHash,cursor:window.cursor,maxCharacters:128,tracking:true,operations:[{id:randomUUID(),kind:'text',target:{blockId:paragraph.paragraph.id,paragraphHash:paragraph.paragraphHash!,containerHash:paragraph.containerHash!,runId:run.runId,sourceHash:run.sourceHash,from:0,to:0},expectedText:'',replacement:'Tracked paste. '}]});
  }
  return {schemaVersion:1,operationId:randomUUID(),expectedRevisionId:scopes[0]!.sourceFrame.bookRevisionId,scenes:scopes};
 }
 test('both scopes commit once with sparse exact receipts and tracked original projection',async()=>{
  const request=await input(),third=await documentService.read(userId,bookId,sceneIds[2]!);
  const receipt=await commitPassageOperationScopes(userId,bookId,request);
  expect(receipt.sceneReferences).toHaveLength(2);expect(Object.hasOwn(receipt,'scenes')).toBe(false);expect(receipt.result.passages).toHaveLength(2);
  expect(JSON.stringify(receipt).length).toBeLessThan(24000);
  for(const sceneId of sceneIds.slice(0,2)){const saved=await documentService.read(userId,bookId,sceneId);expect(projectDocument(saved.document).text.startsWith('Tracked paste. ')).toBe(true);expect(projectDocument(saved.document,'original').text).not.toContain('Tracked paste.');expect(saved.document.changes[0]!.authorId).toBe(userId);}
  expect((await documentService.read(userId,bookId,sceneIds[2]!)).revisionId).toBe(third.revisionId);
  expect(await commitPassageOperationScopes(userId,bookId,request)).toEqual(receipt);
  await expect(commitPassageOperationScopes(userId,bookId,{...request,operationId:randomUUID()})).rejects.toMatchObject({status:412});
 });
 test('invalid later scope rolls back the complete transaction and records no changed head',async()=>{
  const request=await input(),head=await documentService.manifest(userId,bookId),count=await db().sceneDocumentRevision.count({where:{bookId}});
  request.scenes[1]!.sourceFrame.effectiveStyleLayoutHash='f'.repeat(64);
  await expect(commitPassageOperationScopes(userId,bookId,request)).rejects.toMatchObject({status:412});
  expect((await documentService.manifest(userId,bookId)).revisionId).toBe(head.revisionId);expect(await db().sceneDocumentRevision.count({where:{bookId}})).toBe(count);
  expect(await db().documentOperation.findFirst({where:{bookId,id:request.operationId}})).toBeNull();
 });
 test('duplicate scopes and foreign ownership cannot dispatch compound edits',async()=>{
  const request=await input();request.scenes.push(request.scenes[0]!);
  await expect(commitPassageOperationScopes(userId,bookId,request)).rejects.toMatchObject({status:409});request.scenes.pop();
  await expect(commitPassageOperationScopes(userId+99999,bookId,request)).rejects.toThrow('Book not found');
  expect((await documentService.manifest(userId,bookId)).revisionId).toBe(request.expectedRevisionId);
 });
});
