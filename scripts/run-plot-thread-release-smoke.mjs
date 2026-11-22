import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
const campaignMode = process.env.PROSER_CAMPAIGN_SMOKE === "true";
const root = fileURLToPath(new URL("../", import.meta.url));
const database = new URL(
  process.env.DATABASE_URL ?? "postgresql://invalid/invalid",
);
const redis = new URL(process.env.REDIS_URL ?? "redis://invalid");
if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  database.hostname !== "127.0.0.1" ||
  database.port !== "55441" ||
  !/^\/proser_canvas_(?:plot|campaign)_[a-zA-Z0-9_]+$/.test(
    database.pathname,
  ) ||
  redis.hostname !== "127.0.0.1" ||
  redis.port !== "56441"
)
  throw new Error(
    "Release workspace smoke requires explicit fresh synthetic proser_canvas_plot_* PostgreSQL55441 and Redis56441.",
  );
const factoryDir = path.join(root, "ProserFactory");
const authorDir = path.join(root, "ProserAuthor/apps/web");
const output = path.resolve(
  process.env.PROSER_RELEASE_SMOKE_OUTPUT ??
    path.join(root, "output/playwright/plot-thread-release"),
);
await mkdir(output, { recursive: true, mode: 0o700 });
const secret = randomUUID() + randomUUID();
const username = "release-browser-fixture";
const password = randomUUID();
const environment = {
  ...process.env,
  NODE_ENV: "production",
  ...(process.env.PROSER_PLOT_SMOKE_DEV === "true"
    ? {
        PROSER_NEXT_DIST_DIR:
          "node_modules/.cache/proser-plot-thread-release-next",
      }
    : {}),
  TLS_ENABLED: "false",
  USE_BULLMQ: campaignMode ? "true" : "false",
  DOCUMENT_AUTHORITY_ENABLED: "true",
  FACTORY_AUTH_SECRET: secret,
  FACTORY_AUTH_ISSUER: "proser-author",
  FACTORY_AUTH_AUDIENCE: "proser-factory",
  INFERENCE_HOST: "http://127.0.0.1:3481",
  OLLAMA_BASE_URL: "http://127.0.0.1:3481",
  VLLM_BASE_URL: "http://127.0.0.1:3481",
  OLLAMA_SETTINGS_FILE: path.join(
    output,
    "isolated-absent-inference-settings.env",
  ),
  LOCAL_AUTH_ENABLED: "true",
  LOCAL_AUTH_USERNAME: username,
  LOCAL_AUTH_PASSWORD: password,
  NEXTAUTH_SECRET: secret,
  AUTH_SECRET: secret,
  NEXTAUTH_URL: "http://localhost:3476",
  AUTH_URL: "http://localhost:3476",
  FACTORY_URL: "http://127.0.0.1:3466",
  PLAYWRIGHT_IAM_USERNAME: username,
  PLAYWRIGHT_IAM_PASSWORD: password,
  PROSER_RELEASE_SMOKE_BASE_URL: "http://localhost:3476",
  PROSER_RELEASE_SMOKE_OUTPUT: output,
  IAM_CORE_URL: "",
};
const secondNonce = randomUUID();
const fixtureEnvironment = path.join(
  output,
  `author-fixture-${secondNonce}.env`,
);
environment.PROSER_PLOT_SECOND_SESSION_FILE = path.join(
  output,
  `second-session-${secondNonce}.json`,
);
await writeFile(
  fixtureEnvironment,
  `AUTH_SECRET=${secret}\nNEXTAUTH_URL=http://localhost:3476\n`,
  { mode: 0o600 },
);
const signer = spawn(
  process.execPath,
  [
    path.join(root, "ProserAuthor/scripts/create-release-canary-session.mjs"),
    "--env-file",
    fixtureEnvironment,
    "--out",
    environment.PROSER_PLOT_SECOND_SESSION_FILE,
    "--username",
    `release-canary-${randomUUID()}`,
  ],
  { env: environment, stdio: "ignore" },
);
if ((await new Promise((resolve) => signer.once("exit", resolve))) !== 0)
  throw new Error("Isolated second-author signer failed.");
const children = [];
const logs = [];
async function start(name, code, cwd) {
  const log = await open(path.join(output, `${name}.log`), "w", 0o600);
  logs.push(log);
  const scriptFile = path.join(output, `${name}-server.cjs`);
  await writeFile(
    scriptFile,
    "require = require('node:module').createRequire(process.cwd()+'/package.json');\n" +
      code,
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [scriptFile], {
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
  for (const port of [3466, 3476]) {
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
    campaignMode
      ? `const {SceneProseService}=require('./dist/services/sceneProseService');require(${JSON.stringify(path.join(root, "scripts/campaign-seeded-provider.cjs"))}).install(SceneProseService);const {createApp,shutdown}=require('./dist/server');const {databaseService}=require('./dist/lib/database');(async()=>{await databaseService.connect();const worker=require('./dist/workers/workflowWorker').startWorkflowWorker();const server=require('node:http').createServer(createApp()).listen(3466,'127.0.0.1');process.on('SIGINT',()=>server.close(async()=>{await worker.close();await shutdown();process.exit(0)}));})().catch(()=>process.exit(1));`
      : `const {SceneProseService}=require('./dist/services/sceneProseService');SceneProseService.prototype.reviewPlotThread=async(snapshot)=>({raw:JSON.stringify({assessment:'weak',summary:'The wax clue prepares the betrayal, but the confession can make the causal link clearer.',findings:[{aspect:'payoff',explanation:'The confession answers the question, though the red wax connection is implicit.',citations:[{evidenceId:snapshot.evidence.at(-1).id,quote:snapshot.evidence.at(-1).source.targets[0].sourceText}],suggestion:'Connect the red wax clue to the confession.'}]}),provenance:{providerId:'isolated-seeded-fixture',params:{},recipe:'plot-thread-review',recipeVersion:'1.0.0'}});SceneProseService.prototype.proposeDocumentEdits=async(snapshot)=>({raw:JSON.stringify({reply:'Tie the confession to the red wax clue.',edits:[{targetId:snapshot.targets[0].targetId,sourceText:snapshot.targets[0].sourceText,replacement:snapshot.targets[0].sourceText.replace('confessed','looked at the red wax and confessed')}]}),provenance:{providerId:'isolated-seeded-fixture',params:{},recipe:'document-proposal',recipeVersion:'1.0.0'}});const {createApp,shutdown}=require('./dist/server');const {databaseService}=require('./dist/lib/database');(async()=>{await databaseService.connect();const server=require('node:http').createServer(createApp()).listen(3466,'127.0.0.1');process.on('SIGINT',()=>server.close(async()=>{await shutdown();process.exit(0)}));})().catch(()=>process.exit(1));`,
    factoryDir,
  );
  await ready("http://127.0.0.1:3466/health", factory);
  const author = await start(
    "author",
    `const next=require('next');const {attachTrustedAuthSource}=require('./trusted-auth-source');(async()=>{const dev=process.env.PROSER_PLOT_SMOKE_DEV==='true';if(dev)process.env.NODE_ENV='development';const app=next({dev,dir:process.cwd(),hostname:'127.0.0.1',port:3476});await app.prepare();const handle=app.getRequestHandler();const server=require('node:http').createServer((req,res)=>{if(!attachTrustedAuthSource(req)){res.writeHead(400);res.end();return;}handle(req,res);}).listen(3476,'127.0.0.1');process.on('SIGINT',()=>server.close(async()=>{await app.close();process.exit(0)}));})().catch(()=>process.exit(1));`,
    authorDir,
  );
  await ready("http://localhost:3476/auth/signin", author);
  const check = spawn(
    process.execPath,
    [
      path.join(
        root,
        campaignMode
          ? "scripts/test-revision-campaign-release.mjs"
          : "scripts/test-plot-thread-release.mjs",
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
  await unlink(fixtureEnvironment).catch(() => undefined);
  await unlink(environment.PROSER_PLOT_SECOND_SESSION_FILE).catch(
    () => undefined,
  );
}
