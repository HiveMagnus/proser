import { randomUUID,createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { importCreativeImage } from '@/services/creativeImportService';
import { booksService } from '@/services/booksService';
import { BookRepository } from '@/core/persistence/bookRepository';
describe('creative cover and repository writer authority',()=>{
 const db=()=>databaseService.client;let userId:number;let bookId:number;let filename:string|undefined;const previous=process.env.DOCUMENT_AUTHORITY_ENABLED;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';userId=(await db().user.create({data:{githubId:`creative-writer-${randomUUID()}`,username:'Creative writer fixture'}})).id;});
 beforeEach(async()=>{bookId=(await documentService.createBook(userId,{title:'Original title'},randomUUID())).result.id;filename=undefined;});
 afterEach(async()=>{await db().imageAsset.deleteMany({where:{bookId}});await db().documentLegacyRevisionMapping.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});if(filename)await unlink(path.resolve('public/images',filename)).catch(()=>undefined);});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});if(previous===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=previous;});
 test('creative setCover requires source revision and exact recovery preserves newer metadata without duplicate assets',async()=>{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZp0AAAAASUVORK5CYII=','base64');const digest=createHash('sha256').update(bytes).digest('hex');
  const input={bookId,source:'nova',sourceId:randomUUID(),sourceRevision:'r1',artifactKey:'cover',sha256:digest,bytesBase64:bytes.toString('base64'),visibility:'private',license:'Disposable fixture',provenance:{fixture:true},setCover:true};
  await expect(importCreativeImage(userId,input,'fixture-actor','request-original')).rejects.toMatchObject({status:428});
  const head=await documentService.manifest(userId,bookId);const guarded={...input,documentPreconditions:{operationId:randomUUID(),expectedRevisionId:head.revisionId,expectedScopes:{structure:head.scopes!.structure.revisionId}}};
  const first=await importCreativeImage(userId,guarded,'fixture-actor','request-original');filename=first.name;expect((await db().book.findUniqueOrThrow({where:{id:bookId}})).selectedImageId).toBe(first.id);
  const after=await documentService.manifest(userId,bookId);await booksService.updateBook(userId,bookId,{title:'Newer title'},{operationId:randomUUID(),expectedRevisionId:after.revisionId,expectedScopes:{structure:after.scopes!.structure.revisionId}});
  expect(JSON.parse(JSON.stringify(await importCreativeImage(userId,guarded,'fixture-actor','request-original')))).toEqual(JSON.parse(JSON.stringify(first)));expect(await db().imageAsset.count({where:{bookId}})).toBe(1);expect((await db().book.findUniqueOrThrow({where:{id:bookId}})).title).toBe('Newer title');
 });
 test('repository update cannot bypass revision checks when authority is active',async()=>{
  const repository=new BookRepository(db());await expect(repository.updatePatch(userId,bookId,{title:'Unguarded'})).rejects.toMatchObject({status:428});
  const head=await documentService.manifest(userId,bookId);const expected={operationId:randomUUID(),expectedRevisionId:head.revisionId,expectedScopes:{structure:head.scopes!.structure.revisionId}};
  const first=await repository.updatePatch(userId,bookId,{title:'Guarded'},expected);expect(first?.title).toBe('Guarded');expect(JSON.parse(JSON.stringify(await repository.updatePatch(userId,bookId,{title:'Guarded'},expected)))).toEqual(JSON.parse(JSON.stringify(first)));await expect(repository.updatePatch(userId,bookId,{title:'Stale'},{...expected,operationId:randomUUID()})).rejects.toMatchObject({status:412});
 });
});
