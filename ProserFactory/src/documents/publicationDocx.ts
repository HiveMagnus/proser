import { createHash } from 'node:crypto';
import { exportDocxSections, WordCodecError } from '@hivemagnus/canvas-word-codec';
import { type PublicationInput } from './publicationRender';
import { wordExchangeDocument,wordStyleDefinitions } from './wordExchange';
import { DocumentError } from './errors';
import {prepareDocxImages,type PublicationImageDerivation} from './publicationImages';
/** Factory chooses revision-bound sections; the maintained MIT codec owns OOXML. */
export async function publicationDocx(input:PublicationInput,mode:'retain-review'|'final'|'original'):Promise<Buffer>{return(await publicationDocxDetailed(input,mode)).bytes;}
export async function publicationDocxDetailed(source:PublicationInput,mode:'retain-review'|'final'|'original'):Promise<{bytes:Buffer;derivations:PublicationImageDerivation[];rendererVersion:string|null}>{
  const prepared=await prepareDocxImages(source);const input=prepared.input;
  const sections=input.sections.map((section)=>{const document=structuredClone(section.document);if(section.startsChapter&&!section.isCover){const ids=new Set<string>();const collect=(value:unknown):void=>{if(Array.isArray(value)){value.forEach(collect);return;}if(value&&typeof value==='object'){for(const[key,item]of Object.entries(value)){if(key==='id'&&typeof item==='string')ids.add(item);else collect(item);}}};collect(document);const prefix='publication-title-'+createHash('sha256').update(section.id).digest('hex').slice(0,24);let titleId=prefix;for(let suffix=1;ids.has(titleId)||ids.has(titleId+'-run');suffix++)titleId=prefix+'-'+suffix;document.blocks.unshift({type:'paragraph',id:titleId,style:{heading:1,after:16,keepWithNext:true},runs:[{id:titleId+'-run',text:section.title,style:{font:document.layout.font,size:document.layout.fontSize*2,bold:true}}]});}return {title:section.title,suppressTitle:true,startsSection:section.startsChapter,document:wordExchangeDocument(document,undefined,input.styles),stories:section.headerStory||section.footerStory?{header:section.headerStory?wordExchangeDocument(section.headerStory.document,'header',input.styles):undefined,footer:section.footerStory?wordExchangeDocument(section.footerStory.document,'footer',input.styles):undefined}:undefined};});
  try{return {bytes:await exportDocxSections({sections,assets:input.assets,styleDefinitions:wordStyleDefinitions(input.styles)},mode),derivations:prepared.derivations,rendererVersion:prepared.rendererVersion};}
  catch(error){if(error instanceof WordCodecError)throw new DocumentError(error.code,error.message,error.status,error.details);throw error;}
}
