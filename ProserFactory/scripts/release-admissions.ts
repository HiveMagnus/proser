import {runReleaseMaintenance,type ReleaseMaintenanceInput} from '../src/operations/releaseMaintenance';
/** Default read-only. No production action is authorized by implementation. */
import 'dotenv/config';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {databaseService} from '../src/lib/database';
import redis from '../src/lib/redis';
import {getWorkflowQueue,shutdownWorkflowQueue} from '../src/queues/workflowQueue';
import {shutdownBullConnections} from '../src/queues/connection';
import {getLiveProseJudgeQueue} from '../src/queues/liveProseJudgeQueue';
import {generationReplayService} from '../src/services/generationReplayService';
import {releaseInventory,transitionRelease,validateReleaseProof,type ReleaseTransition} from '../src/operations/releaseTransition';
const option=(name:string)=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const judge=getLiveProseJudgeQueue();
async function main(){
 await databaseService.connect();const action=process.argv[2]??'status';if(!['status','preview','close','reopen','drain','maintenance'].includes(action))throw new Error('Invalid release action');
 const queues=[getWorkflowQueue(),judge];
 const snapshot=async()=>({database:await releaseInventory(option('--cursor'),Number(option('--limit')??50),JSON.parse(option('--domain-cursors')??'{}'),option('--binding-cursor')),redis:await generationReplayService.releaseInventory(option('--redis-cursor')??'0'),queues:await Promise.all(queues.map(async queue=>({name:queue.name,observedAt:new Date().toISOString(),paused:await queue.isPaused(),counts:await queue.getJobCounts('active','waiting','delayed','paused','failed')})))});
 let result:unknown;if(['status','preview'].includes(action)||!process.argv.includes('--apply')&&action!=='drain'){result={mode:'preview',requestedAction:action,...await snapshot()};}
 else if(action==='drain'){
  const maximumMs=Math.min(60000,Math.max(0,Number(option('--max-ms')??10000)));const deadline=Date.now()+maximumMs;const observations:unknown[]=[];let stable=0;let previous='';
  do{const value=await snapshot();if(value.database.fence.phase!=='fenced')throw new Error('Drain requires an existing exact closed fence; it never closes admissions implicitly.');const current=digest(Buffer.from(JSON.stringify({domains:value.database.domains,redis:value.redis.records,queues:value.queues.map(q=>({name:q.name,counts:q.counts}))})));stable=current===previous?stable+1:0;previous=current;observations.push(value);if(stable>=1||Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<deadline);
  result={mode:'observation-only',stableSnapshots:stable>=1,observations,authorization:'A stable page does not settle unknown, unbound or truncated effects. Complete all cursor pages and retain reviewed exact handoff before stopping services.'};
 }else{
  const proofFile=option('--proof-file');if(!proofFile)throw new Error('Reviewed candidate-specific proof is required.');const bytes=await fs.readFile(proofFile);const proof=JSON.parse(bytes.toString('utf8'));const input={operationId:option('--operation-id'),releaseId:option('--release-id'),action,expectedGeneration:Number(option('--expected-generation')),candidateSha:option('--candidate-sha'),proofSha:option('--proof-sha'),proof,operator:os.userInfo().username} as ReleaseTransition;
  if(digest(bytes)!==input.proofSha)throw new Error('Proof file digest differs from exact reviewed proof SHA.');validateReleaseProof(proof,{...input,action:action==='maintenance'?'close':input.action});
  const sql=await fs.readFile(path.resolve('deploy/document-authority/enforcement.sql'));if(digest(sql)!==proof.enforcementSqlSha)throw new Error('Enforcement candidate SHA changed; rehearse/review the exact candidate.');
  if(proof.environment==='production'){const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();if(revision!==input.candidateSha||dirty)throw new Error('Production release operator requires exact clean reviewed Git candidate.');}
  result=action==='maintenance'?await runReleaseMaintenance({operationId:input.operationId,releaseId:input.releaseId,generation:input.expectedGeneration,candidateSha:input.candidateSha,proofSha:input.proofSha,userId:Number(option('--user-id')),bookIds:(option('--book-ids')??'').split(',').filter(Boolean).map(Number),action:option('--maintenance-action'),operator:input.operator} as ReleaseMaintenanceInput,bytes):await transitionRelease(input,queues);
 }
 const out=option('--out');if(out){await fs.mkdir(path.dirname(path.resolve(out)),{recursive:true,mode:0o700});await fs.writeFile(out,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});process.stdout.write(JSON.stringify({record:path.resolve(out),mode:action})+'\n');}else process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'Release admission operation failed'}\n`);process.exitCode=1;}).finally(async()=>{await judge.close();await shutdownWorkflowQueue();await shutdownBullConnections();await databaseService.disconnect();redis.disconnect();});
