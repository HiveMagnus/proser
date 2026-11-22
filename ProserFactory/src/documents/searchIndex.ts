import {createHash} from 'node:crypto';
import {Prisma,type PrismaClient} from '@prisma/client';
import {canonicalDocument,projectDocument,paragraphsOf,type ProserDocument,type DocumentSpan} from './model';
import {validateDocument} from './validation';
import {normalizedSearchText} from './searchText';
import {SEARCH_NORMALIZATION} from './searchCaseFold';
import type {DocumentSearchIndexRecoveryResponse} from './search-model';
import {DocumentError} from './errors';
export const SEARCH_INDEX_VERSION='revision-gin-v1' as const;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const MAX_GRAMS=65536;
/** Capped postings prevent adversarial high-entropy documents from expanding
 * without bound. Overflow uses exact database text filtering, never omission. */
export function searchGrams(text:string,allLengths=false){
 const points=Array.from(text);const sizes=allLengths?[1,2,3]:[Math.min(3,points.length)];const grams=new Set<string>();
 for(const size of sizes)for(let index=0;index+size<=points.length;index++){grams.add(`${size}:${points.slice(index,index+size).join('')}`);if(grams.size>MAX_GRAMS)return {grams:[],overflow:true};}
 return {grams:[...grams].sort(),overflow:false};
}
type SpanTuple=[number,number,string,string|null,string|null,boolean];
export interface SearchIndexPayload {text:string;spans:SpanTuple[];imageRunIds:string[]}
export function buildSceneSearchIndex(document:ProserDocument){
 const projection=projectDocument(document);const paragraphs=paragraphsOf(document);const pending=document.changes.filter((change)=>change.status==='pending');
 const protectedParagraphs=new Set(paragraphs.filter((paragraph)=>pending.some((change)=>change.id===paragraph.changeId||change.id===paragraph.boundaryChangeId||change.targetBlockIds?.includes(paragraph.id)||change.targetRunIds.some((id)=>paragraph.runs.some((run)=>run.id===id)))).map((paragraph)=>paragraph.id));
 const payload:SearchIndexPayload={text:projection.text,spans:projection.spans.map((span)=>[span.start,span.end,span.blockId,span.runId??null,span.cellId??null,span.editable&&!protectedParagraphs.has(span.blockId)]),imageRunIds:paragraphs.flatMap((paragraph)=>paragraph.runs.filter((run)=>run.inlineImage).map((run)=>run.id))};
 const payloadText=canonicalDocument(payload);const payloadBytes=Buffer.byteLength(payloadText);if(payloadBytes>4*1024*1024)throw new DocumentError('DOCUMENT_SEARCH_INDEX_SIZE','Derived search evidence exceeds the per-scene limit.',422);
 const sensitiveText=normalizedSearchText(projection.text,true).text;const foldedText=normalizedSearchText(projection.text,false).text;const sensitive=searchGrams(sensitiveText,true);const folded=searchGrams(foldedText,true);
 return {normalization:SEARCH_NORMALIZATION,wordCount:projection.wordCount,projectionSha256:sha(projection.text),payload:payload as unknown as Prisma.InputJsonValue,payloadHash:sha(payloadText),payloadBytes,sensitiveText,foldedText,sensitiveGrams:sensitive.grams,foldedGrams:folded.grams,sensitiveOverflow:sensitive.overflow,foldedOverflow:folded.overflow};
}
export async function insertSceneSearchIndex(tx:Prisma.TransactionClient|PrismaClient,source:{revisionId:string;bookId:number;sceneId:number;contentHash:string;document:ProserDocument}){
 if(sha(canonicalDocument(source.document))!==source.contentHash)throw new DocumentError('DOCUMENT_SEARCH_SOURCE_INVALID','Search source hash does not match immutable content.',409);
 const data=buildSceneSearchIndex(source.document);
 const previous=await tx.sceneDocumentSearchIndex.findUnique({where:{sceneRevisionId:source.revisionId}});
 if(previous){if(previous.bookId!==source.bookId||previous.sceneId!==source.sceneId||previous.contentHash!==source.contentHash||previous.normalization!==SEARCH_NORMALIZATION||previous.payloadHash!==data.payloadHash||previous.projectionSha256!==data.projectionSha256||previous.wordCount!==data.wordCount||previous.sensitiveText!==data.sensitiveText||previous.foldedText!==data.foldedText||previous.sensitiveOverflow!==data.sensitiveOverflow||previous.foldedOverflow!==data.foldedOverflow||canonicalDocument(previous.sensitiveGrams)!==canonicalDocument(data.sensitiveGrams)||canonicalDocument(previous.foldedGrams)!==canonicalDocument(data.foldedGrams)||sha(canonicalDocument(previous.payload))!==data.payloadHash)throw new DocumentError('DOCUMENT_SEARCH_INDEX_INVALID','Existing search evidence differs from its immutable revision; preserve it and reconcile explicitly.',503);return false;}
 // createMany(skipDuplicates) is safe for simultaneous recovery: verify the
 // winning immutable row before acknowledging the derived operation.
 const inserted=await tx.sceneDocumentSearchIndex.createMany({data:[{sceneRevisionId:source.revisionId,bookId:source.bookId,sceneId:source.sceneId,contentHash:source.contentHash,...data}],skipDuplicates:true});
 if(!inserted.count)return insertSceneSearchIndex(tx,source);return true;
}
export function readSearchIndexPayload(row:{payload:Prisma.JsonValue;payloadHash:string;projectionSha256:string;payloadBytes:number}){
 const serialized=canonicalDocument(row.payload);if(Buffer.byteLength(serialized)!==row.payloadBytes||sha(serialized)!==row.payloadHash)throw new DocumentError('DOCUMENT_SEARCH_INDEX_INVALID','Search payload checksum mismatch; preserve evidence and reconcile.',503);
 const payload=row.payload as unknown as SearchIndexPayload;if(typeof payload.text!=='string'||sha(payload.text)!==row.projectionSha256||!Array.isArray(payload.spans)||!Array.isArray(payload.imageRunIds))throw new DocumentError('DOCUMENT_SEARCH_INDEX_INVALID','Search projection checksum mismatch.',503);
 const spans:DocumentSpan[]=payload.spans.map(([start,end,blockId,runId,cellId,editable])=>({start,end,blockId,...(runId?{runId}:{}),...(cellId?{cellId}:{}),editable}));
 return {text:payload.text,spans,imageRunIds:new Set(payload.imageRunIds)};
}
/** Bounded immutable historical recovery. The caller supplies an owned scope;
 * this never changes heads or rewrites a revision/original. Cursor is ordered
 * by revision UUID, allowing exact restart independently of current heads. */
export async function backfillSceneSearchIndexes(tx:Prisma.TransactionClient|PrismaClient,bookId:number,options:{after?:string;limit?:number;apply?:boolean}={}):Promise<DocumentSearchIndexRecoveryResponse>{
 const limit=Math.min(32,Math.max(1,options.limit??8));const rows=await tx.sceneDocumentRevision.findMany({where:{bookId,...(options.after?{id:{gt:options.after}}:{})},orderBy:{id:'asc'},take:limit+1,select:{id:true,sceneId:true,contentHash:true}});
 let inserted=0;let verified=0;let missing=0;
 for(const row of rows.slice(0,limit)){const existing=await tx.sceneDocumentSearchIndex.findUnique({where:{sceneRevisionId:row.id},select:{sceneRevisionId:true}});if(!existing)missing++;if(!options.apply)continue;
  const source=await tx.sceneDocumentRevision.findUniqueOrThrow({where:{id:row.id},select:{document:true}});if(await insertSceneSearchIndex(tx,{revisionId:row.id,bookId,sceneId:row.sceneId,contentHash:row.contentHash,document:validateDocument(source.document)}))inserted++;else verified++;
 }
 return {schemaVersion:1 as const,index:SEARCH_INDEX_VERSION,normalization:SEARCH_NORMALIZATION,scanned:Math.min(limit,rows.length),missing,inserted,verified,complete:rows.length<=limit,...(rows.length>limit?{nextAfter:rows[limit-1]!.id}:{})};
}
/** One database coverage check, no canonical body decode or browser loading. */
export async function searchIndexReadiness(tx:Prisma.TransactionClient|PrismaClient){
 const rows=await tx.$queryRaw<Array<{missing:bigint}>>(Prisma.sql`SELECT count(*) AS missing FROM book_document_heads h CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.manifest->'scenes','[]'::jsonb) || coalesce(h.manifest->'retiredScenes','[]'::jsonb)) r LEFT JOIN scene_document_search_indexes i ON i.scene_revision_id=r->>'revisionId' AND i.book_id=h.book_id AND i.scene_id=(r->>'sceneId')::integer AND i.content_hash=r->>'contentHash' AND i.word_count=(r->>'wordCount')::integer AND i.normalization=${SEARCH_NORMALIZATION} WHERE i.scene_revision_id IS NULL`);return Number(rows[0]?.missing??1)===0;
}
