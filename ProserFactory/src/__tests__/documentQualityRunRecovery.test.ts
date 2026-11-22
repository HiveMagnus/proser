import {randomUUID} from 'node:crypto';
import {databaseService} from '@/lib/database';
import {benchmarkRunner} from '@/services/editorial/qualityLab/benchmarkRunner';
import {CandidateGenerator} from '@/services/editorial/candidates/candidateGenerator';
import {SceneProseService} from '@/services/sceneProseService';
describe('retained Quality Lab operation recovery',()=>{
 let userId:number;const db=()=>databaseService.client;
 beforeAll(async()=>{userId=(await db().user.create({data:{githubId:`quality-recovery-${randomUUID()}`,username:'Quality fixture'}})).id;});
 afterEach(async()=>{jest.restoreAllMocks();const runs=await db().evaluationRun.findMany({where:{userId},select:{id:true}});await db().evaluationResult.deleteMany({where:{evaluationRunId:{in:runs.map((row)=>row.id)}}});await db().evaluationRun.deleteMany({where:{userId}});});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});});
 test('deterministic report includes complete structured gates and refuses incompatible receipt reuse',async()=>{
  const key=randomUUID();const input={maximumCases:1};const first=await benchmarkRunner.run(userId,key,input);const report=first.report as Record<string,unknown>;
  expect(report.documentCorpus).toMatchObject({caseCount:16,liveCalls:0,passed:true});expect(report.release).toMatchObject({blocking:{structuredDocuments:true}});
  expect((await benchmarkRunner.run(userId,key,input)).id).toBe(first.id);expect(await db().evaluationResult.count({where:{evaluationRunId:first.id}})).toBe(1);
  await expect(benchmarkRunner.run(userId,key,{maximumCases:2})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
 });
 test('unknown live outcomes fail the retained report and exact receipt recovery performs no provider replay',async()=>{
  const plain=jest.spyOn(CandidateGenerator.prototype,'generate').mockRejectedValue(new Error('Unknown provider acknowledgement'));
  const structured=jest.spyOn(SceneProseService.prototype,'proposeDocumentEdits').mockRejectedValue(new Error('Unknown structured acknowledgement'));
  const key=randomUUID();const input={live:true,maximumCases:1};const first=await benchmarkRunner.run(userId,key,input);expect(first.status).toBe('failed');
  expect(first.report).toMatchObject({release:{blocking:{providerOutcomes:false,structuredDocuments:false}},documentCorpus:{liveCalls:2,passed:false}});
  expect(plain).toHaveBeenCalledTimes(1);expect(structured).toHaveBeenCalledTimes(2);expect((await benchmarkRunner.run(userId,key,input)).id).toBe(first.id);expect(plain).toHaveBeenCalledTimes(1);expect(structured).toHaveBeenCalledTimes(2);
 });
 test('cancellation leaves a terminal owner inspection receipt and a recovered key never starts inference again',async()=>{
  const abort=new AbortController();const infer=jest.spyOn(CandidateGenerator.prototype,'generate').mockImplementation(async()=>{abort.abort(new Error('Owner cancelled'));throw new Error('Provider interrupted');});
  const key=randomUUID();const input={live:true,maximumCases:1};await expect(benchmarkRunner.run(userId,key,input,abort.signal)).rejects.toThrow('Owner cancelled');
  const retained=await benchmarkRunner.run(userId,key,input);expect(retained.status).toBe('cancelled');expect(retained.report).toMatchObject({providerReplay:false,errorCode:'OWNER_OR_DEADLINE_CANCELLED'});expect(infer).toHaveBeenCalledTimes(1);
 });
});
