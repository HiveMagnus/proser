import {createHash} from 'node:crypto';
import type {Prisma} from '@prisma/client';
import {canonicalDocument,paragraphsOf,type ProserDocument,type DocumentManifest} from './model';
import {validateDocument} from './validation';
import {DocumentError} from './errors';
const hash=(value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
export function documentBodyIdentities(document:ProserDocument):Set<string>{
 const ids=new Set<string>();for(const block of document.blocks){ids.add(block.id);if(block.type==='table')for(const row of block.rows){ids.add(row.id);for(const cell of row.cells)ids.add(cell.id);}}
 for(const paragraph of paragraphsOf(document)){ids.add(paragraph.id);for(const run of paragraph.runs)ids.add(run.id);}
 for(const change of document.changes)ids.add(change.id);for(const comment of document.comments)ids.add(comment.id);return ids;
}
/** Restoring one old source after a move must never duplicate identities still
 * owned by an unaffected scene. Paired restoration checks the final scope set. */
export async function assertSceneRestorationIdentityIsolation(tx:Prisma.TransactionClient,bookId:number,restored:ProserDocument,affectedSceneIds:ReadonlySet<number>){
 const head=await tx.bookDocumentHead.findUnique({where:{bookId}});if(!head)throw new DocumentError('DOCUMENT_SOURCE_STALE','Owned restoration head is unavailable.',412);
 const manifest=head.manifest as unknown as DocumentManifest,ids=documentBodyIdentities(restored);
 // One immutable body at a time; never load the complete book into memory.
 for(const reference of manifest.scenes.filter(scene=>!scene.deletedAt&&!affectedSceneIds.has(scene.sceneId))){
  const row=await tx.sceneDocumentRevision.findFirst({where:{id:reference.revisionId,sceneId:reference.sceneId,bookId}});
  if(!row||row.contentHash!==reference.contentHash||hash(row.document)!==reference.contentHash)throw new DocumentError('DOCUMENT_REVISION_INVALID','Restoration identity source is checksum-invalid.',503);
  if([...documentBodyIdentities(validateDocument(row.document))].some(id=>ids.has(id)))throw new DocumentError('DOCUMENT_SCOPE_RESTORE_INCOMPATIBLE','A restored identity still belongs to another scene; restore all affected scopes atomically.',409,{sceneId:reference.sceneId});
 }
}
