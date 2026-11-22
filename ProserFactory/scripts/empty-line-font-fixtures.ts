import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {convertDocx} from '../src/documents/docxImport';
import {publicationDocx} from '../src/documents/publicationDocx';
import {publicationHtml,publicationPdf,type PublicationInput} from '../src/documents/publicationRender';
import {paragraphsOf} from '../src/documents/model';
const require=createRequire(import.meta.url);const {fixture}=require('../vendor/canvas-docx-codec/test/theme-fixture.cjs');const {createZipBuffer}=require('@hivemagnus/canvas-word-codec');
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw new Error('Supply an isolated absolute fixture directory.');
const p=(text:string)=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const mark=(size:number)=>`<w:p><w:pPr><w:rPr><w:sz w:val="${size*1.5}"/></w:rPr></w:pPr></w:p>`;
async function main(){
 await mkdir(output,{recursive:true});const {files}=await fixture();const word='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 files.set('word/styles.xml',Buffer.from(files.get('word/styles.xml').toString().replace('</w:styles>','<w:style w:type="paragraph" w:styleId="LargeEmpty"><w:name w:val="Large empty cell"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Liberation Sans" w:hAnsi="Liberation Sans"/><w:sz w:val="42"/></w:rPr></w:style></w:styles>')));
 const source=files.get('word/document.xml').toString();const section=source.match(/<w:sectPr>.*?<\/w:sectPr>/s)![0].replace(/w:top="\d+"/,'w:top="2700"').replace(/w:bottom="\d+"/,'w:bottom="2700"');
 const table=`<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc>${p('Cell before')}<w:p><w:pPr><w:pStyle w:val="LargeEmpty"/></w:pPr></w:p>${p('Cell after')}</w:tc></w:tr></w:tbl>`;
 files.set('word/document.xml',Buffer.from(source.replace(/<w:body>.*?<\/w:body>/s,'<w:body>'+p('Body before')+mark(32)+p('Body after')+table+section+'</w:body>')));
 files.set('word/header1.xml',Buffer.from(`<w:hdr xmlns:w="${word}">${p('Header before')}<w:p/>${p('Header after')}</w:hdr>`));
 files.set('word/footer1.xml',Buffer.from(`<w:ftr xmlns:w="${word}">${p('Footer before')}${mark(24)}${p('Footer after')}</w:ftr>`));
 const bytes=await createZipBuffer([...files].map(([name,content])=>({name,content})));await writeFile(path.join(output,'source.docx'),bytes);const conversion=await convertDocx(bytes);const body=conversion.documents[0];body.layout.header=[];body.layout.footer=[];
 const blank=paragraphsOf(body).find(block=>block.runs.every(run=>!run.text)&&block.runs[0]?.style.size===32)!;body.changes.push({id:'empty-font-revision',kind:'format',status:'pending',origin:'manual',authorId:1,authorName:'Synthetic font reviewer',createdAt:'2026-01-01T00:00:00.000Z',targetRunIds:[blank.runs[0].id],beforeStyle:{...blank.runs[0].style,size:24},afterStyle:{...blank.runs[0].style}});
 const header=conversion.headerFooterStories.find(story=>story.kind==='header')!.document,footer=conversion.headerFooterStories.find(story=>story.kind==='footer')!.document;
 if(header.layout.font!=='Liberation Mono'||header.layout.fontSize!==20)throw new Error('Theme defaults were not retained in owned header.');
 const input:PublicationInput={title:'Empty typography fixture',author:'Synthetic fixture',revisionId:'11111111-1111-4111-8111-111111111111',sections:[{id:'body',title:'Empty font layout',startsChapter:false,document:body,headerStory:{id:'header',document:header},footerStory:{id:'footer',document:footer}}],styles:conversion.styles,assets:new Map()};
 await writeFile(path.join(output,'source.json'),JSON.stringify({...input,assets:[]},null,2));for(const mode of ['final','original','retain-review'] as const){await writeFile(path.join(output,mode+'.docx'),await publicationDocx(input,mode));const rendered=await publicationPdf(input,mode);await writeFile(path.join(output,mode+'.pdf'),rendered.bytes);await writeFile(path.join(output,mode+'.html'),publicationHtml(input,mode));await writeFile(path.join(output,mode+'.renderer.json'),JSON.stringify({version:rendered.version,fontUsage:rendered.fontUsage,substitutions:rendered.substitutions},null,2));}
}
void main();
