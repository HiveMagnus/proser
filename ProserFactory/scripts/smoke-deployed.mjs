#!/usr/bin/env node
/**
 * Integration smoke tests against a live ProserFactory deployment.
 *
 * Uses INTERNAL_API_SECRET to seed test data and FACTORY_AUTH_SECRET to mint
 * short-lived production-equivalent bearer tokens.
 *
 * Validates that the deployed system actually works end-to-end:
 *   - Health endpoint returns healthy for DB + Redis
 *   - Public readiness reports bounded component status without runtime internals
 *   - AI inference (configured llama.cpp) generates real prose
 *   - Leonardo Forge image health is reachable
 *   - Private image generation/content is tenant-isolated and disposable
 *   - Workflow v1 lifecycle (start → dedupe → status/events → pause/resume/cancel)
 *   - Rate limiting is enforced (Redis-backed)
 *
 * Usage:
 *   node scripts/smoke-deployed.mjs [baseUrl]
 *
 * Credentials are read from the process environment or the private local environment files.
 * Env vars:
 *   SMOKE_BASE_URL    — default: http://127.0.0.1:3001
 *   INTERNAL_API_SECRET — for sync-user seeding
 *   FACTORY_AUTH_SECRET — for issuer/audience-bound smoke JWTs
 *
 * Exit code: 0 on success, 1 on any failure.
 */

import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runDocumentAuthoritySmoke } from "./smoke-document-authority.mjs";
import dotenv from "dotenv";

if (process.argv.length > 3) {
  throw new Error(
    "Supply only the base URL. Set smoke credentials in the environment.",
  );
}
const inheritedSecrets = Object.fromEntries(
  ["INTERNAL_API_SECRET", "FACTORY_AUTH_SECRET", "METRICS_TOKEN"]
    .map((key) => [key, process.env[key]])
    .filter(([, value]) => value !== undefined),
);
dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: true, quiet: true });
Object.assign(process.env, inheritedSecrets);

const base = (
  process.argv[2] ||
  process.env.SMOKE_BASE_URL ||
  "http://127.0.0.1:3001"
).replace(/\/+$/, "");
const endpoint = new URL(base);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
  endpoint.hostname,
);
if (
  endpoint.username ||
  endpoint.password ||
  (endpoint.protocol !== "https:" &&
    !(loopback && endpoint.protocol === "http:"))
) {
  throw new Error("Provide HTTPS for a remote Factory or HTTP on loopback.");
}
const internalSecret = process.env.INTERNAL_API_SECRET || "";
const factoryAuthSecret = process.env.FACTORY_AUTH_SECRET || "";
const metricsToken = process.env.METRICS_TOKEN || "";
const TAG = `smoke-${Date.now()}`;
let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}
function fail(name, reason) {
  failed++;
  console.error(`  ✗ ${name}: ${reason}`);
}

function authHeaders(user) {
  const token = jwt.sign(
    {
      sub: `smoke:${user.githubId}`,
      githubId: user.githubId,
      username: user.username,
    },
    factoryAuthSecret,
    {
      algorithm: "HS256",
      issuer: "proser-author",
      audience: "proser-factory",
      expiresIn: "10m",
    },
  );
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function request(
  method,
  urlPath,
  body,
  headers = {},
  timeoutMs = 60_000,
) {
  const url = `${base}${urlPath}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    signal: ac.signal,
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    clearTimeout(timer);
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json, bytes, headers: res.headers };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── Test: Health ───────────────────────────────────────────────
async function testHealth() {
  console.log("\n[Health]");
  try {
    const { status, json } = await request("GET", "/health");
    if (status === 200 && json?.status === "ok") {
      ok("Health endpoint returns 200");
    } else {
      fail("Health endpoint", `status=${status} body=${JSON.stringify(json)}`);
    }
    const redis = json?.services?.redis;
    if (redis?.status === "healthy") {
      ok("Redis is healthy");
    } else {
      fail("Redis health", `${JSON.stringify(redis)}`);
    }
    const db = json?.services?.database;
    if (db?.status === "healthy") {
      ok("Database is healthy");
    } else {
      fail("Database health", `${JSON.stringify(db)}`);
    }
  } catch (e) {
    fail("Health endpoint", e.message);
  }
}

// ── Test: Readiness Runtime Telemetry ──────────────────────────
async function testReadinessRuntime() {
  console.log("\n[Readiness / Runtime]");
  try {
    const { status, json } = await request("GET", "/api/readiness");
    const data = json?.data;
    if (status === 200 && data?.ready) {
      ok("Readiness endpoint returns ready");
    } else {
      fail(
        "Readiness endpoint",
        `status=${status} body=${JSON.stringify(json)?.slice(0, 300)}`,
      );
    }
    if (
      data?.components?.database === "ready" &&
      ["healthy", "disabled"].includes(data?.components?.redis) &&
      data?.components?.editorialRegistry === "ready" &&
      data?.components?.editorialCorpus === "ready"
    ) {
      ok("Public readiness reports healthy components");
    } else {
      fail("Readiness components", JSON.stringify(data?.components));
    }
    if (!("runtime" in (data || {})) && !("ai" in (data || {}))) {
      ok("Public readiness omits private runtime details");
    } else {
      fail("Readiness disclosure", JSON.stringify(data));
    }
  } catch (e) {
    fail("Readiness runtime", e.message);
  }
}

async function testMetricsSecurity() {
  console.log("\n[Metrics Security]");
  try {
    const unauthenticated = await request("GET", "/api/metrics");
    if (unauthenticated.status === 401)
      ok("Metrics rejects an unauthenticated scrape");
    else
      fail(
        "Metrics authentication boundary",
        `status=${unauthenticated.status}`,
      );
    const authenticated = await request("GET", "/api/metrics", null, {
      "x-metrics-token": metricsToken,
    });
    if (
      authenticated.status === 200 &&
      authenticated.json?.data?.editorial?.counters &&
      authenticated.json?.data?.editorial?.durations &&
      !("durable" in authenticated.json.data.editorial)
    ) {
      ok(
        "Metrics returns incremental editorial counters without scrape-time history",
      );
    } else {
      fail(
        "Metrics incremental snapshot",
        `status=${authenticated.status} body=${JSON.stringify(authenticated.json)?.slice(0, 300)}`,
      );
    }
  } catch (e) {
    fail("Metrics security", e.message);
  }
}

// ── Test: Inference Reachability (via /api/models) ─────────────
async function testModels() {
  console.log("\n[Models / Inference]");
  try {
    const { status, json } = await request(
      "GET",
      "/api/models",
      null,
      authHeaders(globalUser),
    );
    if (status === 200 && json?.data?.length > 0) {
      ok(
        `Inference reachable — ${json.data.length} model(s): ${json.data.map((m) => m.id).join(", ")}`,
      );
    } else {
      fail(
        "Models endpoint",
        `status=${status} body=${JSON.stringify(json)?.slice(0, 200)}`,
      );
    }
  } catch (e) {
    fail("Models endpoint", e.message);
  }
}

// ── Test: Leonardo / Forge Reachability ────────────────────────
async function testImagesHealth() {
  console.log("\n[Images / Leonardo]");
  try {
    const { status, json } = await request(
      "GET",
      "/api/images/health",
      null,
      authHeaders(globalUser),
      20_000,
    );
    if (
      status === 200 &&
      json?.success &&
      json?.data?.forge === "reachable" &&
      json?.data?.hasTxt2Img !== false
    ) {
      ok("Leonardo Forge reachable with txt2img");
    } else {
      fail(
        "Image health",
        `status=${status} body=${JSON.stringify(json)?.slice(0, 300)}`,
      );
    }
  } catch (e) {
    fail("Image health", e.message);
  }
}

// ── Test: Private Image Round Trip ─────────────────────────────
async function testPrivateImageRoundTrip(user) {
  console.log("\n[Private Images]");
  try {
    const generated = await request(
      "POST",
      "/api/images/generate",
      {
        prompt: "A single blue circle on a plain white background",
        n: 1,
        size: "512x512",
        bookId: globalBookId,
      },
      authHeaders(user),
      180_000,
    );
    globalImageId = generated.json?.data?.assets?.[0]?.id;
    const protectedUrl = generated.json?.data?.assets?.[0]?.url;
    if (
      generated.status === 200 &&
      globalImageId &&
      protectedUrl === `/api/images/${globalImageId}/content`
    ) {
      ok(`Private image generated (id=${globalImageId})`);
    } else {
      fail(
        "Private image generation",
        `status=${generated.status} body=${JSON.stringify(generated.json)?.slice(0, 300)}`,
      );
      return;
    }

    const owned = await request("GET", protectedUrl, null, authHeaders(user));
    if (owned.status === 200) ok("Owner can fetch private image content");
    else fail("Private image owner fetch", `status=${owned.status}`);

    const denied = await request(
      "GET",
      protectedUrl,
      null,
      authHeaders(otherUser),
    );
    if (denied.status === 404) ok("Cross-tenant image content access denied");
    else fail("Private image tenant isolation", `status=${denied.status}`);
  } catch (e) {
    fail("Private image round trip", e.message);
  }
}

// ── Test: AI Prose Generation ──────────────────────────────────
async function testProseGeneration(user) {
  console.log("\n[Prose Generation]");
  try {
    // A missing/failed acknowledgement does not prove a provider effect absent.
    // Dispatch once; recover exact durable operations rather than retrying prose.
    const { status, json } = await request(
      "POST",
      "/api/generate/prose",
      {
        bookId: globalBookId,
        targetWords: 250,
        prompt:
          "Write a self-contained 250-word scene about a cat sitting on a fence. End at a natural stopping point.",
      },
      authHeaders(user),
      300_000,
    );
    if (status === 200 && json?.success) {
      const text =
        json?.data?.text ||
        json?.data?.content ||
        JSON.stringify(json?.data).slice(0, 200);
      if (text && text.length > 5) {
        ok(`Prose generated (${text.length} chars)`);
      } else {
        fail("Prose generation", `Response too short: "${text}"`);
      }
    } else {
      fail(
        "Prose generation",
        `status=${status} error=${json?.error?.message || json?.error || "unknown"}`,
      );
    }

    const operationKey = `smoke:generation:${TAG}`;
    const createdOperation = await request(
      "POST",
      "/api/generate/operations",
      {
        kind: "prose",
        bookId: globalBookId,
        targetWords: 100,
        prompt: "Write one short paragraph about a safe harbor.",
      },
      { ...authHeaders(user), "Idempotency-Key": operationKey },
    );
    const operationId = createdOperation.json?.data?.operationId;
    if ([200, 202].includes(createdOperation.status) && operationId) {
      ok("Generation operation returned a durable idempotent receipt");
    } else {
      fail(
        "Generation operation receipt",
        `status=${createdOperation.status} body=${JSON.stringify(createdOperation.json)}`,
      );
      return;
    }

    const streamed = await request(
      "GET",
      `/api/generate/operations/${operationId}/stream?cursor=0&limit=500`,
      null,
      authHeaders(user),
      300_000,
    );
    const frames = streamed.text
      .split(/\r?\n\r?\n/)
      .filter(Boolean)
      .map((block) => {
        const event = block.match(/^event: (.+)$/m)?.[1] || "message";
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!data) return { event, data: null };
        try {
          return { event, data: JSON.parse(data) };
        } catch {
          return { event, data: null };
        }
      })
      .filter((frame) => frame.data !== null);
    const start = frames.find((frame) => frame.event === "start")?.data;
    const tokens = frames.filter((frame) => frame.event === "token");
    const meta = frames.find((frame) => frame.event === "meta")?.data;
    const done = frames.find((frame) => frame.event === "done")?.data;
    const consistent =
      start?.operationId === operationId &&
      tokens.length > 0 &&
      frames.every(
        (frame) =>
          Number.isInteger(frame.data?.cursor) &&
          frame.data?.operationId === operationId,
      ) &&
      tokens.every((frame) => typeof frame.data?.text === "string") &&
      meta?.terminalReason === "stop" &&
      meta?.authoritative === true &&
      /^[a-f0-9]{64}$/.test(meta?.artifactHash || "") &&
      done?.status === "committed" &&
      done?.artifactHash === meta?.artifactHash;
    if (streamed.status === 200 && consistent)
      ok("Generation SSE commits one JSON-framed operation after metadata");
    else
      fail(
        "Generation SSE protocol",
        `status=${streamed.status} frames=${frames.map((frame) => frame.event).join(",")}`,
      );

    const replayed = await request(
      "GET",
      `/api/generate/operations/${operationId}/stream?cursor=${start.cursor}&limit=500`,
      null,
      authHeaders(user),
    );
    const replayFrames = replayed.text
      .split(/\r?\n\r?\n/)
      .filter(Boolean)
      .map((block) => ({
        event: block.match(/^event: (.+)$/m)?.[1] || "message",
        data: (() => {
          try {
            return JSON.parse(block.match(/^data: (.+)$/m)?.[1] || "null");
          } catch {
            return null;
          }
        })(),
      }));
    const replayDone = replayFrames.find(
      (frame) => frame.event === "done",
    )?.data;
    if (
      replayed.status === 200 &&
      replayFrames.every((frame) => frame.data?.cursor > start.cursor) &&
      replayDone?.artifactHash === done?.artifactHash
    ) {
      ok(
        "Generation SSE resumes from a bounded cursor with matching artifact hash",
      );
    } else
      fail(
        "Generation SSE replay",
        `status=${replayed.status} frames=${replayFrames.map((frame) => frame.event).join(",")}`,
      );

    const artifact = await request(
      "GET",
      `/api/generate/operations/${operationId}/artifact`,
      null,
      authHeaders(user),
    );
    if (
      artifact.status === 200 &&
      artifact.json?.data?.operation?.artifactHash === done?.artifactHash &&
      typeof artifact.json?.data?.artifact === "string"
    ) {
      ok("Generation artifact remains authoritative outside replay events");
    } else
      fail(
        "Generation artifact",
        `status=${artifact.status} body=${JSON.stringify(artifact.json)}`,
      );
  } catch (e) {
    fail("Prose generation", e.message);
  }
}

async function testGenerationControls(user) {
  console.log("\n[Generation Controls]");
  const operationIds = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const created = await request(
        "POST",
        "/api/generate/operations",
        {
          kind: "prose",
          bookId: globalBookId,
          targetWords: 10_000,
          prompt: `Write a deliberately long disposable quota probe ${index}.`,
        },
        {
          ...authHeaders(user),
          "Idempotency-Key": `smoke:quota:${TAG}:${index}`,
        },
      );
      if (created.status === 202 && created.json?.data?.operationId) {
        operationIds.push(created.json.data.operationId);
      } else {
        fail(
          "Generation quota setup",
          `status=${created.status} body=${JSON.stringify(created.json)}`,
        );
        return;
      }
    }

    const rejected = await request(
      "POST",
      "/api/generate/operations",
      {
        kind: "prose",
        bookId: globalBookId,
        targetWords: 10_000,
        prompt: "This operation must be rejected before inference allocation.",
      },
      {
        ...authHeaders(user),
        "Idempotency-Key": `smoke:quota:${TAG}:rejected`,
      },
    );
    if (
      rejected.status === 429 &&
      rejected.json?.error?.code === "RATE_LIMITED"
    ) {
      ok("Per-user active-operation quota rejects work before allocation");
    } else {
      fail(
        "Generation active quota",
        `status=${rejected.status} body=${JSON.stringify(rejected.json)}`,
      );
    }

    for (const operationId of operationIds) {
      const cancelled = await request(
        "POST",
        `/api/generate/operations/${operationId}/cancel`,
        {},
        authHeaders(user),
      );
      if (
        cancelled.status === 202 &&
        cancelled.json?.data?.status === "cancelled"
      ) {
        ok(`Generation cancellation persisted (${operationId})`);
      } else {
        fail(
          "Generation cancellation",
          `status=${cancelled.status} body=${JSON.stringify(cancelled.json)}`,
        );
      }
    }

    const reconciled = await request(
      "GET",
      `/api/generate/operations/unresolved?idempotencyKey=${encodeURIComponent(`smoke:quota:${TAG}:0`)}`,
      null,
      authHeaders(user),
    );
    if (
      reconciled.status === 200 &&
      reconciled.json?.data?.operations?.[0]?.status === "cancelled"
    ) {
      ok("Exact-key reconciliation recovers a terminal cancellation receipt");
    } else {
      fail(
        "Generation reconciliation",
        `status=${reconciled.status} body=${JSON.stringify(reconciled.json)}`,
      );
    }

    const exactLookup = await request(
      "GET",
      `/api/generate/operations/lookup?idempotencyKey=${encodeURIComponent(`smoke:quota:${TAG}:0`)}`,
      null,
      authHeaders(user),
    );
    if (
      exactLookup.status === 200 &&
      exactLookup.json?.data?.operationId === operationIds[0] &&
      exactLookup.json?.data?.status === "cancelled"
    ) {
      ok("Exact-key lookup returns the recent terminal operation");
    } else {
      fail(
        "Generation exact-key lookup",
        `status=${exactLookup.status} body=${JSON.stringify(exactLookup.json)}`,
      );
    }
  } finally {
    await Promise.all(
      operationIds.map((operationId) =>
        request(
          "POST",
          `/api/generate/operations/${operationId}/cancel`,
          {},
          authHeaders(user),
        ).catch(() => undefined),
      ),
    );
  }
}

// ── Test: workflow v1 lifecycle ───────────────────────────────
async function testWorkflowLifecycle(user) {
  console.log("\n[Workflow v1 Lifecycle]");
  try {
    const body = {
      bookId: globalBookId,
      scope: { type: "book" },
      model: "qwen3.6-35b",
      rubricVersion: "smoke-v1",
    };
    const workflowHeaders = {
      ...authHeaders(user),
      "Idempotency-Key": `workflow:${TAG}`,
    };
    const created = await request(
      "POST",
      "/api/workflows/quality-review",
      body,
      workflowHeaders,
    );
    const runId = created.json?.data?.runId;
    if (created.status === 202 && runId) ok(`Quality Review queued (${runId})`);
    else {
      fail(
        "Workflow start",
        `status=${created.status} body=${JSON.stringify(created.json)}`,
      );
      return;
    }

    const repeated = await request(
      "POST",
      "/api/workflows/quality-review",
      body,
      workflowHeaders,
    );
    if (repeated.status === 202 && repeated.json?.data?.runId === runId)
      ok("Repeated active start deduplicated");
    else fail("Workflow start dedupe", `status=${repeated.status}`);

    const status = await request(
      "GET",
      `/api/workflows/${runId}`,
      null,
      authHeaders(user),
    );
    if (status.status === 200 && status.json?.data?.sourceRevisionId)
      ok("Workflow status is revision-bound");
    else fail("Workflow status", `status=${status.status}`);
    const initialStatusVersion = status.json?.data?.statusVersion;
    if (
      status.json?.data?.terminal === false &&
      Number.isInteger(initialStatusVersion)
    )
      ok("Workflow status exposes terminal and monotonic version contract");
    else
      fail(
        "Workflow terminal contract",
        JSON.stringify({
          terminal: status.json?.data?.terminal,
          statusVersion: initialStatusVersion,
        }),
      );
    const versions = status.json?.data?.resourceVersions;
    if (
      versions &&
      typeof versions.checkpoints === "string" &&
      typeof versions.artifacts === "string" &&
      typeof versions.publication === "string"
    )
      ok("Workflow status exposes compact resource versions");
    else fail("Workflow resource versions", JSON.stringify(versions));
    const attempts = status.json?.data?.attempts;
    if (
      Number.isInteger(attempts?.executions) &&
      Number.isInteger(attempts?.currentDelivery) &&
      Number.isInteger(attempts?.recoveries) &&
      Number.isInteger(attempts?.maximumDeliveryAttempts)
    ) {
      ok(
        "Workflow status exposes lifetime execution/recovery and delivery counters",
      );
    } else fail("Workflow attempt counters", JSON.stringify(attempts));

    const findings = await request(
      "GET",
      `/api/books/${globalBookId}/findings?state=open&model=qwen3.6-35b&severity=high&scope=scene&limit=1`,
      null,
      authHeaders(user),
    );
    if (
      findings.status === 200 &&
      Array.isArray(findings.json?.data?.items) &&
      findings.json?.data?.limit === 1
    )
      ok("Book findings aggregate is bounded and filterable");
    else
      fail(
        "Book findings aggregate",
        `status=${findings.status} body=${JSON.stringify(findings.json)}`,
      );

    const history = await request(
      "GET",
      `/api/books/${globalBookId}/workflows`,
      null,
      authHeaders(user),
    );
    if (
      history.status === 200 &&
      history.json?.data?.some((run) => run.runId === runId)
    )
      ok("Workflow history survives client reconnect");
    else fail("Workflow history", `status=${history.status}`);

    const events = await request(
      "GET",
      `/api/workflows/${runId}/events`,
      null,
      authHeaders(user),
    );
    if (events.status === 200 && Array.isArray(events.json?.data))
      ok("Workflow audit events returned");
    else fail("Workflow events", `status=${events.status}`);

    const paused = await request(
      "POST",
      `/api/workflows/${runId}/pause`,
      {},
      authHeaders(user),
    );
    if (paused.status === 202) ok("Workflow pause accepted");
    else fail("Workflow pause", `status=${paused.status}`);
    if (
      paused.json?.data?.terminal === false &&
      paused.json?.data?.statusVersion > initialStatusVersion
    )
      ok("Workflow status version advances monotonically");
    else
      fail(
        "Workflow status version",
        JSON.stringify({
          before: initialStatusVersion,
          after: paused.json?.data?.statusVersion,
        }),
      );

    const resumed = await request(
      "POST",
      `/api/workflows/${runId}/resume`,
      {},
      authHeaders(user),
    );
    if (resumed.status === 202) ok("Workflow resume accepted");
    else fail("Workflow resume", `status=${resumed.status}`);

    const cancelled = await request(
      "POST",
      `/api/workflows/${runId}/cancel`,
      {},
      authHeaders(user),
    );
    const finalStatus = cancelled.json?.data?.status;
    if (
      cancelled.status === 202 &&
      ["cancelled", "completed"].includes(finalStatus)
    ) {
      ok(
        finalStatus === "cancelled"
          ? "Workflow cancellation persisted"
          : "Workflow reached a terminal state before cancellation",
      );
      if (cancelled.json?.data?.terminal === true)
        ok("Terminal workflow is explicitly marked terminal");
      else
        fail(
          "Terminal workflow contract",
          JSON.stringify(cancelled.json?.data?.terminal),
        );
    } else if (cancelled.status === 400) {
      const racedStatus = await request(
        "GET",
        `/api/workflows/${runId}`,
        null,
        authHeaders(user),
      );
      const terminalStatus = racedStatus.json?.data?.status;
      if (
        racedStatus.status === 200 &&
        ["completed", "cancelled"].includes(terminalStatus)
      )
        ok(`Workflow reached ${terminalStatus} before cancellation`);
      else
        fail(
          "Workflow cancel",
          `status=${cancelled.status} runStatus=${terminalStatus ?? "missing"}`,
        );
    } else
      fail(
        "Workflow cancel",
        `status=${cancelled.status} runStatus=${finalStatus ?? "missing"}`,
      );
  } catch (e) {
    fail("Workflow v1 lifecycle", e.message);
  }
}

// ── Test: autonomous editorial workflow ──────────────────────
async function testEditorialWorkflow(user) {
  console.log("\n[Autonomous Editorial Workflow]");
  try {
    const act = await request(
      "POST",
      `/api/books/${globalBookId}/acts`,
      { title: "Smoke Act", summary: "A bounded editorial smoke fixture." },
      authHeaders(user),
    );
    const actId = act.json?.data?.act?.id ?? act.json?.data?.id;
    if (![200, 201].includes(act.status) || !actId) {
      fail(
        "Editorial fixture act",
        `status=${act.status} body=${JSON.stringify(act.json)}`,
      );
      return;
    }
    const chapter = await request(
      "POST",
      `/api/books/${globalBookId}/acts/${actId}/chapters`,
      { title: "Smoke Chapter", summary: "The orchard choice." },
      authHeaders(user),
    );
    const chapterId = chapter.json?.data?.chapter?.id ?? chapter.json?.data?.id;
    if (![200, 201].includes(chapter.status) || !chapterId) {
      fail(
        "Editorial fixture chapter",
        `status=${chapter.status} body=${JSON.stringify(chapter.json)}`,
      );
      return;
    }
    const scene = await request(
      "POST",
      `/api/books/${globalBookId}/chapters/${chapterId}/scenes`,
      {
        title: "Smoke Scene",
        outline: "Mara decides whether to enter the orchard.",
        summary: "Mara keeps the glass pear and enters.",
        prose:
          "Mara held the glass pear. She looked at the old gate. She looked at it again, and then she entered the orchard.",
      },
      authHeaders(user),
    );
    const sceneId = scene.json?.data?.scene?.id ?? scene.json?.data?.id;
    if (![200, 201].includes(scene.status) || !sceneId) {
      fail(
        "Editorial fixture scene",
        `status=${scene.status} body=${JSON.stringify(scene.json)}`,
      );
      return;
    }

    const headers = {
      ...authHeaders(user),
      "Idempotency-Key": `editorial:${TAG}`,
    };
    const body = {
      bookId: globalBookId,
      scope: { type: "book" },
      passPack: "line_edit_safe",
      autonomy: "review_only",
      protectedElements: ["Mara", "glass pear"],
    };
    const launched = await request(
      "POST",
      "/api/workflows/editorial-optimize",
      body,
      headers,
    );
    const runId = launched.json?.data?.runId;
    if (launched.status !== 202 || !runId) {
      fail(
        "Editorial launch",
        `status=${launched.status} body=${JSON.stringify(launched.json)}`,
      );
      return;
    }
    ok(`Editorial workflow queued (${runId})`);
    const repeated = await request(
      "POST",
      "/api/workflows/editorial-optimize",
      body,
      headers,
    );
    if (repeated.status === 202 && repeated.json?.data?.runId === runId)
      ok("Editorial launch is idempotent");
    else
      fail(
        "Editorial launch idempotency",
        `status=${repeated.status} body=${JSON.stringify(repeated.json)}`,
      );

    let status;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      status = await request(
        "GET",
        `/api/workflows/${runId}`,
        null,
        authHeaders(user),
      );
      if (status.json?.data?.terminal) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (
      status?.status === 200 &&
      status.json?.data?.status === "completed" &&
      status.json?.data?.terminal === true
    ) {
      ok("Editorial workflow completed without pausing");
    } else {
      fail(
        "Editorial terminal result",
        JSON.stringify(status?.json?.data ?? status),
      );
      return;
    }
    const checkpoints = await request(
      "GET",
      `/api/workflows/${runId}/checkpoints`,
      null,
      authHeaders(user),
    );
    if (
      checkpoints.status === 200 &&
      Array.isArray(checkpoints.json?.data) &&
      checkpoints.json.data.length === 0
    )
      ok("Editorial workflow created no checkpoints");
    else
      fail(
        "Editorial checkpoint invariant",
        `status=${checkpoints.status} body=${JSON.stringify(checkpoints.json)}`,
      );
    const summary = await request(
      "GET",
      `/api/editorial/runs/${runId}/summary`,
      null,
      authHeaders(user),
    );
    if (
      summary.status === 200 &&
      summary.json?.data?.outcome === "completed_review_only" &&
      summary.json?.data?.sourceRevisionId &&
      summary.json?.data?.quality?.hardInvariantsPassed === true
    ) {
      ok("Editorial summary is compact and revision-bound");
    } else
      fail(
        "Editorial summary",
        `status=${summary.status} body=${JSON.stringify(summary.json)}`,
      );
  } catch (e) {
    fail("Autonomous editorial workflow", e.message);
  }
}

// ── Test: Rate Limiting ────────────────────────────────────────
async function testRateLimiting() {
  console.log("\n[Rate Limiting]");
  try {
    const result = await request(
      "POST",
      "/api/auth/diagnostics/rate-limit",
      {},
      { "X-Internal-Secret": internalSecret },
    );
    const data = result.json?.data;
    const now = Math.floor(Date.now() / 1000);
    if (
      result.status === 200 &&
      data?.limit === 3 &&
      data?.attempts === 4 &&
      data?.allowed === 3 &&
      data?.rejected === 1 &&
      data?.resetAt > now &&
      data?.resetAt <= now + 60 &&
      data?.ordinaryNamespaceUntouched === true
    ) {
      ok(
        "Rate limiter diagnostic enforced 3 allowed / 1 rejected with reset and namespace isolation",
      );
    } else {
      fail(
        "Rate limiting diagnostic",
        `status=${result.status} body=${JSON.stringify(result.json)}`,
      );
    }
  } catch (e) {
    fail("Rate limiting", e.message);
  }
}

// ── Setup & Teardown via API ───────────────────────────────────
let globalUser;
let otherUser;
let globalBookId;
let globalImageId;

let structuredAuthority = false;
async function seedTestData() {
  console.log("[Setup]");

  if (!internalSecret) throw new Error("INTERNAL_API_SECRET not provided");
  if (!factoryAuthSecret) throw new Error("FACTORY_AUTH_SECRET not provided");
  if (!metricsToken) throw new Error("METRICS_TOKEN not provided");

  // Create user via sync-user (internal endpoint)
  const syncRes = await request(
    "POST",
    "/api/auth/sync-user",
    { githubId: TAG, username: TAG },
    { "X-Internal-Secret": internalSecret },
  );
  if (syncRes.status !== 200 || !syncRes.json?.data?.id) {
    console.error(
      `  ✗ Failed to create test user: ${syncRes.status} ${JSON.stringify(syncRes.json)}`,
    );
    throw new Error("Failed to create smoke user");
  }
  globalUser = { id: syncRes.json.data.id, githubId: TAG, username: TAG };
  ok(`User created (id=${globalUser.id})`);

  const capabilities = await request(
    "GET",
    "/api/books/document-capabilities",
    null,
    authHeaders(globalUser),
  );
  if (
    capabilities.status !== 200 ||
    typeof capabilities.json?.data?.enabled !== "boolean"
  )
    throw new Error(
      "Document capability negotiation failed; preserve the fixture and do not fall back to legacy writers.",
    );
  if (capabilities.json.data.enabled) {
    structuredAuthority = true;
    return;
  }
  const otherTag = `${TAG}-other`;
  const otherRes = await request(
    "POST",
    "/api/auth/sync-user",
    { githubId: otherTag, username: otherTag },
    { "X-Internal-Secret": internalSecret },
  );
  if (otherRes.status !== 200 || !otherRes.json?.data?.id)
    throw new Error("Failed to create isolation user");
  otherUser = {
    id: otherRes.json.data.id,
    githubId: otherTag,
    username: otherTag,
  };

  // Create book via API
  const bookRes = await request(
    "POST",
    "/api/books",
    {
      title: "Smoke Test Book",
      genre: "fantasy",
      targetAudience: "adult",
      summary: "A smoke test book for e2e validation.",
    },
    authHeaders(globalUser),
  );
  if (bookRes.status === 200 || bookRes.status === 201) {
    globalBookId = bookRes.json?.data?.id;
    ok(`Book created (id=${globalBookId})`);
  } else {
    console.error(
      `  ✗ Failed to create test book: ${bookRes.status} ${JSON.stringify(bookRes.json)}`,
    );
    throw new Error("Failed to create smoke book");
  }

  const denied = await request(
    "GET",
    `/api/books/${globalBookId}`,
    null,
    authHeaders(otherUser),
  );
  if (denied.status === 404) ok("Cross-tenant book access denied");
  else fail("Cross-tenant book access", `status=${denied.status}`);
}

async function cleanupTestData() {
  console.log("\n[Cleanup]");
  try {
    if (globalImageId && globalUser) {
      const delImage = await request(
        "DELETE",
        `/api/images/${globalImageId}`,
        null,
        authHeaders(globalUser),
      );
      if (delImage.status === 200) ok("Test image deleted");
      else fail("Test image cleanup", `status=${delImage.status}`);
      globalImageId = undefined;
    }
    if (globalBookId) {
      // Reset book first (removes generated content and workflow history).
      await request(
        "POST",
        `/api/books/${globalBookId}/reset`,
        null,
        authHeaders(globalUser),
      );
      const del = await request(
        "DELETE",
        `/api/books/${globalBookId}`,
        null,
        authHeaders(globalUser),
      );
      if (del.status === 200) {
        ok("Test book deleted");
      } else {
        // Soft-delete — 200 means success, anything else is logged but not fatal
        console.log(
          `  ⚠ Book delete returned ${del.status} (may be soft-deleted)`,
        );
        ok("Test book cleanup attempted");
      }
    }
    if (globalUser || otherUser) {
      for (const user of [globalUser, otherUser].filter(Boolean)) {
        const cleanupUser = await request(
          "DELETE",
          `/api/auth/test-users/${encodeURIComponent(user.githubId)}`,
          null,
          { "X-Internal-Secret": internalSecret },
        );
        if (cleanupUser.status !== 200 || cleanupUser.json?.data?.deleted < 0) {
          fail(
            "Test user cleanup",
            `status=${cleanupUser.status} body=${JSON.stringify(cleanupUser.json)}`,
          );
        }
      }
      ok("Test users cleanup attempted");
    }
  } catch (e) {
    fail("Cleanup", e.message);
  }
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`\nSmoke testing: ${base}`);
  console.log(`Tag: ${TAG}\n`);

  if (process.env.SMOKE_DOCUMENT_CANARY_FILE) {
    const grant = JSON.parse(
      await fs.readFile(process.env.SMOKE_DOCUMENT_CANARY_FILE, "utf8"),
    );
    if (
      !/^release-fixture:release-canary-[a-f0-9-]{36}$/.test(
        grant.fixtureIdentity,
      ) ||
      !Number.isSafeInteger(grant.userId) ||
      !Number.isSafeInteger(grant.bookId) ||
      Date.parse(grant.expiresAt) <= Date.now()
    )
      throw new Error(
        "Use the exact unexpired disposable release canary file.",
      );
    globalUser = {
      id: grant.userId,
      githubId: grant.fixtureIdentity,
      username: grant.fixtureIdentity.split(":")[1],
    };
    globalBookId = grant.bookId;
    structuredAuthority = true;
  } else await seedTestData();
  if (structuredAuthority) {
    const foreignTag = `smoke-isolation-${randomUUID()}`,
      foreign = await request(
        "POST",
        "/api/auth/sync-user",
        { githubId: foreignTag, username: foreignTag },
        { "X-Internal-Secret": internalSecret },
      );
    if (foreign.status !== 200 || !foreign.json?.data?.id)
      throw new Error("Could not seed disposable foreign fixture identity.");
    await testHealth();
    await testReadinessRuntime();
    const evidence = await runDocumentAuthoritySmoke({
      request,
      headers: authHeaders(globalUser),
      userId: globalUser.id,
      bookId: globalBookId,
      foreignHeaders: authHeaders({
        id: foreign.json.data.id,
        githubId: foreignTag,
        username: foreignTag,
      }),
      retainBook:
        Boolean(process.env.SMOKE_DOCUMENT_CANARY_FILE) ||
        process.env.SMOKE_DOCUMENT_RETAIN_BOOK === "true",
      ok,
    });
    if (process.env.SMOKE_EVIDENCE_OUT) {
      const filename = path.resolve(process.env.SMOKE_EVIDENCE_OUT);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(filename, JSON.stringify(evidence, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
    console.log(
      JSON.stringify({
        kind: evidence.kind,
        bookId: evidence.bookId,
        operationIds: evidence.operationIds,
        artifactId: evidence.artifactId,
        passed,
        failed,
      }),
    );
    if (failed) process.exitCode = 1;
    return;
  }
  try {
    await testHealth();
    await testReadinessRuntime();
    await testMetricsSecurity();
    await testModels();
    await testImagesHealth();
    await testPrivateImageRoundTrip(globalUser);
    await testProseGeneration(globalUser);
    await testGenerationControls(globalUser);
    await testWorkflowLifecycle(globalUser);
    await testEditorialWorkflow(globalUser);
    await testRateLimiting();
  } finally {
    await cleanupTestData();
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  console.log(`${"═".repeat(50)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message || e);
  process.exit(1);
});
