import {randomUUID,createHash} from 'node:crypto';
import {documentFromText,canonicalDocument,type DocumentAnchor,type ProserDocument} from '@/documents/model';
import {validateAnchorLineage} from '@/documents/lineage';
import {parseCommentCandidateDocument,reconcileDocumentComments,type CommentSource} from '@/documents/commentAnchors';
import {validateDocument} from '@/documents/validation';
const actor={id:7,name:'Authenticated reviewer'};
const source=(document:ProserDocument):CommentSource=>({sceneId:10,revisionId:randomUUID(),contentHash:createHash('sha256').update(canonicalDocument(document)).digest('hex'),document});
function fixture(text='Echo. Echo.'){
 const document=documentFromText(text,randomUUID);const paragraph=document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');const anchor={blockId:paragraph.id,runId:paragraph.runs[0].id,start:6,end:11,sourceText:'Echo.'};document.comments=[{id:'retained-comment',authorId:3,authorName:'Original reviewer',createdAt:'2026-10-05T00:00:00.000Z',text:'Keep the second instance.',anchors:[anchor],resolved:false}];return validateDocument(document);
}
describe('durable source-proven comment attachment',()=>{
 test('deleting a target preserves an orphan with immutable source evidence instead of guessing an identical quotation',()=>{
  const before=fixture();const origin=source(before);const next=documentFromText('Echo.',randomUUID);next.comments=structuredClone(before.comments);
  expect(()=>validateDocument(next)).toThrow('stale');const candidate=parseCommentCandidateDocument(next);const saved=reconcileDocumentComments(before,candidate,origin,actor,randomUUID());
  expect(saved.comments[0].anchors).toEqual(before.comments[0].anchors);expect(saved.comments[0].anchorStates).toEqual([{anchorIndex:0,status:'orphaned',reason:'target-removed',sourceSceneId:10,sourceSceneRevisionId:origin.revisionId,sourceContentHash:origin.contentHash,sourceAnchor:before.comments[0].anchors[0]}]);expect(saved.blocks).toEqual(next.blocks);expect(()=>validateDocument(saved)).not.toThrow();
 });
 test('a changed repeated run becomes stale even when the same quote still occupies its prior offset',()=>{
  const before=fixture();const next=structuredClone(before);const block=next.blocks[0];if(block.type!=='paragraph')throw new Error('fixture');block.runs[0].text='Echo. Echo. Echo.';
  const saved=reconcileDocumentComments(before,next,source(before),actor,randomUUID());expect(saved.comments[0].anchorStates?.[0]).toMatchObject({status:'stale',reason:'target-text-changed'});expect(saved.comments[0].anchors).toEqual(before.comments[0].anchors);
 });
 test('stable complete paragraph movement retains exact comment identities including attested cross-scene transfers',()=>{
  const before=fixture();const origin=source(before);const destination=documentFromText('Destination',randomUUID);destination.comments=structuredClone(before.comments);const next=structuredClone(destination);next.blocks.push(structuredClone(before.blocks[0]));
  const saved=reconcileDocumentComments(destination,next,{sceneId:20,revisionId:randomUUID(),contentHash:'b'.repeat(64),document:destination},actor,randomUUID(),{sourceDocuments:[origin]});expect(saved.comments[0].anchorStates).toBeUndefined();expect(saved.comments[0].anchors).toEqual(before.comments[0].anchors);
 });
 test('only verified split lineage can divide an anchored range across stable replacement runs',()=>{
  const before=fixture();const old=before.blocks[0];if(old.type!=='paragraph')throw new Error('fixture');before.comments[0].anchors=[{blockId:old.id,runId:old.runs[0].id,start:3,end:9,sourceText:old.runs[0].text.slice(3,9)}];const origin=source(before);
  const next=structuredClone(before);const first=next.blocks[0];if(first.type!=='paragraph')throw new Error('fixture');const originalText=first.runs[0].text;first.runs[0].text=originalText.slice(0,6);const second={type:'paragraph' as const,id:randomUUID(),style:{},runs:[{id:randomUUID(),text:originalText.slice(6),style:{}}]};next.blocks.push(second);
  const mappings=validateAnchorLineage([{kind:'split',source:{sceneId:10,blockId:old.id,runId:old.runs[0].id,from:0,to:6},target:{sceneId:10,blockId:first.id,runId:first.runs[0].id,from:0,to:6}},{kind:'split',source:{sceneId:10,blockId:old.id,runId:old.runs[0].id,from:6,to:11},target:{sceneId:10,blockId:second.id,runId:second.runs[0].id,from:0,to:5}}],[{sceneId:10,previous:before,next}]);
  const saved=reconcileDocumentComments(before,next,origin,actor,randomUUID(),{lineage:mappings});expect(saved.comments[0].anchorStates).toBeUndefined();expect(saved.comments[0].anchors.map((anchor)=>anchor.sourceText).join('')).toBe(before.comments[0].anchors[0].sourceText);expect(saved.comments[0].anchors).toHaveLength(2);
 });
 test('a source proof cannot be altered, and explicit reattachment records the original orphan and authenticated reviewer',()=>{
  const before=fixture();const next=documentFromText('Chosen current target.',randomUUID);next.comments=structuredClone(before.comments);const stale=reconcileDocumentComments(before,next,source(before),actor,randomUUID());const forged=structuredClone(stale);forged.comments[0].anchorStates![0].sourceContentHash='f'.repeat(64);expect(()=>reconcileDocumentComments(stale,forged,source(stale),actor,randomUUID())).toThrow('server-owned');
  const paragraph=stale.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');const anchor:DocumentAnchor={blockId:paragraph.id,runId:paragraph.runs[0].id,start:0,end:6,sourceText:'Chosen'};const operationId=randomUUID();const reattached=reconcileDocumentComments(stale,structuredClone(stale),source(stale),actor,operationId,{resolution:{commentId:stale.comments[0].id,action:'reanchored',anchors:[anchor]}});
  expect(reattached.comments[0].anchors).toEqual([anchor]);expect(reattached.comments[0].anchorStates).toBeUndefined();expect(reattached.comments[0].resolutionHistory?.[0]).toMatchObject({operationId,action:'reanchored',actorId:7,actorName:actor.name,previousAnchorStates:stale.comments[0].anchorStates});
 });
 test('resolution retains detached evidence and rejecting a guessed reanchor does not change the document',()=>{
  const before=fixture();const next=documentFromText('Unrelated',randomUUID);next.comments=structuredClone(before.comments);const stale=reconcileDocumentComments(before,next,source(before),actor,randomUUID());const requested=structuredClone(stale);requested.comments[0].resolved=true;const resolved=reconcileDocumentComments(stale,requested,source(stale),actor,randomUUID());expect(resolved.comments[0].anchorStates).toEqual(stale.comments[0].anchorStates);expect(resolved.comments[0].resolutionHistory?.[0].action).toBe('resolved');
  const forged=structuredClone(stale);forged.comments[0].anchors[0].runId=(stale.blocks[0].type==='paragraph'?stale.blocks[0].runs[0].id:'missing');expect(()=>reconcileDocumentComments(stale,forged,source(stale),actor,randomUUID())).toThrow('explicit guarded');
 });
 test('drawing point comments retain immutable image identity and become stale when the asset is replaced',()=>{
  const before=fixture();const paragraph=before.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');const image={id:randomUUID(),text:'',style:{},inlineImage:{assetId:1,sha256:'a'.repeat(64),alt:'Original drawing',width:100,height:100}};paragraph.runs.push(image);before.comments[0].anchors=[{blockId:paragraph.id,runId:image.id,start:0,end:0,sourceText:''}];validateDocument(before);
  const resized=structuredClone(before);const block=resized.blocks[0];if(block.type!=='paragraph')throw new Error('fixture');block.runs[1].inlineImage!.width=150;expect(reconcileDocumentComments(before,resized,source(before),actor,randomUUID()).comments[0].anchorStates).toBeUndefined();
  const replaced=structuredClone(before);const changed=replaced.blocks[0];if(changed.type!=='paragraph')throw new Error('fixture');changed.runs[1].inlineImage={...image.inlineImage,assetId:2,sha256:'b'.repeat(64)};
  expect(reconcileDocumentComments(before,replaced,source(before),actor,randomUUID()).comments[0].anchorStates?.[0]).toMatchObject({status:'stale',reason:'target-image-changed',sourceAnchor:{runId:image.id,start:0,end:0,sourceText:''}});
 });

});
