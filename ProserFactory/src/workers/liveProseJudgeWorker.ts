import {DocumentError} from '@/documents/errors';
import {releaseAdmissionsOpen,runAdmittedBackground} from '@/operations/releaseAdmission';
import {DelayedError} from 'bullmq';
import { Job, Worker } from 'bullmq';
import { buildWorkerOptions } from '../queues/connection';
import { LIVE_PROSE_JUDGE_QUEUE_NAME, type LiveProseJudgePayload } from '../queues/liveProseJudgeQueue';
import logger from '../lib/logger';
import { submitLiveProseJudge } from '../services/liveProseJudgeService';
import { proseTraceService } from '../services/proseTraceService';
import { isBookAiDisabledError, runWithAiBookScope } from '../lib/ai/bookAiPolicy';

async function processLiveProseJudge(job: Job<LiveProseJudgePayload>,token?:string): Promise<void> {
  if(!await releaseAdmissionsOpen()){await job.moveToDelayed(Date.now()+1000,token);throw new DelayedError();}
  try{return await runAdmittedBackground('live-prose-judge',String(job.id),undefined,()=>processAdmittedJudge(job));}catch(error){if(error instanceof DocumentError&&error.code==='DOCUMENT_ADMISSIONS_FENCED'){await job.moveToDelayed(Date.now()+1000,token);throw new DelayedError();}throw error;}
}
async function processAdmittedJudge(job: Job<LiveProseJudgePayload>): Promise<void> {
  try {
    const result = await runWithAiBookScope([job.data.bookId], () => submitLiveProseJudge(job.data));
    await proseTraceService.finalizeTraceFromEvaluation(job.data.traceId, result);
  } catch (error) {
    await proseTraceService.markTraceFailed(
      job.data.traceId,
      error instanceof Error ? error.message : String(error),
    );
    // Retrying cannot succeed while the book's AI is switched off.
    if (isBookAiDisabledError(error)) return;
    throw error;
  }
}

export function startLiveProseJudgeWorker() {
  const worker = new Worker<LiveProseJudgePayload>(LIVE_PROSE_JUDGE_QUEUE_NAME, processLiveProseJudge, buildWorkerOptions());
  worker.on('completed', (job) => logger.info({ jobId: job.id, traceId: job.data.traceId }, 'Live prose judge job completed'));
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, traceId: job?.data?.traceId, err: err?.message }, 'Live prose judge job failed'));
  return worker;
}
