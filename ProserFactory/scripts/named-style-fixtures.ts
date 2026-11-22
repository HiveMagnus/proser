import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {documentFromText,type ProserDocument} from '../src/documents/model';
import {publicationDocx} from '../src/documents/publicationDocx';
import {publicationHtml,publicationEpub,publicationPdf,type PublicationInput} from '../src/documents/publicationRender';
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw new Error('Supply an absolute isolated fixture directory.');
const document:ProserDocument=documentFromText('Named 😀 é\n\nParagraph default',()=> 'fixture');
document.blocks.forEach((block,index)=>{block.id='p'+index;if(block.type==='paragraph'){block.style={name:'body-style'};block.runs[0].id='r'+index;block.runs[0].style=index?{}:{characterStyleId:'emphasis',bold:false};}});
document.layout.font='Liberation Serif';
document.changes=[{id:'format',kind:'format',authorId:1,authorName:'Style reviewer',createdAt:'2026-01-01T00:00:00.000Z',status:'pending',origin:'manual',targetRunIds:['r0'],beforeStyle:{characterStyleId:'old-emphasis',bold:false},afterStyle:{characterStyleId:'emphasis',bold:false}}];
const input:PublicationInput={title:'Named style fixture',author:'Fixture',revisionId:'11111111-1111-4111-8111-111111111111',sections:[{id:'scene',title:'Styled chapter',startsChapter:true,document}],assets:new Map(),styles:{paragraph:{'body-style':{alignment:'center',lineSpacing:1.5}},text:{'body-style':{font:'Liberation Serif',size:20,bold:true},emphasis:{characterStyleId:'parent-emphasis',italic:true,color:'#aa2222'},'parent-emphasis':{font:'Liberation Mono',bold:true},'old-emphasis':{font:'Liberation Sans',color:'#2244aa'}},labels:{'body-style':'Café body',emphasis:'Émphasis','parent-emphasis':'Parent emphasis','old-emphasis':'Original emphasis'}}};
async function main(){await mkdir(output,{recursive:true});for(const mode of ['final','original','retain-review'] as const){await writeFile(path.join(output,mode+'.docx'),await publicationDocx(input,mode));await writeFile(path.join(output,mode+'.epub'),await publicationEpub(input,mode));const rendered=await publicationPdf(input,mode);await writeFile(path.join(output,mode+'.pdf'),rendered.bytes);await writeFile(path.join(output,mode+'.renderer.json'),JSON.stringify({version:rendered.version,fonts:rendered.fonts,fontUsage:rendered.fontUsage,substitutions:rendered.substitutions},null,2));await writeFile(path.join(output,mode+'.html'),publicationHtml(input,mode));}await writeFile(path.join(output,'source.json'),JSON.stringify({...input,assets:[]},null,2));}
void main();
