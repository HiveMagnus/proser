import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixtureUrl = process.env.REDIS_URL;
if (
  !fixtureUrl ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(fixtureUrl).hostname)
) {
  throw new Error(
    "Set REDIS_URL to an isolated loopback Redis before running worker acceptance.",
  );
}
process.env.BULLMQ_PREFIX = `proser-document-check-${randomUUID()}`;
process.env.PROSER_WORKER_INSTANCE_FILE = join(
  mkdtempSync(join(tmpdir(), "proser-worker-")),
  "instance",
);
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { Worker, Queue, QueueEvents } = require("bullmq");
const redis = require("./dist/lib/redis").default;
const {
  startWorkerHeartbeat,
  workersReady,
  workerInstanceReady,
  requiredWorkerQueues,
} = require("./dist/workers/heartbeat");
const workers = [];
const queues = [];
const events = [];
const connections = [];
let stop;
try {
  for (const name of requiredWorkerQueues) {
    const consumer = redis.duplicate({ maxRetriesPerRequest: null });
    const eventConnection = redis.duplicate({ maxRetriesPerRequest: null });
    connections.push(consumer, eventConnection);
    workers.push(
      new Worker(name, async (job) => ({ receipt: job.data.receipt }), {
        connection: consumer,
        prefix: process.env.BULLMQ_PREFIX,
      }),
    );
    queues.push(
      new Queue(name, { connection: redis, prefix: process.env.BULLMQ_PREFIX }),
    );
    const listener = new QueueEvents(name, {
      connection: eventConnection,
      prefix: process.env.BULLMQ_PREFIX,
    });
    events.push(listener);
    await listener.waitUntilReady();
  }
  assert.equal(
    await workersReady(),
    false,
    "A Redis ping cannot prove consumers are live.",
  );
  stop = await startWorkerHeartbeat(workers);
  assert.equal(
    await workersReady(),
    true,
    "Ready consumers must publish fresh receipts.",
  );
  const instance = readFileSync(
    process.env.PROSER_WORKER_INSTANCE_FILE,
    "utf8",
  ).trim();
  assert.equal(
    await workerInstanceReady(instance),
    true,
    "The container healthcheck must see this process's receipt.",
  );
  assert.equal(
    await workerInstanceReady(randomUUID()),
    false,
    "Another instance's receipt must not satisfy the healthcheck.",
  );
  for (const [index, queue] of queues.entries()) {
    const receipt = randomUUID();
    const job = await queue.add("disposable-acceptance", { receipt });
    assert.deepEqual(await job.waitUntilFinished(events[index], 10_000), {
      receipt,
    });
  }
  await workers[0].pause();
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(
    await workersReady(),
    false,
    "Paused consumers must not establish readiness.",
  );
  assert.equal(
    await workerInstanceReady(instance),
    false,
    "A paused consumer must fail the container healthcheck.",
  );
  await stop();
  stop = undefined;
  assert.equal(
    await workersReady(),
    false,
    "Stopped receipts must be withdrawn.",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "fresh receipts",
        "both queue consumers",
        "paused consumer",
        "container healthcheck",
        "withdrawal",
      ],
      fixturePrefix: process.env.BULLMQ_PREFIX,
    }),
  );
} finally {
  await stop?.();
  await Promise.all(workers.map((worker) => worker.close(true)));
  await Promise.all(events.map((listener) => listener.close()));
  for (const queue of queues) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await Promise.all(connections.map((connection) => connection.quit()));
  await redis.quit();
}
