import {createHash} from 'node:crypto';
import {databaseService} from '@/lib/database';
import {documentService} from './service';
import {DocumentError} from './errors';
import {readScope} from './scopes';
import {orderedSceneReferences} from './scope-model';
import {canonicalDocument,projectDocument,replaceDocumentText,type ProserDocument,type SceneDocumentReference} from './model';
import {validateDocument} from './validation';
import {normalizedSearchText,searchExcerpt} from './searchText';
import {documentReplaceApplySchema,documentReplacePreviewSchema} from './searchValidation';
import type {DocumentReplaceApplyReceipt,DocumentReplaceMatch,DocumentReplacePreviewResponse,DocumentReplaceSkipReason} from './search-model';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>sha(canonicalDocument(value));
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export const MAX_REPLACE_MATCHES=1000;
/** A commit changes at most 100 scenes; the preview stops at the same bound. */
export const MAX_REPLACE_SCENES=100;
const MAX_SCANNED_BYTES=64*1024*1024;
const loneSurrogate=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkQuery(q:string,replacement:string){
 if(/\u0000/.test(q)||loneSurrogate.test(q)||Array.from(segmenter.segment(q)).length>128)throw new DocumentError('DOCUMENT_SEARCH_QUERY_INVALID','Find supports at most 128 valid Unicode graphemes.',422);
 // Replacement text stays inside one run: no paragraph, page or object marks.
 if(/[\u0000-\u0008\u000a-\u001f\u007f￼]/.test(replacement)||loneSurrogate.test(replacement))throw new DocumentError('DOCUMENT_REPLACE_TEXT_INVALID','Replacement text must be one line of valid text.',422);
}
function skipReason(error:unknown):DocumentReplaceSkipReason{
 const message=error instanceof Error?error.message:'';
 if(/formatting/i.test(message))return 'formatting';
 if(/tracked change/i.test(message))return 'tracked-change';
 if(/boundary|protected|grapheme/i.test(message))return 'boundary';
 return 'unsupported';
}
/** Deterministic run identities make a retried operation reproduce the exact
 * commit, so the document service returns the original receipt. */
function identities(operationId:string,sceneId:number){
 let counter=0;
 return ()=>{const hex=sha(`${operationId}:${sceneId}:${counter++}`);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};
}
async function sceneDocument(bookId:number,reference:Pick<SceneDocumentReference,'sceneId'|'revisionId'|'contentHash'>){
 const row=await databaseService.client.sceneDocumentRevision.findFirst({where:{id:reference.revisionId,bookId,sceneId:reference.sceneId}});
 if(!row)throw new DocumentError('DOCUMENT_REVISION_MISSING','Document revision is unavailable.',503);
 const document=validateDocument(row.document);
 if(row.contentHash!==reference.contentHash||digest(document)!==row.contentHash)throw new DocumentError('DOCUMENT_REVISION_INVALID','Document checksum does not match its immutable manifest.',503);
 return document;
}
function findMatches(text:string,q:string,caseSensitive:boolean){
 const searchable=normalizedSearchText(text,caseSensitive);const needle=normalizedSearchText(q,caseSensitive).text;const found:Array<{from:number;to:number}>=[];
 let position=searchable.text.indexOf(needle);
 while(position>=0){
  const end=position+needle.length;const from=searchable.boundaries.get(position);const to=searchable.boundaries.get(end);
  if(from===undefined||to===undefined){position=searchable.text.indexOf(needle,position+1);continue;}
  found.push({from,to});position=searchable.text.indexOf(needle,end);
 }
 return {found,searchable};
}
async function orderedActiveScenes(userId:number,bookId:number){
 const manifest=await documentService.manifest(userId,bookId);
 if(!manifest.scopes)throw new DocumentError('DOCUMENT_SCOPE_BACKFILL_REQUIRED','Canonical scopes are required before replacing.',409);
 const structure=await readScope(databaseService.client,bookId,'structure',manifest.scopes.structure);
 return {manifest,references:orderedSceneReferences(manifest.scenes,structure).filter((scene)=>!scene.deletedAt)};
}

/** Every match in the current saved manuscript, with whether it can be
 * replaced without crossing formatting, paragraphs, objects or pending review. */
export async function previewBookReplace(userId:number,bookId:number,raw:unknown):Promise<DocumentReplacePreviewResponse>{
 const input=documentReplacePreviewSchema.parse(raw);checkQuery(input.q,input.replacement);
 const {manifest,references}=await orderedActiveScenes(userId,bookId);
 const needle=normalizedSearchText(input.q,input.caseSensitive).text;const sqlNeedle=needle.replace(/[\\%_]/g,(character)=>'\\'+character);
 // The durable search index narrows which scene bodies are read. Scenes
 // without an index row are scanned directly rather than silently skipped.
 const indexed=new Map<string,boolean>();
 for(let index=0;index<references.length;index+=256){
  const part=references.slice(index,index+256);
  const where={bookId,sceneRevisionId:{in:part.map((ref)=>ref.revisionId)}};
  const [rows,candidates]=await Promise.all([
   databaseService.client.sceneDocumentSearchIndex.findMany({where,select:{sceneRevisionId:true,contentHash:true}}),
   databaseService.client.sceneDocumentSearchIndex.findMany({where:{...where,...(input.caseSensitive?{sensitiveText:{contains:sqlNeedle}}:{foldedText:{contains:sqlNeedle}})},select:{sceneRevisionId:true}}),
  ]);
  const found=new Set(candidates.map((row)=>row.sceneRevisionId));
  for(const row of rows){const ref=part.find((item)=>item.revisionId===row.sceneRevisionId);if(ref&&row.contentHash===ref.contentHash)indexed.set(row.sceneRevisionId,found.has(row.sceneRevisionId));}
 }
 const matches:DocumentReplaceMatch[]=[];let scenes=0;let scanned=0;let truncated=false;
 for(const reference of references){
  if(indexed.get(reference.revisionId)===false)continue;
  const document=await sceneDocument(bookId,reference);const text=projectDocument(document).text;scanned+=text.length*2;
  if(scanned>MAX_SCANNED_BYTES){truncated=true;break;}
  const {found,searchable}=findMatches(text,input.q,input.caseSensitive);if(!found.length)continue;
  if(scenes>=MAX_REPLACE_SCENES||matches.length+found.length>MAX_REPLACE_MATCHES){truncated=true;break;}
  scenes++;
  for(const {from,to} of found){
   let reason:DocumentReplaceSkipReason|undefined;
   try{replaceDocumentText(document,from,to,text.slice(from,to),input.replacement,()=>'preview');}catch(error){reason=skipReason(error);}
   matches.push({id:`${reference.revisionId}:${from}:${to}`,sceneId:reference.sceneId,sceneNumber:reference.sceneNumber,chapterId:reference.chapterId,sceneRevisionId:reference.revisionId,from,to,sourceText:text.slice(from,to),...searchExcerpt(text,from,to,searchable),replaceable:!reason,...(reason?{reason}:{})});
  }
 }
 return {schemaVersion:1,sourceBookRevisionId:manifest.revisionId,query:input.q,replacement:input.replacement,caseSensitive:input.caseSensitive,matches,sceneCount:scenes,truncated};
}

/** Replace the selected matches and commit every changed scene as one book
 * revision. Each match must still be an exact match in its immutable scene
 * revision; the document service refuses the commit if the book moved on. */
export async function applyBookReplace(userId:number,bookId:number,raw:unknown):Promise<DocumentReplaceApplyReceipt>{
 const input=documentReplaceApplySchema.parse(raw);checkQuery(input.q,input.replacement);
 await documentService.manifest(userId,bookId);
 const needle=normalizedSearchText(input.q,input.caseSensitive).text;
 const byScene=new Map<number,{sceneRevisionId:string;ranges:Array<{from:number;to:number}>}>();
 for(const match of input.matches){
  if(match.to<=match.from)throw new DocumentError('DOCUMENT_REPLACE_MATCH_INVALID','A match range is empty.',422);
  const entry=byScene.get(match.sceneId)??{sceneRevisionId:match.sceneRevisionId,ranges:[]};
  if(entry.sceneRevisionId!==match.sceneRevisionId)throw new DocumentError('DOCUMENT_REPLACE_MATCH_INVALID','Matches in one scene must name the same scene revision.',422);
  entry.ranges.push({from:match.from,to:match.to});byScene.set(match.sceneId,entry);
 }
 if(byScene.size>MAX_REPLACE_SCENES)throw new DocumentError('DOCUMENT_REPLACE_TOO_LARGE',`Replace at most ${MAX_REPLACE_SCENES} scenes at once.`,413);
 const scenes:Array<{sceneId:number;expectedRevisionId:string;document:ProserDocument}>=[];let replacedCount=0;
 for(const [sceneId,entry] of byScene){
  const row=await databaseService.client.sceneDocumentRevision.findFirst({where:{id:entry.sceneRevisionId,bookId,sceneId},select:{contentHash:true}});
  if(!row)throw new DocumentError('DOCUMENT_SOURCE_STALE','A scene revision named by this replace is unavailable. Preview again.',412,{sceneId});
  const source=await sceneDocument(bookId,{sceneId,revisionId:entry.sceneRevisionId,contentHash:row.contentHash});
  const ranges=[...entry.ranges].sort((left,right)=>right.from-left.from);
  for(let index=1;index<ranges.length;index++)if(ranges[index]!.to>ranges[index-1]!.from)throw new DocumentError('DOCUMENT_REPLACE_MATCH_INVALID','Matches overlap.',422,{sceneId});
  const id=identities(input.operationId,sceneId);let document=source;
  for(const range of ranges){
   const text=projectDocument(document).text;const matched=text.slice(range.from,range.to);
   if(range.to>text.length||normalizedSearchText(matched,input.caseSensitive).text!==needle)throw new DocumentError('DOCUMENT_REPLACE_MATCH_INVALID','A selected match no longer matches the find text. Preview again.',409,{sceneId,from:range.from,to:range.to});
   if(matched===input.replacement)continue;
   try{document=replaceDocumentText(document,range.from,range.to,matched,input.replacement,id);}
   catch(error){throw new DocumentError('DOCUMENT_REPLACE_MATCH_UNSUPPORTED','A selected match crosses formatting, a paragraph or a tracked change. Deselect it and replace the rest.',409,{sceneId,from:range.from,to:range.to,reason:skipReason(error)});}
   replacedCount++;
  }
  if(digest(document)!==digest(source))scenes.push({sceneId,expectedRevisionId:entry.sceneRevisionId,document});
 }
 if(!scenes.length)throw new DocumentError('DOCUMENT_REPLACE_NOOP','The replacement does not change the selected text.',422);
 const receipt=await documentService.commit(userId,bookId,{schemaVersion:1,operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,scenes},'manual');
 return {kind:'replace',operationId:receipt.operationId,revisionId:receipt.revisionId,previousRevisionId:input.expectedRevisionId,contentHash:receipt.contentHash,replacedCount,scenes:receipt.scenes.map((scene)=>({sceneId:scene.sceneId,revisionId:scene.revisionId,contentHash:scene.contentHash,wordCount:scene.wordCount})),status:'completed'};
}
