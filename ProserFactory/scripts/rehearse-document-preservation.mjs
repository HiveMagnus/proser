#!/usr/bin/env node
/** Real manuscript preservation rehearsal in a newly allocated isolated clone.
 * Never runs Jest, evaluates prose, calls a provider or mutates production. */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, lstatSync, chmodSync } from 'node:fs';
import { isAbsolute, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
const root=resolve(import.meta.dirname,'..');
const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function privateBytes(filename){
 if(!filename||!isAbsolute(filename))throw new Error('Explicit absolute private evidence file required.');
 const file=lstatSync(filename),parent=statSync(dirname(filename));
 if(!file.isFile()||file.uid!==process.getuid()||(file.mode&0o077)||parent.uid!==process.getuid()||(parent.mode&0o077))throw new Error('Evidence files and their parents must be owner-only and owned by this operator.');
 return readFileSync(filename);
}
const connection=option('--isolated-postgres'),record=option('--record-dir'),dumpFile=option('--original-dump'),assetsFile=option('--asset-manifest');
if(!connection||!record||!isAbsolute(record)||!dumpFile||!assetsFile)throw new Error('Use --isolated-postgres URL --record-dir ABS --original-dump ABS --asset-manifest ABS.');
const endpoint=new URL(connection);if(endpoint.hostname!=='127.0.0.1'||endpoint.port!=='55441'||endpoint.pathname!=='/postgres')throw new Error('Only isolated 127.0.0.1:55441/postgres is accepted.');
const container=option('--postgres-container')??'proser-canvas-test-postgres';if(!/^[A-Za-z0-9_-]+$/.test(container))throw new Error('Invalid fixture container.');
mkdirSync(record,{recursive:true,mode:0o700});chmodSync(record,0o700);
const save=(name,value)=>{const filename=resolve(record,name);writeFileSync(filename,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return filename;};
function run(command,args,env={},input){const result=spawnSync(command,args,{cwd:root,env:{...process.env,...env},input,maxBuffer:256*1024*1024,timeout:600000});if(result.status!==0||result.error){save(`failed-${Date.now()}.log`,Buffer.concat([result.stdout??Buffer.alloc(0),result.stderr??Buffer.alloc(0)]));throw new Error(`Rehearsal ${command} failed; inspect the private record. Production was not used.`);}return result.stdout;}
const candidate=run('git',['rev-parse','HEAD']).toString().trim(),dirty=Boolean(run('git',['status','--porcelain=v1','--untracked-files=all']).toString().trim()),diagnostic=process.argv.includes('--allow-dirty-isolated-diagnostic');if(dirty&&!diagnostic)throw new Error('Commit/review the exact candidate before this preservation rehearsal.');
const originalDump=privateBytes(dumpFile),assetInputs=JSON.parse(privateBytes(assetsFile).toString('utf8'));
if(!Array.isArray(assetInputs)||assetInputs.some(asset=>!Number.isSafeInteger(asset.assetId)||asset.assetId<1||!/^\/images\/[A-Za-z0-9_.-]+$/.test(asset.url)||!/^[a-f0-9]{64}$/.test(asset.sha256)))throw new Error('Asset manifest requires every original assetId, owned URL, private path and SHA256.');
const assetBytes=[];mkdirSync(resolve(record,'public/images'),{recursive:true,mode:0o700});
for(const asset of assetInputs){const bytes=privateBytes(asset.path);if(sha(bytes)!==asset.sha256)throw new Error('Original asset bytes differ.');const file=resolve(record,'public/images',basename(asset.url));if(assetBytes.some(item=>item.url===asset.url||item.assetId===asset.assetId))throw new Error('Duplicate original image identity or path.');writeFileSync(file,bytes,{flag:'wx',mode:0o600});assetBytes.push({...asset,path:file});}
const sql=readFileSync(resolve(root,'deploy/document-authority/enforcement.sql')),pins=JSON.parse(readFileSync(resolve(root,'deploy/document-authority/reviewed-schema.json'),'utf8'));
if(sha(sql)!==pins.enforcementSqlSha256)throw new Error('Reviewed enforcement SQL differs.');
const database=`proser_canvas_preserve_${Date.now()}_${randomBytes(3).toString('hex')}`,first=`${database}_restore1`,second=`${database}_restore2`;
const url=name=>{const scoped=new URL(connection);scoped.pathname=`/${name}`;return scoped.toString();};
const admin=new pg.Client({connectionString:connection});await admin.connect();
const quote=name=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('Unsafe database identifier.');return `"${name}"`;};
const client=async name=>{const scoped=new pg.Client({connectionString:url(name)});await scoped.connect();return scoped;};
const restore=(name,bytes)=>run('docker',['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--no-owner','--no-privileges','-d',name],{},bytes);
async function columns(db){return (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows.reduce((map,row)=>{(map[row.table_name]??=[]).push(row.column_name);return map;},{});}
async function rows(db,table,fields){return (await db.query(`SELECT row_to_json(item)::text AS raw FROM (SELECT ${fields.map(quote).join(',')} FROM ${quote(table)}) item`)).rows.map(row=>row.raw);}
const summary=raw=>({count:raw.length,sha256:sha(Buffer.from([...raw].sort().join('\n')))});
async function snapshot(name){const db=await client(name);try{const fields=await columns(db),result={};for(const [table,list]of Object.entries(fields))result[table]=summary(await rows(db,table,list));const sequences=(await db.query("SELECT schemaname,sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;result._sequence_values=summary(sequences.map(item=>JSON.stringify(item)));return result;}finally{await db.end();}}
try{
 await admin.query(`CREATE DATABASE ${quote(database)}`);restore(database,originalDump);
 const beforeDb=await client(database),originalColumns=await columns(beforeDb),originalRaw={};for(const [table,fields]of Object.entries(originalColumns))originalRaw[table]=await rows(beforeDb,table,fields);
 const images=originalRaw.images.map(raw=>JSON.parse(raw));if(images.length!==assetInputs.length||images.some(image=>!assetInputs.some(asset=>asset.assetId===image.id&&asset.url===image.url)))throw new Error('Original image-byte manifest does not exactly cover the dump.');
 const originalRowsBefore=Object.fromEntries(Object.entries(originalRaw).map(([table,raw])=>[table,summary(raw)]));await beforeDb.end();
 save('migration.log',run(resolve(root,'node_modules/.bin/prisma'),['migrate','deploy'],{DATABASE_URL:url(database)}));
 const diffOutput=run(resolve(root,'node_modules/.bin/prisma'),['migrate','diff','--from-config-datasource','--to-schema','prisma/schema.prisma','--script'],{DATABASE_URL:url(database)}).toString();const schemaDiff=diffOutput.slice(diffOutput.indexOf('--')).trim();save('schema-diff.sql',schemaDiff+'\n');if(schemaDiff!=='-- This is an empty migration.')throw new Error('Migrated backup schema drifted. No destructive diff is applied.');
 run('docker',['exec','-i',container,'psql','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{},sql);
 // Run the actual built central service from the private cwd, where only the
 // explicitly preserved image files exist. No ambient .env is copied or read.
 const helper=`const {databaseService}=require(${JSON.stringify(resolve(root,'dist/lib/database'))});const redis=require(${JSON.stringify(resolve(root,'dist/lib/redis'))}).default;const {documentService}=require(${JSON.stringify(resolve(root,'dist/documents/service'))});
(async()=>{await databaseService.connect();const db=databaseService.client;const books=await db.book.findMany({where:{deletedAt:{}},select:{id:true,userId:true},orderBy:{id:'asc'}});for(const book of books){await documentService.registerSelectedArtworkForRelease(book.userId,book.id);await documentService.initialize(book.userId,book.id,{includeDeleted:true,source:'operator-backfill'});}const before=await db.bookDocumentHead.findMany({orderBy:{bookId:'asc'}});for(const book of books)await documentService.initialize(book.userId,book.id,{includeDeleted:true,source:'operator-backfill'});const after=await db.bookDocumentHead.findMany({orderBy:{bookId:'asc'}});if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Second backfill changed heads');require('node:fs').writeFileSync('backfill-heads.json',JSON.stringify({before,after}),{flag:'wx',mode:0o600});})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await databaseService.disconnect();redis.disconnect();});`;
 const helperPath=save('backfill.cjs',helper),backfill=spawnSync(process.execPath,[helperPath],{cwd:record,env:{...process.env,DATABASE_URL:url(database),REDIS_URL:'redis://127.0.0.1:56441/14',DOCUMENT_AUTHORITY_ENABLED:'false',USE_BULLMQ:'false'},maxBuffer:16*1024*1024,timeout:600000});save('backfill.log',Buffer.concat([backfill.stdout??Buffer.alloc(0),backfill.stderr??Buffer.alloc(0)]));if(backfill.status!==0)throw new Error('Isolated backfill failed; inspect the private record.');
 const afterDb=await client(database),originalRowsAfter={},normalizations=[];
 const registrations=(await afterDb.query("SELECT id,metadata FROM audit_log WHERE metadata->>'action'='backfill-selected-artwork-registration'")).rows;
 for(const [table,fields]of Object.entries(originalColumns)){
  let current=await rows(afterDb,table,fields);
  if(table==='images')current=current.map(raw=>{const image=JSON.parse(raw),old=images.find(item=>item.id===image.id);if(!old||image.config_json===old.config_json)return raw;const audit=registrations.find(item=>item.metadata.assetId===image.id&&item.metadata.oldConfigJson===old.config_json&&item.metadata.newConfigJson===image.config_json);if(!audit)throw new Error('Image metadata changed without the exact preserved original audit.');normalizations.push({table:'images',column:'config_json',assetId:image.id,auditId:audit.id,originalValueSha256:sha(Buffer.from(JSON.stringify(old.config_json))),auditOriginalValueSha256:sha(Buffer.from(JSON.stringify(audit.metadata.oldConfigJson))),registeredValueSha256:sha(Buffer.from(JSON.stringify(image.config_json)))});image.config_json=old.config_json;return JSON.stringify(image);});
  const counts=new Map();for(const raw of current)counts.set(raw,(counts.get(raw)??0)+1);const kept=[];for(const raw of originalRaw[table]){if(!counts.get(raw))throw new Error(`Original row/column bytes changed in ${table}; inspect protected clone.`);counts.set(raw,counts.get(raw)-1);kept.push(raw);}originalRowsAfter[table]=summary(kept);
 }
 const migrationCount=Number((await afterDb.query('SELECT count(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].count);const enabled=(await afterDb.query('SELECT enabled FROM proser_document_enforcement WHERE singleton')).rows[0]?.enabled;await afterDb.end();if(migrationCount!==pins.migrationCount||enabled!==false)throw new Error('Wrong isolated schema or activated guard.');
 const candidateRows=await snapshot(database),candidateDump=run('docker',['exec',container,'pg_dump','-U','postgres','-Fc',database]);save('candidate.dump',candidateDump);await admin.query(`CREATE DATABASE ${quote(first)}`);restore(first,candidateDump);const firstRestoreRows=await snapshot(first),restoredDump=run('docker',['exec',container,'pg_dump','-U','postgres','-Fc',first]);save('restored.dump',restoredDump);await admin.query(`CREATE DATABASE ${quote(second)}`);restore(second,restoredDump);const secondRestoreRows=await snapshot(second);
 if(JSON.stringify(candidateRows)!==JSON.stringify(firstRestoreRows)||JSON.stringify(candidateRows)!==JSON.stringify(secondRestoreRows))throw new Error('Candidate restore table/sequence evidence differs.');
 if(run('git',['rev-parse','HEAD']).toString().trim()!==candidate||(!diagnostic&&run('git',['status','--porcelain=v1','--untracked-files=all']).toString().trim()))throw new Error('Candidate changed during preservation rehearsal.');
 const heads=JSON.parse(readFileSync(resolve(record,'backfill-heads.json'),'utf8'));
 const evidence={schemaVersion:1,kind:'isolated-production-preservation-v2',candidateRevision:candidate,dirtyWorktree:dirty,productionMutation:false,database,firstRestoreDatabase:first,secondRestoreDatabase:second,migrationCount,enforcementSqlSha256:sha(sql),originalDumpSha256:sha(originalDump),candidateDumpSha256:sha(candidateDump),restoredDumpSha256:sha(restoredDump),backfillPasses:2,backfillHeadsBeforeSecond:heads.before,backfillHeadsAfterSecond:heads.after,originalRowScope:'all-original-ids-and-columns',originalRowNormalizations:normalizations,originalRowsBefore,originalRowsAfter,candidateRows,firstRestoreRows,secondRestoreRows,schemaDiff,assetBytes,completedAt:new Date().toISOString()};save('evidence.json',evidence);
 process.stdout.write(JSON.stringify({status:'passed',record,database,candidateRevision:candidate,productionMutation:false})+'\n');
}finally{await admin.end();}
