#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);const {exportDocx,defaultLayout}=require('@hivemagnus/canvas-word-codec');
const target=process.argv[2];if(!target||!path.isAbsolute(target))throw new Error('Supply an isolated absolute fixture directory.');
const p=(id,runs)=>({type:'paragraph',id,style:{},runs:runs.map(([text,style],index)=>({id:id+'-'+index,text,style}))});const body=p('body',[['Bold 😀 ',{bold:true}],['italic é ',{italic:true}],['tail',{}]]);const first=p('cell-1',[['Cell 😀 ',{bold:true}],['part é ',{italic:true}]]);const last=p('cell-2',[['table tail',{underline:true}]]);
const anchor=(paragraph,index,start=0,end=paragraph.runs[index].text.length)=>({blockId:paragraph.id,runId:paragraph.runs[index].id,start,end,sourceText:paragraph.runs[index].text.slice(start,end)});const comment=(id,anchors)=>({id:'comment-'+id,authorName:'Range reviewer',createdAt:'2026-01-01T01:02:03.000Z',text:'Review '+id,anchors,resolved:false});
const document={schemaVersion:1,blocks:[body,{type:'table',id:'table',widths:[300],rows:[{id:'row',cells:[{id:'cell',paragraphs:[first,last]}]}]}],changes:[],comments:[comment('body',[anchor(body,0,5),anchor(body,1),anchor(body,2)]),comment('cell',[anchor(first,0,5),anchor(first,1),anchor(last,0,0,5)])],layout:defaultLayout()};document.layout.font='Liberation Serif';
await mkdir(target,{recursive:true});for(const mode of ['final','original','retain-review'])await writeFile(path.join(target,mode+'.docx'),await exportDocx(document,mode));
await writeFile(path.join(target,'source.json'),JSON.stringify(document,null,2));
