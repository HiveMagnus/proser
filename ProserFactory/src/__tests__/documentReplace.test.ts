import {randomUUID} from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import {databaseService} from '@/lib/database';
import {documentService} from '@/documents/service';
import {searchOwnedDocument} from '@/documents/search';
import {applyBookReplace,previewBookReplace} from '@/documents/replace';
import {documentFromText,projectDocument,type DocumentParagraph} from '@/documents/model';

describe('book-wide find and replace',()=>{
 const db=()=>databaseService.client;const old=process.env.DOCUMENT_AUTHORITY_ENABLED;let userId:number;let githubId:string;let bookId:number;let first:number;let second:number;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';githubId=`replace-${randomUUID()}`;userId=(await db().user.create({data:{githubId,username:'Replace owner'}})).id;});
 beforeEach(async()=>{
  const book=await db().book.create({data:{userId,title:'Disposable replace fixture',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:[{sceneNumber:1,prose:'placeholder one'},{sceneNumber:2,prose:'No raven here? A RAVEN.'}]}}}}}},include:{acts:{include:{chapters:{include:{scenes:{orderBy:{sceneNumber:'asc'}}}}}}}});
  bookId=book.id;[first,second]=book.acts[0].chapters[0].scenes.map((scene)=>scene.id);await documentService.initialize(userId,bookId);
  // Scene one: a plain paragraph, and a paragraph where one match crosses bold
  // formatting and another lies wholly inside one bold run.
  const source=await documentService.read(userId,bookId,first);const document=documentFromText('The Raven flew. The raven sang.\n\nx',randomUUID);
  (document.blocks[1] as DocumentParagraph).runs=[{id:randomUUID(),text:'Bold ',style:{}},{id:randomUUID(),text:'rav',style:{bold:true}},{id:randomUUID(),text:'en end ',style:{}},{id:randomUUID(),text:'raven',style:{italic:true}}];
  await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId:first,expectedRevisionId:source.revisionId,document}]});
 });
 afterEach(async()=>{await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{if(old===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=old;await db().user.delete({where:{id:userId}});});
 const auth=(test:request.Test)=>test.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Replace owner');

 test('preview lists every match in book order and flags matches that cross formatting',async()=>{
  const preview=await previewBookReplace(userId,bookId,{q:'raven',replacement:'crow'});
  expect(preview.sourceBookRevisionId).toBe((await documentService.manifest(userId,bookId)).revisionId);
  expect(preview.matches.map((match)=>[match.sceneId,match.sourceText,match.replaceable,match.reason])).toEqual([[first,'Raven',true,undefined],[first,'raven',true,undefined],[first,'raven',false,'formatting'],[first,'raven',true,undefined],[second,'raven',true,undefined],[second,'RAVEN',true,undefined]]);
  expect(preview).toMatchObject({sceneCount:2,truncated:false});expect(preview.matches[0].excerpt).toContain('The Raven flew');
  const sensitive=await previewBookReplace(userId,bookId,{q:'RAVEN',replacement:'crow',caseSensitive:true});expect(sensitive.matches.map((match)=>match.sceneId)).toEqual([second]);
  // A scene whose search index row is missing is read directly, not skipped.
  await db().sceneDocumentSearchIndex.deleteMany({where:{bookId,sceneId:second}});expect((await previewBookReplace(userId,bookId,{q:'raven',replacement:'crow'})).matches.filter((match)=>match.sceneId===second)).toHaveLength(2);
  expect((await previewBookReplace(userId,bookId,{q:'r_ven',replacement:'crow'})).matches).toEqual([]);
  await expect(previewBookReplace(userId,bookId,{q:'raven',replacement:'two\n\nlines'})).rejects.toMatchObject({code:'DOCUMENT_REPLACE_TEXT_INVALID',status:422});
 });

 test('selected matches commit as one revision that keeps styles, skips the rest, and can be undone',async()=>{
  const preview=await previewBookReplace(userId,bookId,{q:'raven',replacement:'crow'});const before=await documentService.manifest(userId,bookId);
  const selected=preview.matches.filter((match)=>match.replaceable&&match.sourceText!=='RAVEN');const operationId=randomUUID();
  const body={schemaVersion:1 as const,operationId,expectedRevisionId:preview.sourceBookRevisionId,q:'raven',replacement:'crow',matches:selected.map(({sceneId,sceneRevisionId,from,to})=>({sceneId,sceneRevisionId,from,to}))};
  const receipt=await applyBookReplace(userId,bookId,body);
  expect(receipt).toMatchObject({kind:'replace',previousRevisionId:before.revisionId,replacedCount:4,status:'completed'});expect(receipt.scenes.map((scene)=>scene.sceneId).sort()).toEqual([first,second].sort());
  const after=await documentService.manifest(userId,bookId);expect(after.revisionId).toBe(receipt.revisionId);
  expect((await db().bookDocumentRevision.findUniqueOrThrow({where:{id:receipt.revisionId}})).parentRevisionId).toBe(before.revisionId);
  const one=await documentService.read(userId,bookId,first);expect(one.projection.text).toBe('The crow flew. The crow sang.\n\nBold raven end crow');
  expect((one.document.blocks[1] as DocumentParagraph).runs.map((run)=>[run.text,run.style])).toEqual([['Bold ',{}],['rav',{bold:true}],['en end ',{}],['crow',{italic:true}]]);
  expect((await documentService.read(userId,bookId,second)).projection.text).toBe('No crow here? A RAVEN.');
  expect((await searchOwnedDocument(userId,bookId,{q:'crow'})).hits).toHaveLength(4);
  // Retrying the operation returns the same receipt without another revision.
  const revisions=await db().bookDocumentRevision.count({where:{bookId}});expect(await applyBookReplace(userId,bookId,body)).toEqual(receipt);expect(await db().bookDocumentRevision.count({where:{bookId}})).toBe(revisions);
  expect((await documentService.manifest(userId,bookId)).revisionId).toBe(receipt.revisionId);
  // Undo restores the revision before the replace.
  await documentService.restore(userId,bookId,receipt.previousRevisionId,receipt.revisionId,randomUUID());
  expect(projectDocument((await documentService.read(userId,bookId,first)).document).text).toBe('The Raven flew. The raven sang.\n\nBold raven end raven');
  expect((await documentService.read(userId,bookId,second)).projection.text).toBe('No raven here? A RAVEN.');
 });

 test('stale, edited, unsupported and no-op selections are refused without a commit',async()=>{
  const preview=await previewBookReplace(userId,bookId,{q:'raven',replacement:'crow'});const pick=(index:number)=>{const {sceneId,sceneRevisionId,from,to}=preview.matches[index]!;return {sceneId,sceneRevisionId,from,to};};
  const base={schemaVersion:1 as const,expectedRevisionId:preview.sourceBookRevisionId,q:'raven',replacement:'crow'};const head=(await documentService.manifest(userId,bookId)).revisionId;
  await expect(applyBookReplace(userId,bookId,{...base,operationId:randomUUID(),matches:[pick(2)]})).rejects.toMatchObject({code:'DOCUMENT_REPLACE_MATCH_UNSUPPORTED',status:409});
  await expect(applyBookReplace(userId,bookId,{...base,operationId:randomUUID(),matches:[{...pick(0),from:pick(0).from+1,to:pick(0).to+1}]})).rejects.toMatchObject({code:'DOCUMENT_REPLACE_MATCH_INVALID',status:409});
  await expect(applyBookReplace(userId,bookId,{...base,replacement:'Raven',operationId:randomUUID(),matches:[pick(0)]})).rejects.toMatchObject({code:'DOCUMENT_REPLACE_NOOP',status:422});
  await expect(applyBookReplace(userId,bookId,{...base,operationId:randomUUID(),matches:[pick(0),{...pick(0),from:pick(0).from+2}]})).rejects.toMatchObject({code:'DOCUMENT_REPLACE_MATCH_INVALID'});
  expect((await documentService.manifest(userId,bookId)).revisionId).toBe(head);
  // Another save after the preview makes the whole replace stale.
  const source=await documentService.read(userId,bookId,second);await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId:second,expectedRevisionId:source.revisionId,document:documentFromText('A raven again.',randomUUID)}]});
  await expect(applyBookReplace(userId,bookId,{...base,operationId:randomUUID(),matches:[pick(0)]})).rejects.toMatchObject({code:'DOCUMENT_SOURCE_STALE',status:412});
 });

 test('routes are owner-scoped and return the preview and receipt',async()=>{
  const foreign=await db().user.create({data:{githubId:`replace-foreign-${randomUUID()}`,username:'Foreign'}});
  try{expect((await request(app).post(`/api/books/${bookId}/document-replace/preview`).set('x-user-id',String(foreign.id)).set('x-github-id',foreign.githubId).send({q:'raven',replacement:'crow'})).status).toBe(404);}finally{await db().user.delete({where:{id:foreign.id}});}
  const preview=await auth(request(app).post(`/api/books/${bookId}/document-replace/preview`)).send({q:'raven',replacement:'crow'});expect(preview.status).toBe(200);expect(preview.headers['cache-control']).toBe('private, no-store');
  const match=preview.body.data.matches[0];const applied=await auth(request(app).post(`/api/books/${bookId}/document-replace`)).send({schemaVersion:1,operationId:randomUUID(),expectedRevisionId:preview.body.data.sourceBookRevisionId,q:'raven',replacement:'crow',matches:[{sceneId:match.sceneId,sceneRevisionId:match.sceneRevisionId,from:match.from,to:match.to}]});
  expect(applied.status).toBe(200);expect(applied.body.data).toMatchObject({kind:'replace',replacedCount:1});
  expect((await auth(request(app).post(`/api/books/${bookId}/document-replace`)).send({schemaVersion:1,operationId:randomUUID(),expectedRevisionId:preview.body.data.sourceBookRevisionId,q:'raven',replacement:'crow',matches:[]})).status).toBe(422);
 });
});
