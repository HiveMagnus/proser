import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const renderer=resolve('document-tools/render-docx.sh');
for(const generate of [false,true])test(`LibreOffice exit0 ${generate?'copies a fresh result':'cannot reuse prior PDF proof'}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'proser-render-freshness-'));try{
  const bin=join(root,'bin'),output=join(root,'output');await mkdir(bin);await mkdir(output);const source=join(root,'fixture.docx');await writeFile(source,'synthetic source');await writeFile(join(output,'fixture.pdf'),'old proof');
  await writeFile(join(bin,'libreoffice'),'#!/usr/bin/env bash\nwhile [[ "$#" -gt 0 ]]; do if [[ "$1" == --outdir ]]; then target="$2"; shift 2; else shift; fi; done\nif [[ "$FAKE_LO_WRITES" == yes ]]; then printf "new proof" > "$target/fixture.pdf"; fi\nexit 0\n',{mode:0o755});
  const result=spawnSync('bash',[renderer,'freshness-test',output,source],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,FAKE_LO_WRITES:generate?'yes':'no'}});
  assert.equal(result.status,generate?0:1);assert.equal(await readFile(join(output,'fixture.pdf'),'utf8'),generate?'new proof':'old proof');
  const current=(await readdir(output)).find(name=>name.startsWith('conversion.'));assert(current);assert.deepEqual(JSON.parse(await readFile(join(output,current,'render-status.json'),'utf8')),{commandStatus:0,timeoutSeconds:600});
  if(!generate)assert.match(result.stderr,/No new PDF/);
 }finally{await rm(root,{recursive:true,force:true});}
});
