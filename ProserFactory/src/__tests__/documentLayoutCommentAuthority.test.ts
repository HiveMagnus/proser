import {randomUUID} from 'node:crypto';
import request from 'supertest';
import app from '@/index';
import {databaseService} from '@/lib/database';
import {documentService} from '@/documents/service';
import {documentFromText,type ProserDocument,type DocumentAnchor} from '@/documents/model';
import {assertOwnedCommentEvidence} from '@/documents/commentAnchors';

describe('owned front/back/header/footer comment source authority',()=>{
 const db=()=>databaseService.client;const old=process.env.DOCUMENT_AUTHORITY_ENABLED;let userId:number;let githubId:string;let bookId:number;let storyIds:string[];
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';githubId=`story-comment-${randomUUID()}`;userId=(await db().user.create({data:{githubId,username:'Story owner'}})).id;});
 const storyDocument=(id:string)=>{const document=documentFromText('Echo. Echo.',randomUUID);const paragraph=document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.bold=true;document.comments=[{id:`comment-${id}`,authorId:999,authorName:'Spoofed',createdAt:'2026-10-05T00:00:00.000Z',text:'Discuss the second quotation.',anchors:[{blockId:paragraph.id,runId:paragraph.runs[0].id,start:6,end:11,sourceText:'Echo.'}],resolved:false}];return document;};
 beforeEach(async()=>{
  bookId=(await db().book.create({data:{userId,title:'Disposable story fixture'}})).id;await documentService.initialize(userId,bookId);storyIds=Array.from({length:4},()=>randomUUID());
  const scope=await documentService.scope(userId,bookId,'layout');const layout=structuredClone(scope.content);layout.frontMatter=[{id:storyIds[0],name:'Foreword',document:storyDocument(storyIds[0])}];layout.backMatter=[{id:storyIds[1],name:'Afterword',document:storyDocument(storyIds[1])}];layout.headerFooterStories=[{id:storyIds[2],owner:'book',kind:'header',document:storyDocument(storyIds[2])},{id:storyIds[3],owner:'book',kind:'footer',document:storyDocument(storyIds[3])}];
  await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:scope.bookRevisionId,expectedScopes:{layout:scope.revisionId},payload:{command:'fixture-owned-stories'}},async()=>({result:{},layout}));
 });
 afterEach(async()=>{jest.restoreAllMocks();await db().imageAsset.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{if(old===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=old;await db().user.delete({where:{id:userId}});});
 const stories=(layout:Awaited<ReturnType<typeof documentService.scope<'layout'>>>['content'])=>[...layout.frontMatter,...layout.backMatter,...(layout.headerFooterStories??[])];
 const auth=(test:request.Test)=>test.set('x-user-id',String(userId)).set('x-github-id',githubId).set('x-username','Story owner');
 const base=(id:string)=>`/api/books/${bookId}/layout-stories/${id}/document-comments`;
 const orphanAll=async()=>{
  const source=await documentService.scope(userId,bookId,'layout');const layout=structuredClone(source.content);for(const story of stories(layout)){const next=documentFromText('Echo.',randomUUID);next.comments=structuredClone(story.document.comments);story.document=next;}
  await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,expectedScopes:{layout:source.revisionId},payload:{command:'fixture-removed-story-targets'}},async()=>({result:{},layout}));return {source,current:await documentService.scope(userId,bookId,'layout')};
 };
 test('all ancillary story kinds retain exact source-scope evidence and group source proof reads once',async()=>{
  const {source,current}=await orphanAll();const documents=stories(current.content).map((story)=>story.document);
  for(const [position,story]of stories(current.content).entries()){
   expect(story.document.comments[0]).toMatchObject({authorId:userId,authorName:'Story owner',anchorStates:[{status:'orphaned',sourceKind:'layout-story',sourceStoryId:storyIds[position],sourceLayoutRevisionId:source.revisionId,sourceContentHash:source.contentHash}]});
   const response=await auth(request(app).get(base(story.id)));expect(response.status).toBe(200);expect(response.body.data).toMatchObject({sourceKind:'layout-story',layoutRevisionId:current.revisionId,comments:[{anchorStates:[{status:'orphaned'}]}]});
  }
  const revisions=jest.spyOn(db().bookDocumentScopeRevision,'findFirst');await assertOwnedCommentEvidence(db(),userId,bookId,documents);expect(revisions).toHaveBeenCalledTimes(1);
 });
 test('explicit owned reattachment retains layout proof history, stale requests reject and lost receipts recover',async()=>{
  const {current}=await orphanAll();const document=stories(current.content)[0].document;const paragraph=document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');const anchors:DocumentAnchor[]=[{blockId:paragraph.id,runId:paragraph.runs[0].id,start:0,end:5,sourceText:'Echo.'}];const commentId=document.comments[0].id;const source={expectedRevisionId:current.bookRevisionId,expectedLayoutRevisionId:current.revisionId};
  expect((await auth(request(app).post(base(storyIds[0])+'/'+commentId+'/revalidate')).send({})).status).toBe(428);
  const preview=await auth(request(app).post(base(storyIds[0])+'/'+commentId+'/revalidate')).send({...source,anchors});expect(preview.status).toBe(200);expect(preview.body.data.attachment).toBe('detached');
  const input={...source,operationId:randomUUID(),action:'reanchored',anchors};const saved=await auth(request(app).post(base(storyIds[0])+'/'+commentId+'/resolve')).send(input);expect(saved.status).toBe(200);
  const latest=await documentService.scope(userId,bookId,'layout');const comment=stories(latest.content)[0].document.comments[0];expect(comment.anchors).toEqual(anchors);expect(comment.anchorStates).toBeUndefined();expect(comment.resolutionHistory?.[0]).toMatchObject({sourceKind:'layout-story',sourceStoryId:storyIds[0],sourceLayoutRevisionId:current.revisionId,actorId:userId,previousAnchorStates:document.comments[0].anchorStates});
  expect((await auth(request(app).post(base(storyIds[0])+'/'+commentId+'/resolve')).send(input)).body.data).toEqual(saved.body.data);
  expect((await auth(request(app).post(base(storyIds[0])+'/'+commentId+'/resolve')).send({...input,operationId:randomUUID()})).status).toBe(412);
 });
 test('foreign or invented source story proofs reject and unresolved stories cannot disappear',async()=>{
  const {current}=await orphanAll();const forged=structuredClone(stories(current.content)[0].document);const proof=forged.comments[0].anchorStates![0];if(proof.sourceKind!=='layout-story')throw new Error('fixture');proof.sourceStoryId=storyIds[1];await expect(db().$transaction((tx)=>assertOwnedCommentEvidence(tx,userId,bookId,forged))).rejects.toMatchObject({code:'DOCUMENT_COMMENT_SOURCE_INVALID'});
  const foreign=await db().user.create({data:{githubId:`foreign-story-${randomUUID()}`,username:'Foreign reviewer'}});try{await expect(db().$transaction((tx)=>assertOwnedCommentEvidence(tx,foreign.id,bookId,stories(current.content)[0].document))).rejects.toMatchObject({code:'DOCUMENT_SCOPE_NOT_FOUND'});}finally{await db().user.delete({where:{id:foreign.id}});}
  const layout=structuredClone(current.content);layout.frontMatter=[];await expect(documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:current.bookRevisionId,expectedScopes:{layout:current.revisionId},payload:{command:'fixture-forbidden-story-delete'}},async()=>({result:{},layout}))).rejects.toMatchObject({status:409});
 });
 test('new story callers cannot fabricate historical proofs',async()=>{
  const {current}=await orphanAll();const layout=structuredClone(current.content);const forged:ProserDocument=structuredClone(stories(current.content)[0].document);layout.backMatter.push({id:randomUUID(),name:'Forged copy',document:forged});await expect(documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:current.bookRevisionId,expectedScopes:{layout:current.revisionId},payload:{command:'fixture-forged-new-story'}},async()=>({result:{},layout}))).rejects.toMatchObject({code:'DOCUMENT_COMMENT_EVIDENCE_INVALID'});
 });
 test('table-cell text and drawing-point comments preserve containers and retain proof after object deletion',async()=>{
  const sha256='a'.repeat(64);const asset=await db().imageAsset.create({data:{userId,bookId,name:'story-cell.png',url:'/images/story-cell.png',configJson:JSON.stringify({sha256})}});
  const source=await documentService.scope(userId,bookId,'layout');const layout=structuredClone(source.content);const storyId=randomUUID();const document=documentFromText('Cell 👩🏽‍🚀 text.',randomUUID);const paragraph=document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');const imageId=randomUUID();paragraph.runs.push({id:imageId,text:'',style:{},inlineImage:{assetId:asset.id,sha256,alt:'Table drawing',width:100,height:100}});document.blocks=[{type:'table',id:randomUUID(),widths:[200],rows:[{id:randomUUID(),cells:[{id:randomUUID(),paragraphs:[paragraph]}]}]}];
  document.comments=[{id:'table-text-comment',authorId:0,authorName:'Untrusted',createdAt:'2026-10-05T00:00:00.000Z',text:'Discuss this cell.',resolved:false,anchors:[{blockId:paragraph.id,runId:paragraph.runs[0].id,start:0,end:4,sourceText:'Cell'}]},{id:'table-image-comment',authorId:0,authorName:'Untrusted',createdAt:'2026-10-05T00:00:00.000Z',text:'Discuss this drawing.',resolved:false,anchors:[{blockId:paragraph.id,runId:imageId,start:0,end:0,sourceText:''}]}];layout.frontMatter.push({id:storyId,name:'Rich table fixture',document});
  await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,expectedScopes:{layout:source.revisionId},payload:{command:'fixture-rich-story-comment'}},async()=>({result:{},layout}));
  const before=await documentService.scope(userId,bookId,'layout');const next=structuredClone(before.content);const target=next.frontMatter.find((entry)=>entry.id===storyId)!.document;const table=target.blocks[0];if(table.type!=='table')throw new Error('fixture');table.rows[0].cells[0].paragraphs[0].runs=table.rows[0].cells[0].paragraphs[0].runs.filter((run)=>run.id!==imageId);
  await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:before.bookRevisionId,expectedScopes:{layout:before.revisionId},payload:{command:'fixture-removed-cell-drawing'}},async()=>({result:{},layout:next}));
  const current=await documentService.scope(userId,bookId,'layout');const saved=current.content.frontMatter.find((entry)=>entry.id===storyId)!.document;expect(saved.comments[0].anchorStates).toBeUndefined();expect(saved.comments[1].anchorStates?.[0]).toMatchObject({status:'orphaned',sourceKind:'layout-story',sourceStoryId:storyId,sourceLayoutRevisionId:before.revisionId,sourceContentHash:before.contentHash,sourceAnchor:{runId:imageId,start:0,end:0,sourceText:''}});expect((await auth(request(app).get(base(storyId)))).status).toBe(200);
 });

});
