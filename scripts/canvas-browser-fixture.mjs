import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const engine = createRequire(
  new URL(
    "../ProserAuthor/packages/canvas-engine/package.json",
    import.meta.url,
  ),
);

export async function reserveCanvasOutput(base) {
  const directory = resolve(base);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(directory, { mode: 0o700 });
    return directory;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const unique = resolve(directory, `run-${Date.now()}-${randomUUID()}`);
    await mkdir(unique, { mode: 0o700 });
    return unique;
  }
}

/** Serve production workers and explicit browser module entries, never /@fs imports. */
export async function startCanvasFixture({
  root,
  output,
  entry = "index.html",
  modules = [],
  alias = {},
}) {
  const { build, preview } = await import(engine.resolve("vite"));
  const outDir = resolve(output, "compiled-fixture");
  const input = { fixture: resolve(root, entry) };
  modules.forEach((path, index) => {
    input[`module-${index}`] = resolve(path);
  });
  const built = await build({
    configFile: false,
    root,
    logLevel: "warn",
    resolve: { alias },
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      rolldownOptions: { input, preserveEntrySignatures: "strict" },
    },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(
    (value) => value.output,
  );
  const assets = await Promise.all(
    outputs.map(async (value) => ({
      path: value.fileName,
      sha256: createHash("sha256")
        .update(await readFile(resolve(outDir, value.fileName)))
        .digest("hex"),
    })),
  );
  const moduleUrls = new Map(
    outputs
      .filter(
        (value) =>
          value.type === "chunk" && value.isEntry && value.facadeModuleId,
      )
      .map((value) => [resolve(value.facadeModuleId), `/${value.fileName}`]),
  );
  for (const module of modules)
    if (!moduleUrls.has(resolve(module)))
      throw new Error(`Missing compiled browser entry: ${module}`);
  const server = await preview({
    configFile: false,
    root,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0 },
  });
  return {
    resolvedUrls: server.resolvedUrls,
    assets,
    moduleUrl(path) {
      const url = moduleUrls.get(resolve(path));
      if (!url) throw new Error(`Unknown compiled browser entry: ${path}`);
      return url;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function installCanvasWorkerProbe(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.nativeWorkerDiagnostics = { urls: [], errors: [] };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        window.nativeWorkerDiagnostics.urls.push(String(url));
        this.addEventListener("error", (error) =>
          window.nativeWorkerDiagnostics.errors.push(error.message),
        );
      }
    };
  });
}

export async function verifyCanvasWorkers(page, minimum = 1) {
  const workers = await page.evaluate(() => window.nativeWorkerDiagnostics);
  if (
    !workers ||
    workers.urls.length < minimum ||
    workers.errors.length ||
    workers.urls.some((url) => !/^(blob:|data:)/.test(url))
  ) {
    throw new Error(
      `Expected real compiled inline workers without errors: ${JSON.stringify(workers)}`,
    );
  }
  return { count: workers.urls.length, errors: workers.errors };
}

/** A task and paint boundary, not a replacement for waiting on positive state. */
export async function settleCanvasFrame(page) {
  await page.waitForFunction(
    () => {
      window.canvasFrameBarrier ??= new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(() => resolve(true), 0)),
        ),
      );
      return window.canvasFrameBarrier;
    },
    undefined,
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    delete window.canvasFrameBarrier;
  });
}

/** Poll an asynchronous observation without repeating the action that produced it. */
export async function waitForBrowserState(
  read,
  accept,
  label,
  timeout = 30000,
) {
  let expired = false;
  let timer;
  const error = () => new Error(`Timed out waiting for ${label}`);
  try {
    return await Promise.race([
      (async () => {
        while (!expired) {
          const value = await read();
          if (expired) break;
          if (accept(value)) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw error();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(error());
        }, timeout);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

export async function closeCanvasFixture(browser, server, report) {
  let first;
  for (const close of [() => browser?.close(), () => server?.close()]) {
    try {
      await close();
    } catch (error) {
      first ??= error;
      report.passed = false;
      (report.cleanupFailures ??= []).push(error.message);
    }
  }
  return first;
}
