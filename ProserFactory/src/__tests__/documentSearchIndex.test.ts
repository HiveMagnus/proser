import * as indexService from '@/documents/searchIndex';
import {randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import request from 'supertest';
import app from '@/index';
import {databaseService} from '@/lib/database';
import {documentService} from '@/documents/service';
import {searchOwnedDocument} from '@/documents/search';
import {backfillSceneSearchIndexes,searchIndexReadiness,buildSceneSearchIndex,searchGrams} from '@/documents/searchIndex';
import {documentFromText,canonicalDocument} from '@/documents/model';

describe('immutable revision-bound GIN search index and recovery',()=>{
 const db=()=>databaseService.client;const old=process.env.DOCUMENT_AUTHORITY_ENABLED;let userId:number;let githubId:string;let bookId:number;let sceneId:number;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';githubId=`index-${randomUUID()}`;userId=(await db().user.create({data:{githubId,username:'Index owner'}})).id;});
 beforeEach(async()=>{const book=await db().book.create({data:{userId,title:'Disposable indexed fixture',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:{sceneNumber:1,prose:'Straße Echo 😀 café cafe\u0301'}}}}}}},include:{acts:{include:{chapters:{include:{scenes:true}}}}}});bookId=book.id;sceneId=book.acts[0].chapters[0].scenes[0].id;await documentService.initialize(userId,bookId);});
 afterEach(async()=>{jest.restoreAllMocks();await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{if(old===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=old;await db().user.delete({where:{id:userId}});});
 const auth=(test:request.Test)=>test.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Index owner');
 test('each writer stores exact projection/source evidence atomically; search loads no source body',async()=>{
  const before=await documentService.read(userId,bookId,sceneId);const initial=await db().sceneDocumentSearchIndex.findUniqueOrThrow({where:{sceneRevisionId:before.revisionId}});expect(initial).toMatchObject({bookId,sceneId,contentHash:before.contentHash,wordCount:before.projection.wordCount});expect(initial.payload).toMatchObject({text:before.projection.text});
  const paragraph=before.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].text+=' newest';await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:before.bookRevisionId,scenes:[{sceneId,expectedRevisionId:before.revisionId,document:before.document}]});
  expect(await db().sceneDocumentSearchIndex.count({where:{bookId,sceneId}})).toBe(2);const bodies=jest.spyOn(db().sceneDocumentRevision,'findFirst');const result=await searchOwnedDocument(userId,bookId,{q:'newest'});expect(result.hits).toHaveLength(1);expect(bodies).not.toHaveBeenCalled();expect(await db().sceneDocumentSearchIndex.findUnique({where:{sceneRevisionId:initial.sceneRevisionId}})).toEqual(initial);
 });
 test('missing index fails closed and owned bounded recovery is idempotent without changing heads',async()=>{
  const before=await documentService.manifest(userId,bookId);await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});await expect(searchOwnedDocument(userId,bookId,{q:'Echo'})).rejects.toMatchObject({code:'DOCUMENT_SEARCH_INDEX_INCOMPLETE',status:503});
  const foreign=await db().user.create({data:{githubId:`index-foreign-${randomUUID()}`,username:'Foreign'}});try{expect((await request(app).post(`/api/books/${bookId}/document-search-index/recover`).set('x-user-id',String(foreign.id)).set('x-github-id',foreign.githubId).send({limit:1})).status).toBe(404);}finally{await db().user.delete({where:{id:foreign.id}});}
  const recovered=await auth(request(app).post(`/api/books/${bookId}/document-search-index/recover`)).send({limit:1});expect(recovered.status).toBe(200);expect(recovered.body.data).toMatchObject({inserted:1,scanned:1,complete:true});const second=await auth(request(app).post(`/api/books/${bookId}/document-search-index/recover`)).send({limit:1});expect(second.body.data).toMatchObject({inserted:0,verified:1});expect(await documentService.manifest(userId,bookId)).toEqual(before);expect((await searchOwnedDocument(userId,bookId,{q:'strasse'})).hits[0].sourceText).toBe('Straße');
 });
 test('historical mismatches are preserved and refused instead of overwritten',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);await db().sceneDocumentSearchIndex.update({where:{sceneRevisionId:source.revisionId},data:{foldedText:'forged search text'}});await expect(backfillSceneSearchIndexes(db(),bookId,{apply:true})).rejects.toMatchObject({code:'DOCUMENT_SEARCH_INDEX_INVALID',status:503});expect((await db().sceneDocumentSearchIndex.findUniqueOrThrow({where:{sceneRevisionId:source.revisionId}})).foldedText).toBe('forged search text');
 });
 test('create-only backfill cursor covers old revisions with bounded body decoding and exact Unicode source maps',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:documentFromText('Second Echo',randomUUID)}]});await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});
  const bodies=jest.spyOn(db().sceneDocumentRevision,'findUniqueOrThrow');const first=await backfillSceneSearchIndexes(db(),bookId,{apply:true,limit:1});expect(first).toMatchObject({scanned:1,inserted:1,complete:false});expect(bodies).toHaveBeenCalledTimes(1);const second=await backfillSceneSearchIndexes(db(),bookId,{apply:true,limit:1,after:first.nextAfter});expect(second).toMatchObject({scanned:1,inserted:1,complete:true});expect(await db().sceneDocumentSearchIndex.count({where:{bookId}})).toBe(2);
 });
 test('GIN postings are available to PostgreSQL without extensions and overflow never creates false negatives',async()=>{
  const plans=await db().$transaction(async(tx)=>{await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');return tx.$queryRaw<Array<{'QUERY PLAN':string}>>(Prisma.sql`EXPLAIN SELECT scene_revision_id FROM scene_document_search_indexes WHERE folded_grams @> ARRAY['3:ech']::text[]`);});expect(plans.map((row)=>row['QUERY PLAN']).join('\n')).toContain('scene_document_search_indexes_folded_grams_idx');
  const grams=searchGrams('Echo',true);expect(grams.grams).toEqual(expect.arrayContaining(['1:E','2:Ec','3:Ech','3:cho']));const index=buildSceneSearchIndex(documentFromText('👩🏽‍🚀 Straße',randomUUID));expect(index.foldedText).toBe('👩🏽‍🚀 strasse');expect(canonicalDocument(index.payload)).toContain('Straße');
 });
 test('literal SQL pattern characters retain exact substring semantics',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:documentFromText('a_b a%b a\\b',randomUUID)}]});
  for(const q of ['a_b','a%b','a\\b'])expect((await searchOwnedDocument(userId,bookId,{q})).hits.map((hit)=>hit.sourceText)).toEqual([q]);expect((await searchOwnedDocument(userId,bookId,{q:'aZb'})).hits).toHaveLength(0);
 });
 test('high-entropy posting overflow preserves exact indexed search rather than losing targets',async()=>{
  const text=Array.from({length:65540},(_,index)=>String.fromCodePoint(0x20000+index)).join('');const source=await documentService.read(userId,bookId,sceneId);await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:documentFromText(text,randomUUID)}]});
  const indexed=await db().sceneDocumentSearchIndex.findFirstOrThrow({where:{bookId,sceneId,foldedOverflow:true}});expect(indexed.foldedGrams).toEqual([]);const q=text.slice(-10);const found=await searchOwnedDocument(userId,bookId,{q});expect(found.hits[0]).toMatchObject({sourceText:q,from:text.length-10,to:text.length,editable:true});
 });
 test('failed index creation rolls back source revision, head, projection, receipt and audit',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);const previous=await documentService.manifest(userId,bookId);const count=await db().sceneDocumentRevision.count({where:{bookId}});const operationId=randomUUID();const create=jest.spyOn(indexService,'insertSceneSearchIndex').mockRejectedValueOnce(new Error('simulated index persistence failure'));
  try{await expect(documentService.commit(userId,bookId,{schemaVersion:1,operationId,expectedRevisionId:source.bookRevisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:documentFromText('Not acknowledged',randomUUID)}]})).rejects.toThrow('simulated index persistence failure');}finally{create.mockRestore();}
  expect(await documentService.manifest(userId,bookId)).toEqual(previous);expect(await db().sceneDocumentRevision.count({where:{bookId}})).toBe(count);expect(await db().documentOperation.findUnique({where:{id:operationId}})).toBeNull();expect((await db().scene.findUniqueOrThrow({where:{id:sceneId}})).prose).toBe(source.projection.text);
 });
 test('readiness identifies current incomplete indexes; query metadata mismatch is explicit',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});expect(await searchIndexReadiness(db())).toBe(false);await backfillSceneSearchIndexes(db(),bookId,{apply:true});await db().sceneDocumentSearchIndex.update({where:{sceneRevisionId:source.revisionId},data:{wordCount:999}});await expect(searchOwnedDocument(userId,bookId,{q:'Echo'})).rejects.toMatchObject({code:'DOCUMENT_SEARCH_INDEX_INVALID'});
 });
});
