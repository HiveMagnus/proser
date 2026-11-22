import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import app from '@/index';
import {databaseService} from '@/lib/database';
import {documentService} from '@/documents/service';
import {documentFromText} from '@/documents/model';
import {searchOwnedDocument} from '@/documents/search';
import {foldSearchGrapheme} from '@/documents/searchCaseFold';

// The marked real-PG case writes three 1.65 MiB documents and checks bounded decode/excerpts.
// Its 20s cold-CI harness deadline does not relax those correctness bounds.
describe('bounded global manuscript search with exact immutable targets',()=>{
 const db=()=>databaseService.client;const old=process.env.DOCUMENT_AUTHORITY_ENABLED;let userId:number;let githubId:string;let bookId:number;let sceneIds:number[];
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';githubId=`search-${randomUUID()}`;userId=(await db().user.create({data:{githubId,username:'Search owner'}})).id;});
 beforeEach(async()=>{const book=await db().book.create({data:{userId,title:'Disposable global search',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:['Straße Café cafe\u0301 😀 👩🏽‍🚀 Echo. Echo.',...Array.from({length:9},(_,index)=>`Scene ${index+2} Echo.`)].map((prose,index)=>({sceneNumber:index+1,prose}))}}}}}},include:{acts:{include:{chapters:{include:{scenes:{orderBy:{sceneNumber:'asc'}}}}}}}});bookId=book.id;sceneIds=book.acts[0].chapters[0].scenes.map((scene)=>scene.id);await documentService.initialize(userId,bookId);});
 afterEach(async()=>{jest.restoreAllMocks();await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{if(old===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=old;await db().user.delete({where:{id:userId}});});
 const auth=(test:request.Test)=>test.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Search owner');
 test('full Unicode casefold and NFC matches retain original UTF-16 spans without normalizing stored text',async()=>{
  const before=await documentService.read(userId,bookId,sceneIds[0]);const folded=await searchOwnedDocument(userId,bookId,{q:'STRASSE'});expect(folded.hits[0]).toMatchObject({sourceText:'Straße',from:0,to:6,sceneContentHash:before.contentHash,sceneRevisionId:before.revisionId});
  const accented=await searchOwnedDocument(userId,bookId,{q:'café'});expect(accented.hits.map((hit)=>hit.sourceText)).toEqual(['Café','cafe\u0301']);for(const hit of accented.hits)expect(before.projection.text.slice(hit.from,hit.to)).toBe(hit.sourceText);
  expect((await searchOwnedDocument(userId,bookId,{q:'STRASSE',caseSensitive:true})).hits).toHaveLength(0);
  expect((await searchOwnedDocument(userId,bookId,{q:'🏽'})).hits).toHaveLength(0);const emoji=await searchOwnedDocument(userId,bookId,{q:'👩🏽‍🚀'});expect(emoji.hits[0].sourceText).toBe('👩🏽‍🚀');expect(emoji.hits[0].anchors[0].end-emoji.hits[0].anchors[0].start).toBe('👩🏽‍🚀'.length);
  const after=await documentService.read(userId,bookId,sceneIds[0]);expect(after.contentHash).toBe(before.contentHash);expect(after.document).toEqual(before.document);
 });
 test('result caps decode one scene, pinned pages retain older exact source after concurrent new typing',async()=>{
  const first=await searchOwnedDocument(userId,bookId,{q:'echo',limit:1});expect(first.hits).toHaveLength(1);expect(first.scannedScenes).toBe(1);expect(first.nextCursor).toBeDefined();
  const source=await documentService.read(userId,bookId,sceneIds[0]);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].text='Newer text without the old result.';await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId:sceneIds[0],expectedRevisionId:source.revisionId,document:source.document}]});
  const next=await searchOwnedDocument(userId,bookId,{q:'echo',limit:1,cursor:first.nextCursor});expect(next.stale).toBe(true);expect(next.sourceBookRevisionId).toBe(first.sourceBookRevisionId);expect(next.currentBookRevisionId).not.toBe(first.sourceBookRevisionId);expect(next.hits[0].sceneRevisionId).toBe(source.revisionId);expect(next.hits[0].from).toBeGreaterThan(first.hits[0].from);
  await expect(searchOwnedDocument(userId,bookId,{q:'other',cursor:first.nextCursor})).rejects.toMatchObject({code:'DOCUMENT_SEARCH_CURSOR_CONFLICT'});
 });
 test('no-match query filters in the index without decoding any scene or payload',async()=>{
  const bodies=jest.spyOn(db().sceneDocumentRevision,'findFirst');const payloads=jest.spyOn(db().sceneDocumentSearchIndex,'findUnique');const first=await searchOwnedDocument(userId,bookId,{q:'never-present'});expect(first.hits).toEqual([]);expect(first.scannedScenes).toBe(0);expect(first.decodedBytes).toBe(0);expect(bodies).not.toHaveBeenCalled();expect(payloads).not.toHaveBeenCalled();expect(first.complete).toBe(true);expect(first.index).toBe('revision-gin-v1');
 });
 test('table-cell and repeated-run hits use canonical identities; pending and object targets stay protected',async()=>{
  const source=await documentService.read(userId,bookId,sceneIds[0]);const document=documentFromText('Echo. Echo.',randomUUID);const paragraph=document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.bold=true;const cellId=randomUUID();document.blocks=[{type:'table',id:randomUUID(),widths:[300],rows:[{id:randomUUID(),cells:[{id:cellId,paragraphs:[paragraph]}]}]}];const changeId=randomUUID();paragraph.runs[0].changeId=changeId;document.changes=[{id:changeId,kind:'insertion',authorId:userId,authorName:'Search owner',createdAt:'2026-10-05T00:00:00.000Z',origin:'manual',status:'pending',targetRunIds:[paragraph.runs[0].id]}];
  await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId:sceneIds[0],expectedRevisionId:source.revisionId,document}]});
  const result=await searchOwnedDocument(userId,bookId,{q:'echo',limit:2});expect(result.hits[0].anchors[0]).toMatchObject({blockId:paragraph.id,runId:paragraph.runs[0].id,start:0,end:4,sourceText:'Echo'});expect(result.hits[1].anchors[0].start).toBe(6);expect(result.hits[0].locations[0].cellId).toBe(cellId);expect(result.hits.every((hit)=>!hit.editable)).toBe(true);
 });
 test('owned endpoint validates query/cursor bounds and denies foreign source reads',async()=>{
  const response=await auth(request(app).get(`/api/books/${bookId}/document-search?q=STRASSE&limit=1`));expect(response.status).toBe(200);expect(response.body.data.hits[0].sourceText).toBe('Straße');expect(response.headers['cache-control']).toBe('private, no-store');
  expect((await auth(request(app).get(`/api/books/${bookId}/document-search?q=Echo&cursor=not-a-cursor`))).status).toBe(422);
  expect((await auth(request(app).get(`/api/books/${bookId}/document-search?q=${'x'.repeat(129)}`))).status).toBe(422);
  const foreign=await db().user.create({data:{githubId:`foreign-search-${randomUUID()}`,username:'Foreign search'}});try{await expect(searchOwnedDocument(foreign.id,bookId,{q:'Echo'})).rejects.toMatchObject({name:'NotFoundError'});}finally{await db().user.delete({where:{id:foreign.id}});}
 });

 test('large manuscripts obey the four MiB decode budget and return only bounded excerpts',async()=>{
  const manifest=await documentService.manifest(userId,bookId);const items=[];
  for(const sceneId of sceneIds.slice(0,3)){const source=await documentService.read(userId,bookId,sceneId);items.push({sceneId,expectedRevisionId:source.revisionId,document:documentFromText('manuscript '.repeat(150000),randomUUID)});}
  await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:manifest.revisionId,scenes:items});
  const first=await searchOwnedDocument(userId,bookId,{q:'never-present',limit:1});expect(first.scannedScenes).toBe(0);expect(first.decodedBytes).toBe(0);expect(first.complete).toBe(true);expect(first.hits).toEqual([]);
  const result=await searchOwnedDocument(userId,bookId,{q:'manuscript',limit:1});expect(result.scannedScenes).toBe(1);expect(result.hits).toHaveLength(1);expect(result.hits[0].excerpt.length).toBeLessThan(300);expect(JSON.stringify(result).length).toBeLessThan(4096);
 }, 20_000);
 test('all full casefold entries match retained official Unicode data and its exact checksum',()=>{
  const file=readFileSync(path.resolve(process.cwd(),'vendor/unicode/16.0.0/CaseFolding.txt'));expect(createHash('sha256').update(file).digest('hex')).toBe('6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb');let checked=0;
  for(const line of file.toString().split('\n')){if(!line||line.startsWith('#'))continue;const [code,status,mapping]=line.split(';').map((part)=>part.trim());if(status!=='C'&&status!=='F')continue;const source=String.fromCodePoint(Number.parseInt(code,16));const expected=mapping.split(' ').map((value)=>String.fromCodePoint(Number.parseInt(value,16))).join('').normalize('NFC');expect(foldSearchGrapheme(source,false)).toBe(expected);checked++;}expect(checked).toBe(1557);
 });
});
