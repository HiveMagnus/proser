/**
 * Container healthcheck for the worker service: exits 0 when this container's
 * worker process has published a fresh heartbeat for every required queue,
 * the same receipt Factory readiness depends on.
 *   node dist/workers/healthcheck.js
 */
import fs from 'node:fs';
import redis from '../lib/redis';
import { workerInstanceFile, workerInstanceReady } from './heartbeat';

async function main(): Promise<number> {
  let instanceId: string;
  try {
    instanceId = fs.readFileSync(workerInstanceFile(), 'utf8').trim();
  } catch {
    process.stderr.write('No worker heartbeat has started in this container yet.\n');
    return 1;
  }
  try {
    await redis.connect().catch(() => undefined);
    if (await workerInstanceReady(instanceId)) return 0;
    process.stderr.write('The worker heartbeat is missing, stale or does not cover every required queue.\n');
    return 1;
  } finally {
    redis.disconnect();
  }
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`Worker healthcheck failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
