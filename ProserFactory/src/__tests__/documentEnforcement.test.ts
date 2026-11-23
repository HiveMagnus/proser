import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {captureEnforcementTestState,restoreEnforcementTestState,type EnforcementTestState} from './fixtures/enforcementState';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { preserveImportOriginal, deleteImportOriginal } from '@/documents/imports';
import { documentFromText, projectDocument, type ProserDocument } from '@/documents/model';

const sql = readFileSync(resolve(__dirname, '../../deploy/document-authority/enforcement.sql'), 'utf8');
const explicitIsolated = /^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:55441\/proser_canvas_[a-zA-Z0-9_]+(?:\?.*)?$/.test(process.env.DATABASE_URL ?? '');
(explicitIsolated ? describe : describe.skip)('candidate-reviewed database document enforcement', () => {
  const db = () => databaseService.client;
  let userId: number; let bookId: number; let sceneId: number; let priorEnforcement:EnforcementTestState;
  beforeAll(async () => {
    priorEnforcement=await captureEnforcementTestState();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect(); try { await client.query(sql); } finally { await client.end(); }
    userId = (await db().user.create({ data: { githubId: `enforcement-${randomUUID()}`, username: 'Enforcement fixture' } })).id;
  });
  beforeEach(async () => {
    await db().$executeRawUnsafe('UPDATE proser_document_enforcement SET enabled=false');
    const book = await db().book.create({ data: { userId, title: 'Disposable enforcement fixture', acts: { create: { actNumber: 1, chapters: { create: { chapterNumber: 1, scenes: { create: { sceneNumber: 1, prose: 'Original 😀 text' } } } } } } }, include: { acts: { include: { chapters: { include: { scenes: true } } } } } });
    bookId = book.id; sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
    await db().$executeRawUnsafe('UPDATE proser_document_enforcement SET enabled=true');
  });
  afterEach(async () => {
    await db().$executeRawUnsafe('UPDATE proser_document_enforcement SET enabled=false');
    await db().sceneDocumentSearchIndex.deleteMany({where:{bookId}});
    await db().documentImportPreview.deleteMany({ where: { bookId } });
    await db().documentImportOriginal.deleteMany({ where: { bookId } });
    await db().documentPublicationArtifact.deleteMany({ where: { bookId } });
    await db().imageAsset.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => { try { if(userId)await db().user.delete({ where: { id: userId } }); } finally { if(priorEnforcement)await restoreEnforcementTestState(priorEnforcement); } });
  test('lets only the document service delete an unused import original and keeps committed import evidence', async () => {
    const unused = randomUUID();
    const used = randomUUID();
    await preserveImportOriginal(userId, bookId, unused, 'docx', Buffer.from('unused fixture'));
    await preserveImportOriginal(userId, bookId, used, 'docx', Buffer.from('used fixture'));
    await expect(db().documentImportOriginal.update({ where: { id: unused }, data: { format: 'forged' } })).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    await expect(db().documentImportOriginal.delete({ where: { id: unused } })).rejects.toThrow('PROSER_DOCUMENT_ADMISSION_REQUIRED');
    const audit = await db().auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: { importSource: { originalId: used, previewId: randomUUID() } } } });
    // Even an admitted transaction that skips the service check cannot remove it.
    await expect(db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('proser.document_book', ${String(bookId)}, true)`;
      await tx.documentImportOriginal.delete({ where: { id: used } });
    })).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    await expect(deleteImportOriginal(userId, bookId, used)).rejects.toMatchObject({ status: 409 });
    await expect(deleteImportOriginal(userId, bookId, unused)).resolves.toMatchObject({ deleted: true });
    expect(await db().documentImportOriginal.count({ where: { id: { in: [unused, used] } } })).toBe(1);
    await db().$executeRawUnsafe('UPDATE proser_document_enforcement SET enabled=false');
    await db().auditLog.delete({ where: { id: audit.id } });
  });

  test('blocks stale code and evidence mutation while allowing a complete guarded document commit', async () => {
    const before = await documentService.read(userId, bookId, sceneId);
    await expect(db().scene.update({ where: { id: sceneId }, data: { prose: 'Stale overwrite' } })).rejects.toThrow('PROSER_DOCUMENT_ADMISSION_REQUIRED');
    await expect(db().sceneDocumentRevision.update({ where: { id: before.revisionId }, data: { originalProse: 'Tampered' } })).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    await expect(db().sceneDocumentSearchIndex.update({where:{sceneRevisionId:before.revisionId},data:{foldedText:'forged'}})).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    await expect(db().sceneDocumentSearchIndex.delete({where:{sceneRevisionId:before.revisionId}})).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    const audit=await db().auditLog.create({data:{userId,entityType:'scene',entityId:sceneId,action:'update',metadata:{action:'resolve-document-change',decision:'accepted',changeId:'preserved-fixture'}}});
    await expect(db().auditLog.update({where:{id:audit.id},data:{metadata:{decision:'rejected'}}})).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    await expect(db().auditLog.delete({where:{id:audit.id}})).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
    await expect(db().scene.delete({ where: { id: sceneId } })).rejects.toThrow('PROSER_DOCUMENT_ADMISSION_REQUIRED');
    const document = structuredClone(before.document); const paragraph = document.blocks[0];
    if (paragraph.type !== 'paragraph') throw new Error('fixture');
    paragraph.runs[0].text = 'Saved\u00a0😀\u2028é\uFEFFtext'; paragraph.runs[0].style.bold = true;
    const receipt = await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document }] });
    const saved = await documentService.read(userId, bookId, sceneId);
    expect(saved.bookRevisionId).toBe(receipt.revisionId); expect(saved.document).toEqual(document);
    expect((await db().scene.findUniqueOrThrow({ where: { id: sceneId } })).wordCount).toBe(projectDocument(document).wordCount);
    await expect(documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: before.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: before.revisionId, document }] })).rejects.toMatchObject({ status: 412 });
  });
  test('rejects a scoped marker bypass that changes only prose or corrupts the head', async () => {
    const before = await documentService.manifest(userId, bookId);
    await expect(db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('proser.document_book', ${String(bookId)}, true)`;
      await tx.scene.update({ where: { id: sceneId }, data: { prose: 'Bypass' } });
    })).rejects.toThrow('PROSER_DOCUMENT_PROJECTION_MISMATCH');
    await expect(db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('proser.document_book', ${String(bookId)}, true)`;
      await tx.bookDocumentHead.update({ where: { bookId }, data: { manifest: { schemaVersion: 1, scenes: [] } } });
    })).rejects.toThrow('PROSER_DOCUMENT_HEAD_MISMATCH');
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(before.revisionId);
  });
  test('rejects old book creation without authority and accepts service creation atomically', async () => {
    await expect(db().book.create({ data: { userId, title: 'Stale create' } })).rejects.toThrow('PROSER_DOCUMENT_HEAD_MISMATCH');
    const receipt = await documentService.createBook(userId, { title: 'Complete create' }, randomUUID());
    expect((await documentService.manifest(userId, receipt.result.id)).revisionId).toBe(receipt.revisionId);
    await db().$executeRawUnsafe('UPDATE proser_document_enforcement SET enabled=false');
    const createdId = receipt.result.id;
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId: createdId } }); await db().documentOperation.deleteMany({ where: { bookId: createdId } }); await db().bookDocumentHead.deleteMany({ where: { bookId: createdId } }); await db().bookDocumentRevision.deleteMany({ where: { bookId: createdId } }); await db().bookDocumentScopeRevision.deleteMany({ where: { bookId: createdId } }); await db().book.delete({ where: { id: createdId } });
  });
  test('referenced assets and immutable publication bytes retain identity and digest', async () => {
    const sha256 = 'a'.repeat(64);
    const image = await db().imageAsset.create({ data: { userId, bookId, name: 'fixture.png', url: '/images/fixture.png', configJson: JSON.stringify({ sha256 }) } });
    const source = await documentService.read(userId, bookId, sceneId);
    source.document.blocks.push({ type: 'image', id: randomUUID(), assetId: image.id, sha256, alt: 'Protected object', width: 100, height: 100 });
    await documentService.commit(userId, bookId, { schemaVersion: 1, operationId: randomUUID(), expectedRevisionId: source.bookRevisionId, scenes: [{ sceneId, expectedRevisionId: source.revisionId, document: source.document }] });
    await expect(db().imageAsset.delete({ where: { id: image.id } })).rejects.toThrow('PROSER_DOCUMENT_ASSET_REFERENCED');
    await expect(db().imageAsset.update({ where: { id: image.id }, data: { configJson: JSON.stringify({ sha256: 'b'.repeat(64) }) } })).rejects.toThrow('PROSER_DOCUMENT_ASSET_IMMUTABLE');
    await db().imageAsset.update({ where: { id: image.id }, data: { configJson: JSON.stringify({ sha256, sourceUpdateAvailable: 'new-reference' }) } });
    const artifact = await db().documentPublicationArtifact.create({ data: { id: randomUUID(), publicationId: randomUUID(), userId, bookId, sha256, byteLength: 3, mediaType: 'text/plain', filename: 'fixture.txt', bytes: Uint8Array.from([1, 2, 3]), provenance: {} } });
    await expect(db().documentPublicationArtifact.update({ where: { id: artifact.id }, data: { bytes: Uint8Array.from([3, 2, 1]) } })).rejects.toThrow('PROSER_DOCUMENT_IMMUTABLE');
  });

  test('inline images in body, cells and scene stories project protected markers and retain historical asset identity', async () => {
    const sha256='c'.repeat(64);const asset=await db().imageAsset.create({data:{userId,bookId,name:'inline.png',url:'/images/inline.png',configJson:JSON.stringify({sha256})}});
    const source=await documentService.read(userId,bookId,sceneId);const paragraph=source.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs.push({id:randomUUID(),text:'',style:{},inlineImage:{assetId:asset.id,sha256,alt:'Inline image',width:60,height:60}});
    const scope=await documentService.scope(userId,bookId,'layout');const layout=structuredClone(scope.content);const header=documentFromText('',randomUUID);const headerParagraph=header.blocks[0];if(headerParagraph.type!=='paragraph')throw new Error('fixture');headerParagraph.runs=[{id:randomUUID(),text:'',style:{},inlineImage:{assetId:asset.id,sha256,alt:'Header image',width:60,height:60}}];layout.headerFooterStories=[{id:randomUUID(),owner:'book',kind:'header',document:header}];
    const layoutReceipt=await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,expectedScopes:{layout:scope.revisionId},payload:{command:'fixture-owned-inline-header'}},async()=>({result:{},layout}));
    await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:layoutReceipt.revisionId,scenes:[{sceneId,expectedRevisionId:source.revisionId,document:source.document}]});
    const current=await documentService.read(userId,bookId,sceneId);expect(current.projection.text).toContain('\uFFFC');await expect(db().imageAsset.delete({where:{id:asset.id}})).rejects.toThrow('ASSET_REFERENCED');
    const cell=structuredClone(paragraph);cell.id=randomUUID();for(const run of cell.runs)run.id=randomUUID();current.document.blocks=[{type:'table',id:randomUUID(),widths:[300],rows:[{id:randomUUID(),cells:[{id:randomUUID(),paragraphs:[cell]}]}]}];
    const result=await db().$queryRaw<Array<{text:string}>>`SELECT proser_document_projection(${JSON.stringify(current.document)}::jsonb) AS text`;expect(result[0].text).toBe(projectDocument(current.document).text);
  });

  test('book and chapter header/footer inline assets remain protected after their stories are superseded', async () => {
    const scope=await documentService.scope(userId,bookId,'layout');const source=await documentService.read(userId,bookId,sceneId);const chapterId=(await db().scene.findUniqueOrThrow({where:{id:sceneId}})).chapterId;
    const layout=structuredClone(scope.content);const assets:Array<{id:number}>=[];
    for(const name of ['book-story.png','chapter-story.png'])assets.push(await db().imageAsset.create({data:{userId,bookId,name,url:'/images/'+name,configJson:JSON.stringify({sha256:'d'.repeat(64)})}}));
    const story=(index:number)=>[{type:'paragraph' as const,id:randomUUID(),style:{},runs:[{id:randomUUID(),text:'',style:{},inlineImage:{assetId:assets[index].id,sha256:'d'.repeat(64),alt:'Story image',width:50,height:50}}]}];
    layout.book.header=story(0);layout.chapters[String(chapterId)]={...structuredClone(layout.book),header:[],footer:story(1)};
    const first=await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,expectedScopes:{layout:scope.revisionId},payload:{kind:'isolated-layout-stories'}},async()=>({result:{changed:'layout'},layout}));
    for(const asset of assets)await expect(db().imageAsset.delete({where:{id:asset.id}})).rejects.toThrow('ASSET_REFERENCED');
    const cleared=structuredClone(layout);cleared.book.header=[];cleared.chapters[String(chapterId)].footer=[];
    await documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:first.revisionId,expectedScopes:{layout:first.manifest.scopes!.layout.revisionId},payload:{kind:'isolated-cleared-stories'}},async()=>({result:{changed:'layout'},layout:cleared}));
    for(const asset of assets)await expect(db().imageAsset.delete({where:{id:asset.id}})).rejects.toThrow('ASSET_REFERENCED');
  });

  test('PostgreSQL matches every final paragraph split/join state in body and table cells', async () => {
    for (const kind of ['paragraphSplit','paragraphJoin'] as const) for (const status of ['pending','accepted','rejected'] as const) {
      const document = documentFromText('left\n\nright', randomUUID); const left=document.blocks[0]; const right=document.blocks[1]; if(left.type!=='paragraph'||right.type!=='paragraph')throw new Error('fixture');
      left.boundaryChangeId='boundary';document.changes.push({id:'boundary',kind,status,targetBlockIds:[left.id,right.id],targetRunIds:[],authorId:userId,authorName:'fixture',createdAt:new Date().toISOString(),origin:'ai'});
      const query=async(body:ProserDocument)=>{const result=await db().$queryRaw<Array<{text:string}>>`SELECT proser_document_projection(${JSON.stringify(body)}::jsonb) AS text`;expect(result[0].text).toBe(projectDocument(body).text);};
      await query(document); document.blocks=[{type:'table',id:randomUUID(),widths:[100],rows:[{id:randomUUID(),cells:[{id:randomUUID(),paragraphs:[left,right]}]}]}];await query(document);
    }
  });

  test('PostgreSQL final projection matches paragraphs, cells, Unicode, pending revisions and objects', async () => {
    const document: ProserDocument = documentFromText('😀é\n\noriginal', randomUUID);
    const first = document.blocks[0]; if (first.type !== 'paragraph') throw new Error('fixture');
    first.runs.push({ id: randomUUID(), text: ' pending', style: {}, changeId: 'insert' });
    first.runs.push({ id: randomUUID(), text: ' removed', style: {}, changeId: 'delete' });
    document.changes.push({ id: 'insert', kind: 'insertion', status: 'pending', targetRunIds: [first.runs[1].id], authorId: userId, authorName: 'fixture', createdAt: new Date().toISOString(), origin: 'ai' });
    document.changes.push({ id: 'delete', kind: 'deletion', status: 'pending', targetRunIds: [first.runs[2].id], authorId: userId, authorName: 'fixture', createdAt: new Date().toISOString(), origin: 'ai' });
    document.blocks.push({ type: 'table', id: randomUUID(), widths: [400], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [{ type: 'paragraph', id: randomUUID(), style: {}, runs: [{ id: randomUUID(), text: 'a\u00a0b\u2028c', style: {} }] }] }] }] });
    const result = await db().$queryRaw<Array<{ text: string; words: number }>>`SELECT proser_document_projection(${JSON.stringify(document)}::jsonb) AS text, proser_document_word_count(proser_document_projection(${JSON.stringify(document)}::jsonb)) AS words`;
    expect(result[0]).toEqual({ text: projectDocument(document).text, words: projectDocument(document).wordCount });
  });
});
