import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  releaseBrowserName,
  releaseAcceptanceScope,
} from "./document-release-browser.mjs";
releaseBrowserName();
const acceptanceScope = releaseAcceptanceScope();
const root = fileURLToPath(new URL("../", import.meta.url));
const database = new URL(
  process.env.DATABASE_URL ?? "postgresql://invalid/invalid",
);
const redis = new URL(process.env.REDIS_URL ?? "redis://invalid");
if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  database.hostname !== "127.0.0.1" ||
  database.port !== "55441" ||
  !/^\/proser_canvas_release_[a-zA-Z0-9_]+$/.test(database.pathname) ||
  redis.hostname !== "127.0.0.1" ||
  redis.port !== "56441"
)
  throw new Error(
    "Release workspace smoke requires explicit fresh synthetic proser_canvas_release_* PostgreSQL55441 and Redis56441.",
  );
const factoryDir = path.join(root, "ProserFactory");
const authorDir = path.join(root, "ProserAuthor/apps/web");
const output = path.resolve(
  process.env.PROSER_RELEASE_SMOKE_OUTPUT ??
    path.join(root, "output/playwright/release-workspace"),
);
await mkdir(output, { recursive: true, mode: 0o700 });
const secret = randomUUID() + randomUUID();
const username = "release-browser-fixture";
const password = randomUUID();
const environment = {
  ...process.env,
  NODE_ENV: "production",
  TLS_ENABLED: "false",
  USE_BULLMQ: "false",
  DOCUMENT_AUTHORITY_ENABLED: "true",
  FACTORY_AUTH_SECRET: secret,
  FACTORY_AUTH_ISSUER: "proser-author",
  FACTORY_AUTH_AUDIENCE: "proser-factory",
  INFERENCE_HOST: "http://127.0.0.1:3351",
  OLLAMA_BASE_URL: "http://127.0.0.1:3351",
  VLLM_BASE_URL: "http://127.0.0.1:3351",
  OLLAMA_SETTINGS_FILE: path.join(
    output,
    "isolated-absent-inference-settings.env",
  ),
  LOCAL_AUTH_ENABLED: "true",
  LOCAL_AUTH_USERNAME: username,
  LOCAL_AUTH_PASSWORD: password,
  NEXTAUTH_SECRET: secret,
  AUTH_SECRET: secret,
  NEXTAUTH_URL: "http://localhost:3320",
  AUTH_URL: "http://localhost:3320",
  FACTORY_URL: "http://127.0.0.1:3310",
  PLAYWRIGHT_IAM_USERNAME: username,
  PLAYWRIGHT_IAM_PASSWORD: password,
  PROSER_RELEASE_SMOKE_BASE_URL: "http://localhost:3320",
  PROSER_RELEASE_SMOKE_OUTPUT: output,
  IAM_CORE_URL: "",
};
const children = [];
const logs = [];
async function start(name, code, cwd) {
  const log = await open(path.join(output, `${name}.log`), "w", 0o600);
  logs.push(log);
  const child = spawn(process.execPath, ["-e", code], {
    cwd,
    env: environment,
    stdio: ["ignore", log.fd, log.fd],
  });
  children.push(child);
  child.on("error", () => undefined);
  return child;
}
async function ready(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Fixture server exited (${child.exitCode}); inspect private logs.`,
      );
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Fixture startup timed out: ${new URL(url).pathname}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
try {
  for (const port of [3310, 3320]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(500),
      });
      if (response)
        throw new Error(
          `Port ${port} already has a server; choose isolated ports by changing the explicit runner.`,
        );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Port"))
        throw error;
    }
  }
  const factory = await start(
    "factory",
    `const {createApp,shutdown}=require('./dist/server');const {databaseService}=require('./dist/lib/database');(async()=>{await databaseService.connect();const server=require('node:http').createServer(createApp()).listen(3310,'127.0.0.1');process.on('SIGINT',()=>server.close(async()=>{await shutdown();process.exit(0)}));})().catch(()=>process.exit(1));`,
    factoryDir,
  );
  await ready("http://127.0.0.1:3310/health", factory);
  const author = await start(
    "author",
    `const next=require('next');const {attachTrustedAuthSource}=require('./trusted-auth-source');(async()=>{const app=next({dev:false,dir:process.cwd(),hostname:'127.0.0.1',port:3320});await app.prepare();const handle=app.getRequestHandler();const server=require('node:http').createServer((req,res)=>{if(!attachTrustedAuthSource(req)){res.writeHead(400);res.end();return;}handle(req,res);}).listen(3320,'127.0.0.1');process.on('SIGINT',()=>server.close(async()=>{await app.close();process.exit(0)}));})().catch(()=>process.exit(1));`,
    authorDir,
  );
  await ready("http://localhost:3320/auth/signin", author);
  const check = spawn(
    process.execPath,
    [
      path.join(
        root,
        acceptanceScope !== "complete"
          ? "scripts/test-r2-workspace-fixture.mjs"
          : "scripts/test-document-release-workspace.mjs",
      ),
    ],
    { cwd: root, env: environment, stdio: "inherit" },
  );
  children.push(check);
  const exit = await new Promise((resolve, reject) => {
    check.once("exit", resolve);
    check.once("error", reject);
  });
  if (exit !== 0) process.exitCode = exit ?? 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  for (const log of logs) await log.close();
}
