import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {convertDocx} from '../src/documents/docxImport';
import {publicationDocx} from '../src/documents/publicationDocx';
import {publicationHtml,publicationEpub,publicationPdf,type PublicationInput} from '../src/documents/publicationRender';
const require=createRequire(import.meta.url);const {fixture}=require('../vendor/canvas-docx-codec/test/theme-fixture.cjs');
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw new Error('Supply an absolute isolated fixture directory.');
async function main(){await mkdir(output,{recursive:true});const {bytes}=await fixture();await writeFile(path.join(output,'source.docx'),bytes);const conversion=await convertDocx(bytes);await writeFile(path.join(output,'conversion.json'),JSON.stringify({...conversion,assets:[]},null,2));const input:PublicationInput={title:'Word theme fixture',author:'Fixture',revisionId:'11111111-1111-4111-8111-111111111111',sections:conversion.documents.map((document,index)=>({id:'s'+index,title:'Theme defaults',startsChapter:true,document})),styles:conversion.styles,assets:new Map()};for(const mode of ['final','original','retain-review'] as const){await writeFile(path.join(output,mode+'.docx'),await publicationDocx(input,mode));await writeFile(path.join(output,mode+'.epub'),await publicationEpub(input,mode));const rendered=await publicationPdf(input,mode);await writeFile(path.join(output,mode+'.pdf'),rendered.bytes);await writeFile(path.join(output,mode+'.renderer.json'),JSON.stringify({version:rendered.version,fonts:rendered.fonts,fontUsage:rendered.fontUsage,substitutions:rendered.substitutions},null,2));await writeFile(path.join(output,mode+'.html'),publicationHtml(input,mode));}}
void main();
