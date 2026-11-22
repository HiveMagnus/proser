import {createHash} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {canonicalDocument,type DocumentManifest} from './model';
import type {BookLayoutSnapshot,StructureSnapshot} from './scope-model';
import {readScope} from './scopes';
import {DocumentError} from './errors';
const digest=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
type Client=Prisma.TransactionClient|PrismaClient;
export interface FrozenSceneSource {bookRevisionId:string;sceneRevisionId:string;contentHash:string;bookLayoutHash:string}
function qualifiedContext(bookId:number,sceneId:number,manifest:DocumentManifest,structure:StructureSnapshot,layout:BookLayoutSnapshot){
 const ref=manifest.scenes.find((scene)=>scene.sceneId===sceneId&&!scene.deletedAt);const scene=structure.scenes.find((entry)=>entry.id===sceneId&&!entry.deletedAt);const chapter=structure.chapters.find((entry)=>entry.id===scene?.chapterId&&!entry.deletedAt);const act=structure.acts.find((entry)=>entry.id===chapter?.actId&&!entry.deletedAt);
 if(!ref||!scene||!chapter||!act||ref.chapterId!==scene.chapterId||ref.sceneNumber!==scene.sceneNumber)throw new DocumentError('DOCUMENT_TARGET_STALE','The saved target no longer has its complete owned scene/chapter/act container.',409);
 const stories=['header','footer'].map((kind)=>{const story=layout.headerFooterStories?.find((item)=>item.owner==='chapter'&&item.chapterId===chapter.id&&item.kind===kind)??layout.headerFooterStories?.find((item)=>item.owner==='book'&&item.kind===kind);return story??null;});
 return {bookId,actId:act.id,chapterId:chapter.id,sceneId,sceneNumber:scene.sceneNumber,chapterTitle:chapter.title,chapterNumber:chapter.chapterNumber,bookTitle:structure.book.title,layout:layout.chapters[String(chapter.id)]??layout.book,styles:layout.styles,stories};
}
/** Read existing immutable snapshot provenance rather than inventing new fields
 * for old discussions/traces. Body revisions may change for disjoint edits;
 * stable ownership and effective chapter layout may not silently change. */
export async function verifySceneTargetContext(tx:Client,bookId:number,sceneId:number,source:FrozenSceneSource,current:DocumentManifest){
 const original=await tx.bookDocumentRevision.findFirst({where:{id:source.bookRevisionId,bookId},select:{contentHash:true,manifest:true}});
 if(!original||digest(original.manifest)!==original.contentHash)throw new DocumentError('DOCUMENT_TARGET_SOURCE_INVALID','Original target manifest is unavailable or checksum-invalid.',409);
 const manifest=original.manifest as unknown as DocumentManifest;const ref=manifest.scenes.find((scene)=>scene.sceneId===sceneId&&!scene.deletedAt);
 if(!manifest.scopes||!current.scopes||!ref||ref.revisionId!==source.sceneRevisionId||ref.contentHash!==source.contentHash||manifest.scopes.layout.contentHash!==source.bookLayoutHash)throw new DocumentError('DOCUMENT_TARGET_SOURCE_INVALID','Target provenance does not match its original owned manifest.',409);
 const originalStructure=await readScope(tx,bookId,'structure',manifest.scopes.structure);const currentStructure=current.scopes.structure.revisionId===manifest.scopes.structure.revisionId&&current.scopes.structure.contentHash===manifest.scopes.structure.contentHash?originalStructure:await readScope(tx,bookId,'structure',current.scopes.structure);
 const originalLayout=await readScope(tx,bookId,'layout',manifest.scopes.layout);const currentLayout=current.scopes.layout.revisionId===manifest.scopes.layout.revisionId&&current.scopes.layout.contentHash===manifest.scopes.layout.contentHash?originalLayout:await readScope(tx,bookId,'layout',current.scopes.layout);
 if(digest(qualifiedContext(bookId,sceneId,manifest,originalStructure,originalLayout))!==digest(qualifiedContext(bookId,sceneId,current,currentStructure,currentLayout)))throw new DocumentError('DOCUMENT_TARGET_STALE','The target scene/chapter/act membership or resolved layout changed. Prepare a new owned context.',409,{sceneId,sourceBookRevisionId:source.bookRevisionId});
}
