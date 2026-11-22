import {randomUUID} from 'node:crypto';
import {documentFromText,type ProserDocument} from '@/documents/model';
import {stampDocumentReview} from '@/documents/reviewAttribution';
function fixture(kind:'insertion'|'deletion'|'paragraphInsertion'|'paragraphDeletion'):ProserDocument{
 const document=documentFromText('Protected content.\n\nOrdinary typing.',randomUUID);const first=document.blocks[0];if(first.type!=='paragraph')throw new Error('fixture');const id=randomUUID();const paragraph=kind.startsWith('paragraph');if(paragraph)first.changeId=id;else first.runs[0].changeId=id;
 document.changes=[{id,kind,targetRunIds:paragraph?[]:[first.runs[0].id],...(paragraph?{targetBlockIds:[first.id]}:{}),status:'pending',authorId:4,authorName:'AI source',createdAt:'2026-10-05T00:00:00.000Z',origin:'ai'}];return document;
}
describe('pending review content attribution cannot be silently rewritten',()=>{
 test.each(['insertion','deletion','paragraphInsertion','paragraphDeletion'] as const)('guards %s target text and formatting while allowing unrelated ordinary typing',kind=>{
  const before=fixture(kind);const changed=structuredClone(before);const paragraph=changed.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].text='Rewritten under the old author.';expect(()=>stampDocumentReview(changed,before,{id:8,name:'Current author'})).toThrow('Resolve this pending');
  const formatting=structuredClone(before);const first=formatting.blocks[0];if(first.type!=='paragraph')throw new Error('fixture');first.runs[0].style.bold=true;expect(()=>stampDocumentReview(formatting,before,{id:8,name:'Current author'})).toThrow('Resolve this pending');
  const unrelated=structuredClone(before);const second=unrelated.blocks[1];if(second.type!=='paragraph')throw new Error('fixture');second.runs[0].text='Direct ordinary typing still works.';expect(()=>stampDocumentReview(unrelated,before,{id:8,name:'Current author'})).not.toThrow();
 });
 test('an explicit recorded resolution releases the pending target guard',()=>{const before=fixture('insertion');const next=structuredClone(before);next.changes[0].status='accepted';expect(()=>stampDocumentReview(next,before,{id:8,name:'Current author'},'manual',false,{operationId:randomUUID(),sourceBookRevisionId:randomUUID(),sourceContentHash:'a'.repeat(64),sourceKind:'scene',sourceSceneId:1,sourceSceneRevisionId:randomUUID()})).not.toThrow();});
 test.each(['insertion','paragraphInsertion'] as const)('allows only authenticated own manual %s continuation with linked identity expansion',kind=>{
  const before=fixture(kind);before.changes[0].origin='manual';before.changes[0].authorId=8;const next=structuredClone(before);const paragraph=next.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].text+=' Continued typing.';
  if(kind==='insertion'){const run={id:randomUUID(),text:' Fresh continuation.',style:{},changeId:before.changes[0].id};paragraph.runs.push(run);next.changes[0].targetRunIds.push(run.id);}else{const block=documentFromText('Split continuation.',randomUUID).blocks[0];if(block.type!=='paragraph')throw new Error('fixture');block.changeId=before.changes[0].id;next.blocks.push(block);next.changes[0].targetBlockIds!.push(block.id);}
  expect(()=>stampDocumentReview(next,before,{id:8,name:'Current author'},'manual')).not.toThrow();expect(next.changes[0].createdAt).toBe(before.changes[0].createdAt);expect(next.changes[0].id).toBe(before.changes[0].id);
  expect(()=>stampDocumentReview(structuredClone(next),before,{id:9,name:'Other author'},'manual')).toThrow();expect(()=>stampDocumentReview(structuredClone(next),before,{id:8,name:'Current author'},'ai')).toThrow();
 });
 test('rejects imported manual-looking insertions, original text reattribution, and all own pending deletion mutations',()=>{
  const before=fixture('insertion');before.changes[0].origin='manual';before.changes[0].authorId=8;before.changes[0].importedAuthor='Word reviewer';const next=structuredClone(before);const p=next.blocks[0];if(p.type!=='paragraph')throw new Error('fixture');p.runs[0].text+=' Changed';expect(()=>stampDocumentReview(next,before,{id:8,name:'Current author'})).toThrow('Resolve this pending');
  delete before.changes[0].importedAuthor;const forged=structuredClone(before);const original=forged.blocks[1];if(original.type!=='paragraph')throw new Error('fixture');original.runs[0].changeId=before.changes[0].id;forged.changes[0].targetRunIds.push(original.runs[0].id);expect(()=>stampDocumentReview(forged,before,{id:8,name:'Current author'})).toThrow('reattributing original');
  for(const kind of ['deletion','paragraphDeletion'] as const){const original=fixture(kind);original.changes[0].origin='manual';original.changes[0].authorId=8;const changed=structuredClone(original);const first=changed.blocks[0];if(first.type!=='paragraph')throw new Error('fixture');first.runs[0].text+=' Changed original';expect(()=>stampDocumentReview(changed,original,{id:8,name:'Current author'})).toThrow('Resolve this pending');}
 });

});
