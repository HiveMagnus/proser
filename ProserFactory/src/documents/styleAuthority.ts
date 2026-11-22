import {createHash} from 'node:crypto';
import type {Prisma} from '@prisma/client';
import {DocumentError} from './errors';
import {readScope} from './scopes';
import {canonicalDocument,type DocumentManifest,type ProserDocument} from './model';
import {parseCommentCandidateDocument} from './commentAnchors';
import {validateDocument} from './validation';
import {validateDocumentStyleReferences,validateStyleDefinitions,type DocumentStyleDefinitions} from './style-model';
export function assertOwnedStyleReferences(document:ProserDocument,definitions:DocumentStyleDefinitions){
 try{validateStyleDefinitions(definitions);validateDocumentStyleReferences(document,definitions);}catch(error){throw new DocumentError('DOCUMENT_STYLE_INVALID',error instanceof Error?error.message:'Named style definitions or references are invalid.',409);}
}
export async function validateManifestSceneStyles(tx:Prisma.TransactionClient,bookId:number,manifest:DocumentManifest,definitions:DocumentStyleDefinitions,replacements:Map<number,ProserDocument>=new Map()){
 for(const ref of [...manifest.scenes,...(manifest.retiredScenes??[])]){
  const replacement=replacements.get(ref.sceneId);if(replacement){assertOwnedStyleReferences(parseCommentCandidateDocument(replacement),definitions);continue;}
  const source=await tx.sceneDocumentRevision.findFirst({where:{bookId,sceneId:ref.sceneId,id:ref.revisionId},select:{contentHash:true,document:true}});
  if(!source||source.contentHash!==ref.contentHash)throw new DocumentError('DOCUMENT_REVISION_INVALID','Named-style validation source is unavailable.',503);
  const document=validateDocument(source.document);if(createHash('sha256').update(canonicalDocument(document)).digest('hex')!==ref.contentHash)throw new DocumentError('DOCUMENT_REVISION_INVALID','Named-style source checksum does not match its immutable manifest.',503);
  assertOwnedStyleReferences(document,definitions);
 }
}
export async function validateSceneOwnedStyles(tx:Prisma.TransactionClient,bookId:number,manifest:DocumentManifest,document:ProserDocument){
 if(!manifest.scopes)throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED','Owned style definitions require a captured layout scope.',409);
 const layout=await readScope(tx,bookId,'layout',manifest.scopes.layout);assertOwnedStyleReferences(document,layout.styles);
}
