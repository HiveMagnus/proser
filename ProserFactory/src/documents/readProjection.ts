import {databaseService} from '@/lib/database';
import {documentService} from './service';
import {readScope} from './scopes';
import {canonicalDocument,projectDocument,type SceneDocumentReference} from './model';
import {validateDocument} from './validation';
import {DocumentError} from './errors';
import {createHash} from 'node:crypto';
const hash=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
export function includeCompatibilityProse(value:unknown,fallback=false):boolean{if(value===undefined)return fallback;if(value==='1'||value==='true'||value===true)return true;if(value==='0'||value==='false'||value===false)return false;throw new DocumentError('DOCUMENT_PROJECTION_OPTION_INVALID','includeProse must be 1/true or 0/false.',422);}
/** All hierarchy/count/prose fields below identify one immutable manifest.
 * Metadata reads never select scene body JSON or mutable projection columns. */
export async function readCanonicalBookProjection(userId:number,bookId:number,options:{includeProse?:boolean;sceneIds?:number[];chapterId?:number;includeNotes?:boolean}={}){
 const manifest=await documentService.manifest(userId,bookId);if(!manifest.scopes)throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED','Canonical scopes are required before reading structured books.',409);
 const db=databaseService.client;const book=await db.book.findFirst({where:{id:bookId,userId},include:{_count:{select:{notes:true}}}});if(!book)throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND','Book not found.',404);
 const notes=options.includeNotes===false?[]:await db.note.findMany({where:{bookId}});
 const structure=await readScope(db,bookId,'structure',manifest.scopes.structure);const canon=await readScope(db,bookId,'canon',manifest.scopes.canon);
 const revision=await db.bookDocumentRevision.findFirst({where:{id:manifest.revisionId,bookId},select:{contentHash:true,createdAt:true}});if(!revision||revision.contentHash!==manifest.contentHash)throw new DocumentError('DOCUMENT_MANIFEST_INVALID','Source book revision is unavailable.',503);
 const references=new Map(manifest.scenes.map((scene)=>[scene.sceneId,scene]));if(references.size!==manifest.scenes.length||references.size!==structure.scenes.length)throw new DocumentError('DOCUMENT_SCOPE_MANIFEST_INVALID','Scene identities do not exactly cover the immutable structure.',503);const prose=new Map<number,string>();let bytes=0;
 if(options.includeProse){const requested=options.sceneIds?new Set(options.sceneIds):undefined;
  const liveChapterIds=new Set(structure.chapters.filter((chapter)=>!chapter.deletedAt&&structure.acts.some((act)=>act.id===chapter.actId&&!act.deletedAt)).map((chapter)=>chapter.id));
  for(const reference of manifest.scenes.filter((scene)=>!scene.deletedAt&&liveChapterIds.has(scene.chapterId)&&(options.chapterId===undefined||scene.chapterId===options.chapterId)&&(!requested||requested.has(scene.sceneId)))){
   const body=await db.sceneDocumentRevision.findFirst({where:{id:reference.revisionId,sceneId:reference.sceneId,bookId}});if(!body||body.contentHash!==reference.contentHash||hash(body.document)!==reference.contentHash)throw new DocumentError('DOCUMENT_REVISION_INVALID','Projection source checksum is invalid.',503);
   const projection=projectDocument(validateDocument(body.document));if(projection.wordCount!==reference.wordCount)throw new DocumentError('DOCUMENT_PROJECTION_INVALID','Manifest projection totals are invalid.',503);
   bytes+=Buffer.byteLength(projection.text);if(bytes>8*1024*1024)throw new DocumentError('DOCUMENT_PROJECTION_TOO_LARGE','Compatibility prose exceeds 8 MiB; read revision-bound scene documents or request a publication artifact.',413);prose.set(reference.sceneId,projection.text);
  }
 }
 const sceneMetadata=(scene:typeof structure.scenes[number])=>{
  const reference=references.get(scene.id);if(!reference||reference.chapterId!==scene.chapterId||reference.sceneNumber!==scene.sceneNumber||(reference.deletedAt??null)!==scene.deletedAt)throw new DocumentError('DOCUMENT_SCOPE_MANIFEST_INVALID','Scene metadata differs from its immutable manifest.',503);
  return {...scene,bookId,wordCount:reference.wordCount,hasProse:reference.wordCount>0,sourceBookRevisionId:manifest.revisionId,sourceSceneRevisionId:reference.revisionId,sourceRevisionId:reference.revisionId,contentHash:reference.contentHash,projection:'final' as const,...(prose.has(scene.id)?{prose:prose.get(scene.id)!}:{})};
 };
 const scenes=structure.scenes.map(sceneMetadata).sort((left,right)=>left.sceneNumber-right.sceneNumber||left.id-right.id);const chapters=structure.chapters.filter((chapter)=>!chapter.deletedAt).sort((left,right)=>left.chapterNumber-right.chapterNumber||left.id-right.id).map((chapter)=>({...chapter,scenes:scenes.filter((scene)=>scene.chapterId===chapter.id&&!scene.deletedAt)}));
 const acts=structure.acts.filter((act)=>!act.deletedAt).sort((left,right)=>left.actNumber-right.actNumber||left.id-right.id).map((act)=>({...act,chapters:chapters.filter((chapter)=>chapter.actId===act.id)}));
 const active=acts.flatMap((act)=>act.chapters.flatMap((chapter)=>chapter.scenes));const retired=(manifest.retiredScenes??[]).map((reference:SceneDocumentReference)=>({sceneId:reference.sceneId,chapterId:reference.chapterId,sceneNumber:reference.sceneNumber,sourceBookRevisionId:manifest.revisionId,sourceSceneRevisionId:reference.revisionId,contentHash:reference.contentHash,wordCount:reference.wordCount,deletedAt:reference.deletedAt}));
 return {...book,...structure.book,notes,updatedAt:revision.createdAt,acts,codexEntries:canon.entries.filter((entry)=>!entry.deletedAt).map((entry)=>({...entry,bookId})),_count:{acts:acts.length,codexEntries:canon.entries.filter((entry)=>!entry.deletedAt).length,notes:book._count.notes},wordCount:active.reduce((count,scene)=>count+scene.wordCount,0),projection:'final' as const,proseIncluded:Boolean(options.includeProse),sourceBookRevisionId:manifest.revisionId,contentHash:manifest.contentHash,documentRevision:{bookRevisionId:manifest.revisionId,contentHash:manifest.contentHash,scopes:manifest.scopes},tombstones:{acts:structure.acts.filter((act)=>act.deletedAt),chapters:structure.chapters.filter((chapter)=>chapter.deletedAt),scenes:[...scenes.filter((scene)=>scene.deletedAt),...retired]}};
}
export async function readCanonicalScenes(userId:number,bookId:number,options:{includeProse?:boolean;sceneIds?:number[];chapterId?:number}={}){
 const book=await readCanonicalBookProjection(userId,bookId,options);
 const scenes=book.acts.flatMap((act)=>act.chapters.flatMap((chapter)=>chapter.scenes.map((scene)=>({...scene,chapterTitle:chapter.title,chapterNumber:chapter.chapterNumber,actId:act.id,actTitle:act.title,actNumber:act.actNumber}))));
 return {scenes:scenes.filter((scene)=>(options.chapterId===undefined||scene.chapterId===options.chapterId)&&(!options.sceneIds||options.sceneIds.includes(scene.id))),projection:'final' as const,sourceBookRevisionId:book.sourceBookRevisionId,contentHash:book.contentHash};
}
