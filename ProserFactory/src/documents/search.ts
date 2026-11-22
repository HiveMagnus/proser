import {createHash} from 'node:crypto';
import {z} from 'zod';
import {databaseService} from '@/lib/database';
import {documentService} from './service';
import {readScope} from './scopes';
import {orderedSceneReferences} from './scope-model';
import {canonicalDocument,type DocumentManifest,type DocumentAnchor,type DocumentSpan} from './model';
import {readSearchIndexPayload,searchGrams,SEARCH_INDEX_VERSION} from './searchIndex';
import {normalizedSearchText,searchExcerpt} from './searchText';
export {normalizedSearchText} from './searchText';
import {DocumentError} from './errors';
import {SEARCH_NORMALIZATION} from './searchCaseFold';
import type {DocumentSearchRequest,DocumentSearchResponse,DocumentSearchHit} from './search-model';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>sha(canonicalDocument(value));
const cursorSchema=z.object({version:z.literal(1),userId:z.number().int().positive(),bookId:z.number().int().positive(),revisionId:z.string().uuid(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),queryHash:z.string().regex(/^[a-f0-9]{64}$/),sceneIndex:z.number().int().nonnegative(),offset:z.number().int().nonnegative()}).strict();
type SearchCursor=z.infer<typeof cursorSchema>;
function cursor(value:SearchCursor){return Buffer.from(JSON.stringify(value)).toString('base64url');}
function decode(value:string):SearchCursor{try{if(value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('encoding');return cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));}catch{throw new DocumentError('DOCUMENT_SEARCH_CURSOR_INVALID','Invalid search cursor; start a new query.',422);}}
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
/** Revision-bound durable index. PostgreSQL rejects noncandidate projections
 * before fetching payloads; no canonical scene bodies are read during search. */
export async function searchOwnedDocument(userId:number,bookId:number,input:DocumentSearchRequest):Promise<DocumentSearchResponse>{
 const query=z.object({q:z.string().min(1).max(512),caseSensitive:z.boolean().optional(),limit:z.number().int().min(1).max(100).optional(),cursor:z.string().max(2048).optional()}).strict().parse(input);
 if(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(query.q)||Array.from(segmenter.segment(query.q)).length>128)throw new DocumentError('DOCUMENT_SEARCH_QUERY_INVALID','Search supports at most 128 valid Unicode graphemes.',422);
 const caseSensitive=query.caseSensitive??false;const limit=query.limit??20;const queryHash=digest({q:query.q,caseSensitive,normalization:SEARCH_NORMALIZATION});const needle=normalizedSearchText(query.q,caseSensitive).text;
 const current=await documentService.manifest(userId,bookId);const retained=query.cursor?decode(query.cursor):undefined;
 if(retained&&(retained.userId!==userId||retained.bookId!==bookId||retained.queryHash!==queryHash))throw new DocumentError('DOCUMENT_SEARCH_CURSOR_CONFLICT','Search cursor belongs to a different owner, book or query.',409);
 let manifest:DocumentManifest=current;let revisionId=current.revisionId;let contentHash=current.contentHash;
 if(retained){const row=await databaseService.client.bookDocumentRevision.findFirst({where:{id:retained.revisionId,bookId}});if(!row||row.contentHash!==retained.contentHash||digest(row.manifest)!==retained.contentHash)throw new DocumentError('DOCUMENT_SEARCH_SOURCE_INVALID','Pinned search manifest is missing or checksum-invalid.',409);manifest=row.manifest as unknown as DocumentManifest;revisionId=row.id;contentHash=row.contentHash;}
 if(!manifest.scopes)throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED','Canonical scopes are required before searching.',409);
 const structure=await readScope(databaseService.client,bookId,'structure',manifest.scopes.structure);const references=orderedSceneReferences(manifest.scenes,structure).filter((scene)=>!scene.deletedAt);
 // Check every lightweight revision reference before yielding any results.
 // A missing historical row is an explicit recoverable outage, never a scan or
 // a silently incomplete answer. Ownership was checked before any index read.
 for(let index=0;index<references.length;index+=256){const part=references.slice(index,index+256);const rows=await databaseService.client.sceneDocumentSearchIndex.findMany({where:{bookId,sceneRevisionId:{in:part.map((ref)=>ref.revisionId)}},select:{sceneRevisionId:true,sceneId:true,contentHash:true,wordCount:true,normalization:true}});const byId=new Map(rows.map((row)=>[row.sceneRevisionId,row]));for(const ref of part){const row=byId.get(ref.revisionId);if(!row)throw new DocumentError('DOCUMENT_SEARCH_INDEX_INCOMPLETE','Pinned revisions need search indexing. Recover through the owned search-index endpoint, then retry this exact query.',503);if(row.sceneId!==ref.sceneId||row.contentHash!==ref.contentHash||row.wordCount!==ref.wordCount||row.normalization!==SEARCH_NORMALIZATION)throw new DocumentError('DOCUMENT_SEARCH_INDEX_INVALID','Index metadata differs from its immutable manifest; preserve it for reconciliation.',503);}}
 let sceneIndex=retained?.sceneIndex??0;let offset=retained?.offset??0;if(sceneIndex>references.length||(sceneIndex===references.length&&offset))throw new DocumentError('DOCUMENT_SEARCH_CURSOR_INVALID','Cursor is outside the pinned manifest.',422);
 const grams=searchGrams(needle).grams;const sqlNeedle=needle.replace(/[\\%_]/g,(character)=>'\\'+character);const candidates=new Map<string,number>();let candidateScanEnd=sceneIndex;
 // Candidate payload sizes only, in bounded reference batches. Exact normalized
 // substring filtering excludes gram false positives inside PostgreSQL.
 for(let index=sceneIndex;index<references.length;index+=256){const part=references.slice(index,index+256);const rows=await databaseService.client.sceneDocumentSearchIndex.findMany({where:{bookId,sceneRevisionId:{in:part.map((ref)=>ref.revisionId)},...(caseSensitive?{sensitiveText:{contains:sqlNeedle},OR:[{sensitiveOverflow:true},{sensitiveGrams:{hasEvery:grams}}]}:{foldedText:{contains:sqlNeedle},OR:[{foldedOverflow:true},{foldedGrams:{hasEvery:grams}}]})},select:{sceneRevisionId:true,payloadBytes:true}});for(const row of rows)candidates.set(row.sceneRevisionId,row.payloadBytes);candidateScanEnd=index+part.length;if(candidates.size>=9)break;}
 const hits:DocumentSearchHit[]=[];let scannedScenes=0;let decodedBytes=0;let nextCursor:string|undefined;
 const resume=()=>cursor({version:1,userId,bookId,revisionId,contentHash,queryHash,sceneIndex,offset});
 while(sceneIndex<references.length){
  if(sceneIndex>=candidateScanEnd){nextCursor=resume();break;}
  const reference=references[sceneIndex]!;const payloadBytes=candidates.get(reference.revisionId);
  if(payloadBytes===undefined){sceneIndex++;offset=0;continue;}
  if(scannedScenes>=8||(scannedScenes>0&&decodedBytes+payloadBytes>4*1024*1024)){nextCursor=resume();break;}
  const row=await databaseService.client.sceneDocumentSearchIndex.findUnique({where:{sceneRevisionId:reference.revisionId},select:{bookId:true,sceneId:true,contentHash:true,projectionSha256:true,payload:true,payloadHash:true,payloadBytes:true}});
  if(!row||row.bookId!==bookId||row.sceneId!==reference.sceneId||row.contentHash!==reference.contentHash)throw new DocumentError('DOCUMENT_SEARCH_INDEX_INCOMPLETE','Immutable search evidence is missing; recover indexing and retry.',503);
  const projection=readSearchIndexPayload(row);scannedScenes++;decodedBytes+=row.payloadBytes;const searchable=normalizedSearchText(projection.text,caseSensitive);
  if(offset>searchable.text.length||!searchable.boundaries.has(offset))throw new DocumentError('DOCUMENT_SEARCH_CURSOR_INVALID','Cursor is not a complete source grapheme boundary.',422);
  const projectionSha256=row.projectionSha256;
  let position=searchable.text.indexOf(needle,offset);
  while(position>=0){
   const end=position+needle.length;const from=searchable.boundaries.get(position);const to=searchable.boundaries.get(end);
   if(from===undefined||to===undefined){position=searchable.text.indexOf(needle,position+1);continue;}
   const locations:DocumentSpan[]=projection.spans.filter((span)=>span.start<to&&span.end>from).map((span)=>({...span,editable:span.editable,start:Math.max(from,span.start),end:Math.min(to,span.end)}));
   const anchors:DocumentAnchor[]=locations.flatMap((span)=>{if(!span.runId)return [];const original=projection.spans.find((entry)=>entry.runId===span.runId&&entry.start<=span.start&&entry.end>=span.end);if(!original)return [];const image=projection.imageRunIds.has(span.runId);const start=image?0:span.start-original.start;const finish=image?0:span.end-original.start;return [{blockId:span.blockId,runId:span.runId,start,end:finish,sourceText:image?'':projection.text.slice(span.start,span.end)}];});
   hits.push({id:`${reference.revisionId}:${from}:${to}`,sceneId:reference.sceneId,sceneNumber:reference.sceneNumber,chapterId:reference.chapterId,wordCount:reference.wordCount,sceneRevisionId:reference.revisionId,sceneContentHash:reference.contentHash,projectionSha256,from,to,sourceText:projection.text.slice(from,to),...searchExcerpt(projection.text,from,to,searchable),anchors,locations,editable:locations.every((span)=>span.editable)});
   offset=end;if(hits.length>=limit){nextCursor=resume();break;}
   position=searchable.text.indexOf(needle,end);
  }
  if(nextCursor)break;sceneIndex++;offset=0;
 }
 return {schemaVersion:1,sourceBookRevisionId:revisionId,sourceContentHash:contentHash,currentBookRevisionId:current.revisionId,stale:revisionId!==current.revisionId,projection:'final',normalization:SEARCH_NORMALIZATION,index:SEARCH_INDEX_VERSION,query:query.q,caseSensitive,hits,scannedScenes,decodedBytes,complete:!nextCursor,...(nextCursor?{nextCursor}:{})};
}
