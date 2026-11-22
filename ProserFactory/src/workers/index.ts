import { startLiveProseJudgeWorker } from './liveProseJudgeWorker';
import { recoverOrphanedWorkflowRuns, startWorkflowWorker } from './workflowWorker';
import logger from '../lib/logger';
import { isBullmqEnabled } from '../queues/featureFlag';
import { databaseService } from '../lib/database';
import { dispatchWorkflowOutbox } from '../queues/workflowOutbox';
import { startWorkerHeartbeat } from './heartbeat';

export function startAllWorkers() {
  if (!isBullmqEnabled()) {
    logger.warn('USE_BULLMQ is not enabled — workers will not process jobs. Set USE_BULLMQ=true to enable.');
  }
  logger.info('Starting workers...');
  const workers = [startLiveProseJudgeWorker(), startWorkflowWorker()];
  logger.info({ workerCount: workers.length }, 'All workers started and listening for jobs');
  return workers;
}

// Always start workers when this file is loaded as the entry point.
// `require.main === module` does NOT work under tsx, so we detect the
// entry-point via the absence of a parent module or an explicit env flag.
const isEntryPoint =
  // Classic CJS check
  require.main === module ||
  // tsx / ts-node / direct execution fallback
  process.argv[1]?.includes('workers/index') ||
  process.argv[1]?.includes('workers\\index');

if (isEntryPoint) {
  databaseService.connect()
    .then(async () => {
      const workers = startAllWorkers();
      if (isBullmqEnabled()) await startWorkerHeartbeat(workers);
      // BullMQ needs one stalled-check interval to release locks held by a
      // process that disappeared during a deploy. Reconcile immediately and
      // periodically so Hermes can disconnect without stranding the run.
      await recoverOrphanedWorkflowRuns();
      await dispatchWorkflowOutbox();
      const recoveryTimer = setInterval(() => {
        void recoverOrphanedWorkflowRuns();
        void dispatchWorkflowOutbox();
      }, 30_000);
      recoveryTimer.unref();
    })
    .catch((error) => {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Worker startup failed');
      process.exit(1);
    });
}
