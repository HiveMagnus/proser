import { loadDocumentCorpus } from '@/services/editorial/qualityLab/documentCorpus';
import { runDocumentBenchmark } from '@/services/editorial/qualityLab/documentBenchmark';
import type { SceneProseService } from '@/services/sceneProseService';
describe('versioned structured Quality Lab acceptance',()=>{
 test('hash-validates fixtures, isolates hidden outcomes, and checks complete preservation/stale-target corpus',async()=>{
  const corpus=await loadDocumentCorpus();expect(corpus.cases).toHaveLength(16);expect(JSON.stringify(corpus.cases.map((item)=>item.input))).not.toContain('expectedVerdict');expect(JSON.stringify(corpus.cases.map((item)=>item.input))).not.toContain('errorIncludes');
  const first=await runDocumentBenchmark();const again=await runDocumentBenchmark();expect(first.passed).toBe(true);expect(first.liveCalls).toBe(0);expect(first.rows.every((row)=>row.preservation&&row.matched)).toBe(true);
  expect(first.rows.map((row)=>row.resultHash)).toEqual(again.rows.map((row)=>row.resultHash));expect(first.rows.filter((row)=>row.outcome==='applied')).toHaveLength(4);
 });
 test('live mode clamps inference to two complete exact targets and records reported provenance without exposing scorer expectations',async()=>{
  const inference=jest.fn<ReturnType<SceneProseService['proposeDocumentEdits']>,Parameters<SceneProseService['proposeDocumentEdits']>>().mockImplementation(async(snapshot)=>({raw:JSON.stringify({reply:'An exact edit.',edits:[{targetId:snapshot.targets[0].targetId,sourceText:snapshot.targets[0].sourceText,replacement:snapshot.targets[0].sourceText.replace('phrase','wording')}]}),provenance:{providerId:'fixture',configuredModel:'fixture-model',reportedModel:'fixture-model-returned',usage:{totalTokens:24},params:{temperature:0.1},recipe:'document-proposal',recipeVersion:'fixture-v1'}}));
  const report=await runDocumentBenchmark({maximumLiveCases:999,provider:{proposeDocumentEdits:inference}});expect(report.liveCalls).toBe(2);expect(report.maximumLiveCases).toBe(2);expect(report.passed).toBe(true);expect(inference).toHaveBeenCalledTimes(2);
  for(const [snapshot,,options] of inference.mock.calls){expect(snapshot.blocks).toHaveLength(1);expect(snapshot.blocks[0].id).toBe(snapshot.targets[0].blockId);expect(JSON.stringify(snapshot)).not.toContain('expectedHash');expect(options).toMatchObject({retries:1,noTransportReplay:true,timeoutMs:45000});}
  const live=report.rows.filter((row)=>row.providerOutcome==='acknowledged');expect(live).toHaveLength(2);expect(live[0].provenance).toMatchObject({configuredModel:'fixture-model',reportedModel:'fixture-model-returned'});expect(live[0].inferenceTokens).toBe(24);expect(live[0].responseHash).toMatch(/^[a-f0-9]{64}$/);
 });
 test('unknown or invalid provider outcomes fail acceptance, preserve sources and never replay the affected case',async()=>{
  const inference=jest.fn().mockRejectedValue(new Error('Lost provider acknowledgement'));const report=await runDocumentBenchmark({maximumLiveCases:1,provider:{proposeDocumentEdits:inference}});
  expect(inference).toHaveBeenCalledTimes(1);expect(report.passed).toBe(false);const unknown=report.rows.find((row)=>row.providerOutcome==='unknown')!;expect(unknown.providerFailure).toContain('Lost provider');expect(unknown.sourceHash).toBe(unknown.resultHash);expect(unknown.provenance.providerId).toBe('unacknowledged-provider');
  const invalid=jest.fn().mockResolvedValue({raw:JSON.stringify({reply:'Forged edit.',edits:[{targetId:'forged-target',sourceText:'wrong',replacement:'wrong'}]}),provenance:{providerId:'fixture',params:{},recipe:'fixture',recipeVersion:'1'}});
  const rejected=await runDocumentBenchmark({maximumLiveCases:1,provider:{proposeDocumentEdits:invalid}});expect(rejected.passed).toBe(false);expect(rejected.rows[0]).toMatchObject({providerOutcome:'acknowledged',outcome:'rejected',preservation:true});expect(rejected.rows[0].sourceHash).toBe(rejected.rows[0].resultHash);
 });
 test('caller cancellation bounds even a provider that ignores its signal',async()=>{
  const controller=new AbortController();const inference=jest.fn().mockImplementation(()=>{controller.abort(new Error('Owner cancelled'));return new Promise(()=>undefined);});
  await expect(runDocumentBenchmark({maximumLiveCases:1,signal:controller.signal,provider:{proposeDocumentEdits:inference}})).rejects.toThrow('Owner cancelled');expect(inference).toHaveBeenCalledTimes(1);
 });
});
