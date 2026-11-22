import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  reserveCanvasOutput,
  startCanvasFixture,
  installCanvasWorkerProbe,
  verifyCanvasWorkers,
  closeCanvasFixture,
  waitForBrowserState,
} from "./canvas-browser-fixture.mjs";
import {
  writeOrcaFixture,
  installOrcaFixtureAssets,
} from "./orca-browser-fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const output = await reserveCanvasOutput(
  resolve(repository, "output/playwright/canvas-helper-tests"),
);

test("overlapping runs preserve separate output and receipts", async () => {
  const [a, b] = await Promise.all([
    reserveCanvasOutput(resolve(output, "overlap")),
    reserveCanvasOutput(resolve(output, "overlap")),
  ]);
  assert.notEqual(a, b);
  await Promise.all([
    writeFile(resolve(a, "receipt.json"), "first", { flag: "wx" }),
    writeFile(resolve(b, "receipt.json"), "second", { flag: "wx" }),
  ]);
  assert.equal(await readFile(resolve(a, "receipt.json"), "utf8"), "first");
  assert.equal(await readFile(resolve(b, "receipt.json"), "utf8"), "second");
});

test("production browser entries retain public exports without source routes", async () => {
  const root = resolve(output, "module-source");
  await mkdir(root);
  await writeFile(
    resolve(root, "index.html"),
    '<title>Compiled entry</title><script type="module" src="/main.mjs"></script>',
  );
  await writeFile(resolve(root, "main.mjs"), "window.ready=true;");
  const module = resolve(root, "entry.mjs");
  await writeFile(module, 'export const receipt="exact-compiled-module";');
  const server = await startCanvasFixture({
    root,
    output: resolve(output, "modules"),
    modules: [module],
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    const url = server.moduleUrl(module);
    assert.match(url, /^\/assets\//);
    assert.equal(
      await page.evaluate(async (url) => (await import(url)).receipt, url),
      "exact-compiled-module",
    );
    assert.throws(
      () => server.moduleUrl(resolve(root, "forged.mjs")),
      /Unknown compiled/,
    );
    assert.ok(
      server.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

test("Orca component fixture compiles and loads real workers without claiming speech acceptance", async () => {
  const directory = await reserveCanvasOutput(resolve(output, "orca-loader"));
  const root = await writeOrcaFixture(directory, repository + "/");
  const server = await startCanvasFixture({
    root,
    output: directory,
    alias: {
      "@cheftaco/proser-contracts": resolve(
        repository,
        "ProserAuthor/packages/contracts/src/index.ts",
      ),
      react: resolve(repository, "ProserAuthor/apps/web/node_modules/react"),
      "react-dom": resolve(
        repository,
        "ProserAuthor/apps/web/node_modules/react-dom",
      ),
    },
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installCanvasWorkerProbe(page);
    await installOrcaFixtureAssets(page);
    await page.goto(server.resolvedUrls.local[0]);
    await page
      .getByRole("button", { name: "Open native editor", exact: true })
      .click();
    const input = page.getByRole("textbox", {
      name: "Canvas writing input",
      exact: true,
    });
    await input.focus();
    await page.keyboard.insertText("LoaderSmoke");
    await page.waitForFunction(() =>
      window.nativeFixture.text.includes("LoaderSmoke"),
    );
    assert.ok((await verifyCanvasWorkers(page)).count >= 4);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("cleanup attempts both resources and cannot retain a success receipt", async () => {
  const calls = [];
  const report = { passed: true };
  const first = new Error("browser teardown failed");
  const failure = await closeCanvasFixture(
    {
      close: async () => {
        calls.push("browser");
        throw first;
      },
    },
    {
      close: async () => {
        calls.push("server");
        throw new Error("server teardown failed");
      },
    },
    report,
  );
  assert.equal(failure, first);
  assert.deepEqual(calls, ["browser", "server"]);
  assert.equal(report.passed, false);
  assert.deepEqual(report.cleanupFailures, [
    "browser teardown failed",
    "server teardown failed",
  ]);
});

test("blocked reads honor the Node budget and cannot resume polling after expiry", async () => {
  let reads = 0,
    finish;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  await assert.rejects(
    waitForBrowserState(
      () => {
        reads++;
        return blocked;
      },
      () => false,
      "blocked journal",
      30,
    ),
    /Timed out waiting for blocked journal/,
  );
  finish("late result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
});

test("state polling waits for the observed result and surfaces terminal read errors", async () => {
  let reads = 0;
  assert.equal(
    await waitForBrowserState(
      async () => (++reads === 3 ? "prepared" : "pending"),
      (value) => value === "prepared",
      "prepared intent",
      1000,
    ),
    "prepared",
  );
  const error = new Error("original operation unavailable");
  await assert.rejects(
    waitForBrowserState(
      async () => {
        throw error;
      },
      () => true,
      "receipt",
    ),
    (failure) => failure === error,
  );
});
