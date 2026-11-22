import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {documentFromText,projectDocument} from '../src/documents/model';
import {publicationDocx} from '../src/documents/publicationDocx';
import {publicationPdf,type PublicationInput} from '../src/documents/publicationRender';
import {convertDocx} from '../src/documents/docxImport';
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw new Error('Supply an absolute isolated fixture directory.');
const paragraphs=Number(process.argv[3]??1);if(!Number.isInteger(paragraphs)||paragraphs<1||paragraphs>1000||300000%paragraphs)throw new Error('Supply a paragraph count from1to1000 dividing300000 exactly.');
async function main(){
 await mkdir(output,{recursive:true});const text=Array.from({length:paragraphs},()=> 'word '.repeat(300000/paragraphs)).join('\n\n'),document=documentFromText(text,randomUUID);document.layout.font='Liberation Serif';
 const source:PublicationInput={title:'Single-paragraph acceptance fixture',author:'Synthetic fixture',revisionId:randomUUID(),sections:[{id:'single-paragraph',title:'Synthetic acceptance',startsChapter:false,document}],assets:new Map()};
 const docxStart=performance.now(),docx=await publicationDocx(source,'final');const docxMs=performance.now()-docxStart;await writeFile(path.join(output,'large.docx'),docx);
 const importStart=performance.now(),converted=await convertDocx(docx);if(converted.documents.map(doc=>projectDocument(doc).text).join('\n\n')!==text)throw new Error('Secure DOCX import changed exact single-paragraph text.');const importMs=performance.now()-importStart;
 const pdfStart=performance.now(),pdf=await publicationPdf(source,'final');const pdfMs=performance.now()-pdfStart;await writeFile(path.join(output,'large.pdf'),pdf.bytes);await writeFile(path.join(output,'source.txt'),text);
 const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');await writeFile(path.join(output,'evidence.json'),JSON.stringify({schemaVersion:1,synthetic:true,words:300000,paragraphs,sourceBytes:Buffer.byteLength(text),sourceSha256:sha(text),exactSecureDocxReimport:true,docx:{bytes:docx.length,sha256:sha(docx),durationMs:docxMs,secureImportMs:importMs},pdf:{bytes:pdf.bytes.length,sha256:sha(pdf.bytes),durationMs:pdfMs,rendererVersion:pdf.version,fontUsage:pdf.fontUsage,substitutions:pdf.substitutions},wordAcceptance:'unverified'},null,2));
}
void main();
