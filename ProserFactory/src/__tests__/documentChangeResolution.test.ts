import {randomUUID} from 'node:crypto';
import {documentFromText,resolveChange,type ProserDocument,type DocumentChange} from '@/documents/model';
import {stampDocumentReview} from '@/documents/reviewAttribution';
import {validateDocument} from '@/documents/validation';
import type {ReviewResolutionContext} from '@/documents/reviewResolution';
const actor={id:8,name:'Authenticated reviewer'};
const context=():ReviewResolutionContext=>({operationId:randomUUID(),sourceBookRevisionId:randomUUID(),sourceContentHash:'a'.repeat(64),sourceKind:'scene',sourceSceneId:1,sourceSceneRevisionId:randomUUID()});
function fixture(kind:DocumentChange['kind']='insertion'):ProserDocument{
 const document=documentFromText('Proposed text.\n\nSecond paragraph.\n\nUnrelated content.',randomUUID);const first=document.blocks[0];const second=document.blocks[1];if(first.type!=='paragraph'||second.type!=='paragraph')throw new Error('fixture');const id=randomUUID();const paragraph=kind.startsWith('paragraph');
 document.changes=[{id,kind,status:'pending',origin:'ai',authorId:4,authorName:'Original editor',createdAt:'2026-10-05T00:00:00.000Z',targetRunIds:paragraph?[]:[first.runs[0].id],...(paragraph?{targetBlockIds:[first.id]}:{})}];
 if(kind==='insertion'||kind==='deletion')first.runs[0].changeId=id;
 if(kind==='paragraphInsertion'||kind==='paragraphDeletion')first.changeId=id;
 if(kind==='format'){document.changes[0].beforeStyle={italic:true};document.changes[0].afterStyle={bold:true};first.runs[0].style={bold:true};}
 if(kind==='paragraphFormat'){document.changes[0].beforeParagraphStyle={alignment:'left'};document.changes[0].afterParagraphStyle={alignment:'right'};first.style={alignment:'right'};}
 if(kind==='paragraphSplit'||kind==='paragraphJoin'){document.changes[0].targetBlockIds=[first.id,second.id];first.boundaryChangeId=id;}
 return validateDocument(document);
}
describe('authenticated immutable per-change review decisions',()=>{
 test.each(['insertion','deletion','format','paragraphInsertion','paragraphDeletion','paragraphFormat','paragraphSplit','paragraphJoin'] as const)('accept/reject of %s records the exact source and keeps original attribution',kind=>{
  for(const decision of ['accepted','rejected'] as const){const before=fixture(kind);const next=resolveChange(before,before.changes[0].id,decision);const source=context();const events=stampDocumentReview(next,before,actor,'manual',false,source);expect(next.changes[0]).toMatchObject({authorId:4,authorName:'Original editor',createdAt:before.changes[0].createdAt,origin:'ai',resolutionHistory:[{...source,actorId:actor.id,actorName:actor.name,decision,origin:'manual',phase:'resolved'}]});expect(events).toHaveLength(1);expect(events[0].action).toBe('resolve-document-change');expect(()=>validateDocument(next)).not.toThrow();}
 });
 test('fabricated, dropped or changed resolution history rejects and a resolved decision cannot flip',()=>{
  const before=fixture();const saved=resolveChange(before,before.changes[0].id,'accepted');stampDocumentReview(saved,before,actor,'manual',false,context());
  const forged=structuredClone(saved);forged.changes[0].resolutionHistory![0].actorId=999;expect(()=>stampDocumentReview(forged,saved,actor)).toThrow('server-owned');
  const dropped=structuredClone(saved);delete dropped.changes[0].resolutionHistory;expect(()=>stampDocumentReview(dropped,saved,actor)).toThrow('server-owned');
  const flipped=structuredClone(saved);flipped.changes[0].status='rejected';expect(()=>stampDocumentReview(flipped,saved,actor)).toThrow('already resolved');
  const fabricated=structuredClone(before);fabricated.changes[0].resolutionHistory=structuredClone(saved.changes[0].resolutionHistory);expect(()=>stampDocumentReview(fabricated,undefined,actor)).toThrow('server-owned');
 });
 test.each(['insertion','deletion','format','paragraphInsertion','paragraphDeletion','paragraphFormat','paragraphSplit','paragraphJoin'] as const)('cannot rewrite %s targets while resolving their old attribution',kind=>{
  const before=fixture(kind);const next=resolveChange(before,before.changes[0].id,'accepted');const target=next.blocks[0];if(target.type!=='paragraph')throw new Error('fixture');target.runs[0].text='Forged new wording.';expect(()=>stampDocumentReview(next,before,actor,'manual',false,context())).toThrow(/Save edits separately|Resolve this pending/);
 });
 test('unrelated typing is allowed while exact targets resolve, and missing source context cannot acknowledge a decision',()=>{
  const before=fixture();const next=resolveChange(before,before.changes[0].id,'accepted');const other=next.blocks[2];if(other.type!=='paragraph')throw new Error('fixture');other.runs[0].text='Separate direct typing.';expect(()=>stampDocumentReview(structuredClone(next),before,actor)).toThrow('immutable revision source');expect(()=>stampDocumentReview(next,before,actor,'manual',false,context())).not.toThrow();
 });
 test('workflow created-and-resolved records require its run, while direct accepted structural typing has a distinct audit',()=>{
  const source=fixture();const next=structuredClone(source);next.changes[0].status='accepted';const binding={...context(),workflowRunId:randomUUID()};const events=stampDocumentReview(next,undefined,actor,'workflow',false,binding);expect(events[0]).toMatchObject({action:'resolve-document-change',resolution:{phase:'created-and-resolved',origin:'workflow',workflowRunId:binding.workflowRunId}});
  expect(()=>stampDocumentReview(structuredClone(source),undefined,actor,'workflow',false,context())).not.toThrow();const bad=structuredClone(source);bad.changes[0].status='accepted';expect(()=>stampDocumentReview(bad,undefined,actor,'workflow',false,context())).toThrow('live workflow run');
  const structural=fixture('paragraphSplit');structural.changes[0].status='accepted';const direct=stampDocumentReview(structural,undefined,actor,'manual',false,context());expect(direct[0]).toMatchObject({action:'create-direct-structural-change',status:'accepted'});expect(structural.changes[0].resolutionHistory).toBeUndefined();
 });
 test('attested complete transfers retain non-manual pending payloads, and decisions bind the original source scene',()=>{
  const before=fixture();const original=context();if(original.sourceKind!=='scene')throw new Error('fixture');const destination=documentFromText('Destination',randomUUID);destination.changes=structuredClone(before.changes);const next=structuredClone(destination);next.blocks.push(...structuredClone(before.blocks));next.changes[0].status='accepted';const local=context();if(local.sourceKind!=='scene')throw new Error('fixture');local.sourceSceneId=2;local.sourceDocuments=[{sceneId:original.sourceSceneId,revisionId:original.sourceSceneRevisionId,contentHash:'b'.repeat(64),document:before}];const events=stampDocumentReview(next,destination,actor,'manual',false,local);expect(events[0]).toMatchObject({resolution:{sourceKind:'scene',sourceSceneId:original.sourceSceneId,sourceSceneRevisionId:original.sourceSceneRevisionId}});expect(JSON.stringify(events)).not.toContain('sourceDocuments');
 });
 test('imported attribution/date survive local resolution and container changes cannot hide inside a decision',()=>{
  const before=fixture();before.changes[0].origin='import';before.changes[0].importedAuthor='Original Word reviewer';const accepted=resolveChange(before,before.changes[0].id,'accepted');stampDocumentReview(accepted,before,actor,'manual',false,context());expect(accepted.changes[0]).toMatchObject({origin:'import',importedAuthor:'Original Word reviewer',authorId:4,createdAt:before.changes[0].createdAt});
  const moved=resolveChange(before,before.changes[0].id,'accepted');const first=moved.blocks[0];const second=moved.blocks[1];if(first.type!=='paragraph'||second.type!=='paragraph')throw new Error('fixture');second.runs.push(...first.runs);first.runs=[{id:randomUUID(),text:'',style:{}}];expect(()=>stampDocumentReview(moved,before,actor,'manual',false,context())).toThrow('container identity changed');
 });

 test('pending formatting properties cannot be overwritten under the original proposal author',()=>{
  const before=fixture('format');const next=structuredClone(before);const paragraph=next.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.underline=true;expect(()=>stampDocumentReview(next,before,actor)).toThrow('pending formatting proposal');
 });

});
