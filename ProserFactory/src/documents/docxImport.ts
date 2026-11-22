import { createHash } from 'node:crypto';
import type { DocumentStyleDefinitions } from './style-model';
import { importDocx, WordCodecError, paragraphsOf as wordParagraphsOf, type DocxIncomingAsset } from '@hivemagnus/canvas-word-codec';
import { type ProserDocument, paragraphsOf } from './model';
import { validateDocument } from './validation';
import { DocumentError } from './errors';
export type { DocxIncomingAsset } from '@hivemagnus/canvas-word-codec';
export interface DocxConversion { documents:ProserDocument[]; styles:DocumentStyleDefinitions; headerFooterStories:Array<{documentIndex:number;kind:'header'|'footer';document:ProserDocument}>; chapterTitles:string[]; assets:DocxIncomingAsset[]; losses:Array<{code:string;count:number;message:string}>; detected:Array<{feature:string;count:number}> }
/** Hierarchy mapping and canonical authority stay outside the generic MIT codec. */
export async function convertDocx(bytes: Buffer): Promise<DocxConversion> {
  let converted: Awaited<ReturnType<typeof importDocx>>;
  try { converted = await importDocx(bytes); }
  catch(error) { if(error instanceof WordCodecError) throw new DocumentError(error.code,error.message,error.status,error.details); throw error; }
  const styles:DocumentStyleDefinitions={text:{},paragraph:{},labels:{}};const namespace=createHash('sha256').update(bytes).digest('hex').slice(0,10);const aliases=new Map(Object.keys(converted.styleDefinitions).map((id)=>[id,`import-${namespace}-${id.replace(/^word-style-/,'')}`]));
  const textStyle=(style:import('./model').TextStyle)=>({...style,...(style.characterStyleId?{characterStyleId:aliases.get(style.characterStyleId)??style.characterStyleId}:{})});
  for(const [id,definition] of Object.entries(converted.styleDefinitions)){const key=aliases.get(id)!;styles.text[key]=textStyle(definition.run);if(definition.kind!=='character')styles.paragraph[key]={...definition.paragraph,name:key};styles.labels![key]=definition.label??id;}
  const rename=(document:import('@hivemagnus/canvas-word-codec').WordDocument)=>{for(const paragraph of wordParagraphsOf(document,true)){if(paragraph.style.name&&aliases.has(paragraph.style.name))paragraph.style.name=aliases.get(paragraph.style.name);for(const run of paragraph.runs)run.style=textStyle(run.style);}for(const change of document.changes){for(const style of [change.beforeParagraphStyle,change.afterParagraphStyle])if(style?.name&&aliases.has(style.name))style.name=aliases.get(style.name);if(change.beforeStyle)change.beforeStyle=textStyle(change.beforeStyle);if(change.afterStyle)change.afterStyle=textStyle(change.afterStyle);}};
  rename(converted.document);for(const section of converted.sections){rename(section.document);for(const story of Object.values(section.stories??{}))rename(story);}
  const documents:ProserDocument[]=[];const chapterTitles:string[]=[]; const headerFooterStories:DocxConversion['headerFooterStories']=[];
  const sections = converted.sections.length ? converted.sections : [{document:converted.document,stories:undefined}];
  let sourceComments = 0;
  for (const [sectionIndex, section] of sections.entries()) {
    const source=section.document; const firstDocumentIndex=documents.length;
    const document = { ...source, layout:{...source.layout,preset:'manuscript'}, changes:source.changes.map((change)=>({...change,authorId:0,origin:'import'})), comments:source.comments.map((comment)=>({...comment,authorId:0})) } as ProserDocument;
    sourceComments += document.comments.length;
    const mapped: ProserDocument[] = []; let current:ProserDocument|undefined;
    for(const block of document.blocks) {
      const previous = current?.blocks.at(-1);
      if(!current || (block.type==='paragraph'&&(block.style.heading??(block.style.name?styles.paragraph[block.style.name]?.heading:undefined))===1&&current.blocks.length&&!(previous?.type==='paragraph'&&previous.boundaryChangeId))) {
        current={...structuredClone(document),blocks:[],changes:[],comments:[]}; mapped.push(current);documents.push(current);
        chapterTitles.push(block.type==='paragraph'&&(block.style.heading??(block.style.name?styles.paragraph[block.style.name]?.heading:undefined))===1?block.runs.map((run)=>run.text).join(''):sections.length>1?`Imported section ${sectionIndex+1}`:'Imported manuscript');
      }
      current.blocks.push(block);
    }
    if(!mapped.length) { mapped.push(document);documents.push(document);chapterTitles.push('Imported manuscript'); }
    for(const item of mapped) { const paragraphs=paragraphsOf(item,true);const blockIds=new Set(paragraphs.map((paragraph)=>paragraph.id));const runIds=new Set(paragraphs.flatMap((paragraph)=>paragraph.runs.map((run)=>run.id)));item.changes=document.changes.filter((change)=>change.targetRunIds.every((id)=>runIds.has(id))&&(change.targetBlockIds??[]).every((id)=>blockIds.has(id)));item.comments=document.comments.filter((comment)=>comment.anchors.every((anchor)=>runIds.has(anchor.runId)));validateDocument(item); }
    for (const kind of ['header','footer'] as const) if(section.stories?.[kind]) {
      const sourceStory=section.stories[kind]!; const story={...sourceStory,layout:{...sourceStory.layout,preset:'manuscript'},changes:sourceStory.changes.map((change)=>({...change,authorId:0,origin:'import'})),comments:sourceStory.comments.map((comment)=>({...comment,authorId:0}))} as ProserDocument;
      validateDocument(story); for(let documentIndex=firstDocumentIndex;documentIndex<documents.length;documentIndex++) headerFooterStories.push({documentIndex,kind,document:structuredClone(story)});
    }
  }
  const retained=documents.reduce((count,item)=>count+item.comments.length,0);if(retained<sourceComments)converted.losses.push({code:'CROSS_CHAPTER_COMMENT',count:sourceComments-retained,message:'Comments spanning heading-mapped chapters remain in the preserved original.'});
  return { documents,styles,headerFooterStories,chapterTitles,assets:converted.assets,losses:converted.losses,detected:converted.detected };
}
