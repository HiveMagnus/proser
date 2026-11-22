#!/usr/bin/env node
/** Read-only installed-release inventory; safe to stream into `ssh proser node -`.
 * No queue constructors, expiry/recovery helpers, model calls or state writes. */
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const root = "/opt/proser-factory",
  require = createRequire(`${root}/package.json`);
const dotenv = require("dotenv"),
  pg = require("pg"),
  Redis = require("ioredis");
const env = {
  ...dotenv.parse(readFileSync(`${root}/.env`)),
  ...(existsSync(`${root}/.env.local`)
    ? dotenv.parse(readFileSync(`${root}/.env.local`))
    : {}),
};
const url = new URL(env.DATABASE_URL ?? "");
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/proser"
)
  throw new Error(
    "Installed inspector accepts only the local production proser database.",
  );
const cursors = JSON.parse(process.argv[2] ?? "{}"),
  limit = 100;
const db = new pg.Client({ connectionString: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 5000,
});
const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
function legacyArtifactInventory() {
  const directory = path.resolve(
    env.EXPORT_ARTIFACT_DIR || path.join(root, "data", "exports"),
  );
  const records = [];
  let totalBytes = 0,
    visited = 0;
  if (!existsSync(directory))
    return { configuredDirectory: directory, exists: false, records };
  for (const user of readdirSync(directory)) {
    if (!/^\d+$/.test(user)) continue;
    const userPath = path.join(directory, user);
    if (
      lstatSync(userPath).isSymbolicLink() ||
      !lstatSync(userPath).isDirectory()
    )
      throw new Error("Unexpected legacy artifact owner directory");
    for (const book of readdirSync(userPath)) {
      if (!/^\d+$/.test(book)) continue;
      const bookPath = path.join(userPath, book);
      if (
        lstatSync(bookPath).isSymbolicLink() ||
        !lstatSync(bookPath).isDirectory()
      )
        throw new Error("Unexpected legacy artifact book directory");
      for (const filename of readdirSync(bookPath)) {
        if (++visited > 10000)
          throw new Error("Legacy artifact inspection exceeds bounded entries");
        if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
        const manifestPath = path.join(bookPath, filename),
          bytesPath = manifestPath.replace(/\.json$/, ".md");
        const manifestInfo = lstatSync(manifestPath),
          bytesInfo = lstatSync(bytesPath);
        if (
          manifestInfo.isSymbolicLink() ||
          bytesInfo.isSymbolicLink() ||
          !manifestInfo.isFile() ||
          !bytesInfo.isFile() ||
          manifestInfo.size > 2 * 1024 * 1024 ||
          bytesInfo.size > 32 * 1024 * 1024 ||
          (totalBytes += manifestInfo.size + bytesInfo.size) > 256 * 1024 * 1024
        )
          throw new Error(
            "Legacy artifact files exceed read-only bounded inspection",
          );
        const manifestBytes = readFileSync(manifestPath),
          bytes = readFileSync(bytesPath),
          manifest = JSON.parse(manifestBytes);
        const checksum = digest(bytes);
        records.push({
          userId: Number(user),
          bookId: Number(book),
          artifactId: filename.slice(0, -5),
          manifestSha256: digest(manifestBytes),
          bytesSha256: checksum,
          byteLength: bytes.length,
          valid:
            manifest.userId === Number(user) &&
            manifest.bookId === Number(book) &&
            manifest.artifactId === filename.slice(0, -5) &&
            manifest.sha256 === checksum &&
            manifest.byteSize === bytes.length,
        });
      }
    }
  }
  return {
    configuredDirectory: directory,
    exists: true,
    records,
    totalBytes,
    complete: true,
  };
}
const page = (rows) => ({
  records: rows.slice(0, limit),
  nextCursor:
    rows.length > limit
      ? (rows[limit - 1].id ??
        rows[limit - 1].operation_id ??
        rows[limit - 1].resource_key)
      : null,
  truncated: rows.length > limit,
});
async function query(table, fields, where = "true", cursorColumn = "id") {
  const condition = cursors[table] ? `AND ${cursorColumn}>$1` : "";
  return page(
    (
      await db.query(
        `SELECT ${fields} FROM ${table} WHERE (${where}) ${condition} ORDER BY ${cursorColumn} LIMIT ${limit + 1}`,
        cursors[table] ? [cursors[table]] : [],
      )
    ).rows,
  );
}
try {
  await db.connect();
  await db.query("BEGIN READ ONLY");
  await db.query("SET LOCAL statement_timeout='10s'");
  const observedAt = new Date().toISOString();
  const admissionSupport = (
    await db.query(
      "SELECT to_regclass('release_admission_fence') IS NOT NULL AS supported,to_regclass('proser_document_enforcement') IS NOT NULL AS enforcement_installed",
    )
  ).rows[0];
  const migrations = (
    await db.query(
      "SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
    )
  ).rows;
  const domains = {
    workflows: await query(
      "workflow_runs",
      "id,book_id,status,phase,source_revision_id,result_revision_id,lease_owner,lease_expires_at,recovery_lease_owner,recovery_lease_expires_at,failure_class,started_at,finished_at",
      "status IN ('queued','running','paused','failed')",
    ),
    tasks: await query(
      "workflow_tasks",
      "id,run_id,task_type,status,input_revision_id,output_revision_id,lease_owner,error_code,started_at,finished_at",
      "status IN ('pending','running','failed')",
    ),
    outbox: await query(
      "workflow_enqueue_outbox",
      "id,run_id,status,attempt_count,available_at,lease_owner,lease_expires_at,processed_at",
      "status NOT IN ('dispatched','processed')",
    ),
    resources: await query(
      "shared_resource_operations",
      `operation_id,lease_id,state,claim_sha256,request_sha256,execution_kind,execution_id,CASE WHEN generation_idempotency_key IS NULL THEN NULL ELSE encode(sha256(convert_to(generation_idempotency_key,'UTF8')),'hex') END AS generation_idempotency_key_sha256,generation_request_hash,evidence_sha256,response_status,started_at,completed_at`,
      "state IN ('admitted','running','unknown') OR (started_at IS NOT NULL AND result_json IS NULL AND evidence_sha256 IS NULL)",
      "operation_id",
    ),
    fences: await query(
      "shared_resource_fences",
      "resource_key,highest_generation,operation_id,updated_at",
      "true",
      "resource_key",
    ),
  };
  await db.query("COMMIT");
  await redis.connect();
  const redisObservedAt = new Date().toISOString(),
    queues = [];
  for (const name of ["book-workflow-v1", "live-prose-judge"]) {
    const prefix = `${env.BULLMQ_PREFIX || "proser"}:${name}`;
    const paused = await redis.hget(`${prefix}:meta`, "paused");
    const counts = {};
    for (const key of ["wait", "active", "paused"])
      counts[key] = await redis.llen(`${prefix}:${key}`);
    for (const key of [
      "delayed",
      "failed",
      "completed",
      "waiting-children",
      "prioritized",
    ])
      counts[key] = await redis.zcard(`${prefix}:${key}`);
    const active = await redis.lrange(`${prefix}:active`, 0, limit);
    const failed = await redis.zrange(`${prefix}:failed`, 0, limit);
    const jobs = [];
    for (const [state, ids] of [
      ["active", active],
      ["failed", failed],
    ])
      for (const id of ids.slice(0, limit)) {
        const [name, processedOn, finishedOn, attemptsMade, failedReason] =
          await redis.hmget(
            `${prefix}:${id}`,
            "name",
            "processedOn",
            "finishedOn",
            "atm",
            "failedReason",
          );
        jobs.push({
          id,
          state,
          name,
          processedOn,
          finishedOn,
          attemptsMade,
          failureReasonSha256: failedReason ? digest(failedReason) : null,
        });
      }
    queues.push({
      name,
      paused: paused === "1",
      counts,
      jobs,
      truncated: active.length > limit || failed.length > limit,
    });
  }
  const scanCursor = String(cursors.redis ?? "0");
  if (!/^\d+$/.test(scanCursor)) throw new Error("Invalid Redis cursor.");
  const [nextCursor, keys] = await redis.scan(
    scanCursor,
    "MATCH",
    "proser:generation:v2:operation:*",
    "COUNT",
    50,
  );
  if (keys.length > 256)
    throw new Error("Redis page exceeds bounded inspection; none dropped.");
  const fields = [
    "id",
    "userId",
    "status",
    "requestHash",
    "createdAt",
    "updatedAt",
    "leaseOwner",
    "leaseExpiresAt",
    "errorCode",
    "pendingExpiresAt",
    "absoluteExpiresAt",
    "artifactHash",
    "provisionalArtifactHash",
    "latestCursor",
    "oldestCursor",
    "cancelRequested",
  ];
  const generation = [];
  for (const key of keys) {
    const values = await redis.hmget(key, ...fields);
    generation.push(
      Object.fromEntries(fields.map((field, index) => [field, values[index]])),
    );
  }
  const result = {
    schemaVersion: 1,
    kind: "read-only-installed-release-inventory",
    factoryRevision: readFileSync(`${root}/REVISION`, "utf8").trim(),
    databaseObservedAt: observedAt,
    redisObservedAt,
    admissionSupport,
    migrations,
    domains,
    legacyArtifacts: legacyArtifactInventory(),
    redis: { nextCursor, generation, queues },
    productionMutation: false,
    limits:
      "SQL pages and Redis scans are independent observations. Repeat complete pages after an actual admission cutoff. Empty queues do not settle unknown provider effects.",
  };
  result.metadataSha256 = digest(result);
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await db.end();
  redis.disconnect();
}
