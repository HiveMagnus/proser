import { documentFromText, type DocumentParagraph, type DocumentAnchorLineage } from '@/documents/model';
import { validateAnchorLineage } from '@/documents/lineage';
let serial = 0; const id = () => `lineage-${++serial}`;
const paragraph = (value: ReturnType<typeof documentFromText>) => value.blocks[0] as DocumentParagraph;
test('Unicode split mappings prove exact stable spans without relocating repeated quotations', () => {
  const previous = documentFromText('left 😀 é right',id); const next = structuredClone(previous); const target = documentFromText('',id);
  const before = paragraph(previous); paragraph(next).runs[0].text = 'left ';
  paragraph(target).runs[0].text = '😀 é right';
  const mapping: DocumentAnchorLineage = { kind: 'split', source: { sceneId: 1,blockId: before.id,runId: before.runs[0].id,from: 5,to: before.runs[0].text.length },target: { sceneId: 2,blockId: paragraph(target).id,runId: paragraph(target).runs[0].id,from: 0,to: paragraph(target).runs[0].text.length } };
  expect(validateAnchorLineage([mapping],[{ sceneId:1,previous,next },{ sceneId:2,previous:documentFromText('',id),next:target }])[0].sourceTextSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(() => validateAnchorLineage([mapping],[{ sceneId:1,previous,next:previous },{ sceneId:2,previous:documentFromText('',id),next:target }])).toThrow('unchanged source');
  const broken = structuredClone(mapping); broken.source.from = 6;
  expect(() => validateAnchorLineage([broken],[{ sceneId:1,previous,next },{ sceneId:2,previous:documentFromText('',id),next:target }])).toThrow('grapheme');
});
test('changed style, protected container, identity and out-of-transaction scopes reject lineage', () => {
  const previous = documentFromText('exact',id); const next = documentFromText('',id); const target = structuredClone(previous); const before = paragraph(previous);
  const point = { blockId: before.id,runId: before.runs[0].id,from:0,to:5 }; const mapping: DocumentAnchorLineage={kind:'move',source:{sceneId:1,...point},target:{sceneId:2,...point}};
  const scopes = [{ sceneId:1,previous,next },{ sceneId:2,previous:documentFromText('',id),next:target }];
  expect(validateAnchorLineage([mapping],scopes)).toHaveLength(1);
  paragraph(target).runs[0].style.bold = true; expect(() => validateAnchorLineage([mapping],scopes)).toThrow('formatting');
  delete paragraph(target).runs[0].style.bold;
  const foreign = structuredClone(mapping); foreign.target.sceneId=3; expect(() => validateAnchorLineage([foreign],scopes)).toThrow('atomically');
  expect(() => validateAnchorLineage([mapping,mapping],scopes)).toThrow('overlap');
});

test('formatting lineage preserves exact paragraph coordinates and rejects repeated-text relocation',()=>{
 const previous=documentFromText('same same',id),next=structuredClone(previous),p=paragraph(previous),n=paragraph(next),old=p.runs[0]!;
 n.runs=[{...old,id:id(),text:'same',style:{bold:true}},{...old,text:' same'}];
 const mapping:DocumentAnchorLineage={kind:'format',source:{sceneId:1,blockId:p.id,runId:old.id,from:0,to:4},target:{sceneId:1,blockId:p.id,runId:n.runs[0]!.id,from:0,to:4}};
 expect(validateAnchorLineage([mapping],[{sceneId:1,previous,next}])).toHaveLength(1);
 const forged=structuredClone(mapping);forged.target={sceneId:1,blockId:p.id,runId:n.runs[1]!.id,from:1,to:5};
 expect(()=>validateAnchorLineage([forged],[{sceneId:1,previous,next}])).toThrow('paragraph coordinates');
 n.style.alignment='right';expect(validateAnchorLineage([mapping],[{sceneId:1,previous,next}])).toHaveLength(1);delete n.style.alignment;
 next.layout.margins[0]++;expect(()=>validateAnchorLineage([mapping],[{sceneId:1,previous,next}])).toThrow('paragraph coordinates');next.layout.margins[0]--;
 n.runs[1]!.inlineImage={assetId:1,sha256:'a'.repeat(64),width:20,height:20,alt:'protected'};
 expect(()=>validateAnchorLineage([mapping],[{sceneId:1,previous,next}])).toThrow('protected content');
});
