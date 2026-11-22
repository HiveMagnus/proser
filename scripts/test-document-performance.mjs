import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import path from "node:path";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium, devices } = require("playwright");
const base = new URL(
  process.env.PROSER_PERFORMANCE_BASE_URL ?? "http://localhost:3320",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw new Error(
    "Performance fixtures require an isolated loopback Author server.",
  );
const username = process.env.PLAYWRIGHT_IAM_USERNAME;
const password = process.env.PLAYWRIGHT_IAM_PASSWORD;
if (!username || !password)
  throw new Error("Explicit disposable browser credentials are required.");
const output = path.resolve(
  process.env.PROSER_PERFORMANCE_OUTPUT ?? "output/document-performance",
);
await mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  hostMemoryBytes: totalmem(),
  browser: null,
  profiles: [],
  failures: [],
  microsoftWord: "unverified",
};
const browser = await chromium.launch({ headless: true });
report.browser = browser.version();
const p95 = (values) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * 0.95) - 1)
  ];
try {
  for (const profile of [
    {
      name: "desktop",
      viewport: { width: 1440, height: 1000 },
      cpuThrottle: 1,
      typingBudget: 50,
    },
    {
      name: "mobile-chromium-emulation",
      ...devices["iPhone 13"],
      defaultBrowserType: undefined,
      cpuThrottle: 4,
      typingBudget: 100,
    },
  ]) {
    const { name, cpuThrottle, typingBudget, ...device } = profile;
    const context = await browser.newContext({
      ...device,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
    await cdp.send("Performance.enable");
    const profileReport = {
      name,
      cpuThrottle,
      viewport: device.viewport,
      runs: [],
    };
    report.profiles.push(profileReport);
    await page.goto(new URL("/auth/signin", base).href);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {
      timeout: 30000,
    });
    const session = await (
      await page.request.get(new URL("/api/auth/session", base).href)
    ).json();
    const call = async (
      route,
      data,
      method = data === undefined ? "GET" : "POST",
    ) => {
      const response = await page.request.fetch(new URL(route, base).href, {
        method,
        data,
        timeout: 180000,
        headers: {
          "x-proser-expected-user": encodeURIComponent(session.user.id),
        },
      });
      const body = await response.json();
      if (!response.ok() || !body.success)
        throw new Error(
          `${method} ${route}: ${body.error?.code ?? response.status()}`,
        );
      return body.data;
    };
    for (const wordTarget of [50000, 150000, 300000]) {
      try {
        const book = await call("/api/books", {
          title: `Disposable performance ${name} ${wordTarget} ${randomUUID()}`,
          operationId: randomUUID(),
        });
        const bookId = book.id;
        const preconditions = async () => {
          const head = await call(`/api/books/${bookId}/document-manifest`);
          return {
            operationId: randomUUID(),
            expectedRevisionId: head.revisionId,
            expectedScopes: { structure: head.scopes.structure.revisionId },
          };
        };
        const { act } = await call(`/api/books/${bookId}/acts`, {
          title: "Performance fixture",
          documentPreconditions: await preconditions(),
        });
        const { chapter } = await call(
          `/api/books/${bookId}/acts/${act.id}/chapters`,
          {
            title: "Bounded editing corpus",
            documentPreconditions: await preconditions(),
          },
        );
        for (let start = 0; start < wordTarget / 2000; start += 10) {
          const scenes = Array.from(
            { length: Math.min(10, wordTarget / 2000 - start) },
            (_, scene) => ({
              prose: Array.from({ length: 20 }, (_, paragraph) =>
                Array.from(
                  { length: 100 },
                  (_, word) => `w${start + scene}_${paragraph}_${word}`,
                ).join(" "),
              ).join("\n\n"),
              summary: `Fixture scene ${start + scene + 1}`,
            }),
          );
          await call(
            `/api/books/${bookId}/chapters/${chapter.id}/scenes/batch`,
            {
              scenes,
              documentPreconditions: await preconditions(),
            },
          );
        }
        const manifest = await call(`/api/books/${bookId}/document-manifest`);
        if (manifest.totals.wordCount !== wordTarget)
          throw new Error("Fixture word target mismatch.");
        const sceneId = manifest.scenes[0].sceneId;
        const source = await call(
          `/api/books/${bookId}/scenes/${sceneId}/document`,
        );
        source.document.blocks[0].runs[0].style = {
          bold: true,
          font: "Liberation Serif",
          size: 18,
        };
        await call(`/api/books/${bookId}/document-commits`, {
          schemaVersion: 1,
          operationId: randomUUID(),
          expectedRevisionId: source.bookRevisionId,
          scenes: [
            {
              sceneId,
              expectedRevisionId: source.revisionId,
              document: source.document,
            },
          ],
        });
        const requestScenes = new Set();
        const collect = (response) => {
          const match = new URL(response.url()).pathname.match(
            /\/scenes\/(\d+)\/document$/,
          );
          if (match) requestScenes.add(match[1]);
        };
        page.on("response", collect);
        const route = name === "desktop" ? "/manuscript" : "/m/studio";
        const started = performance.now();
        await page.goto(
          new URL(`${route}?bookId=${bookId}&sceneId=${sceneId}`, base).href,
        );
        const editor = page
          .getByRole("region", { name: "Manuscript document", exact: true })
          .first();
        await editor.waitFor({ timeout: 30000 });
        await editor
          .locator("canvas")
          .first()
          .waitFor({ state: "visible", timeout: 30000 });
        const usableMs = performance.now() - started;
        await page
          .getByRole("combobox", {
            name: "Manuscript editing scope",
            exact: true,
          })
          .selectOption("book");
        await page.locator("[data-document-window]").waitFor();
        await page.waitForFunction(
          () =>
            document.querySelectorAll("[data-document-window] [data-scene-id]")
              .length === 3,
        );
        await editor.locator("canvas").first().waitFor({ state: "visible" });
        const wholeBookUsableMs = performance.now() - started;
        const run = {
          words: wordTarget,
          bookId,
          sceneId,
          usableMs,
          wholeBookUsableMs,
          windowFetchedScenes: requestScenes.size,
          coldFetchedScenes: requestScenes.size,
          samples: {},
          warmNavigationMs: null,
          savedSourceHash: null,
          memory: null,
        };
        profileReport.runs.push(run);
        if (usableMs > 3000)
          report.failures.push(
            `${name}/${wordTarget}: editing ready ${Math.round(usableMs)}ms >3000ms`,
          );
        if (wholeBookUsableMs > 3000)
          report.failures.push(
            `${name}/${wordTarget}: whole-book window ${Math.round(wholeBookUsableMs)}ms >3000ms`,
          );
        if (requestScenes.size > 3)
          report.failures.push(
            `${name}/${wordTarget}: fetched ${requestScenes.size} scenes before editing`,
          );
        // Measure browser input-to-next-frame latency, excluding protocol round trips.
        await page.evaluate(() => {
          window.__proserInputFrames = [];
          document.addEventListener(
            "beforeinput",
            () => {
              const start = performance.now();
              requestAnimationFrame(() =>
                window.__proserInputFrames.push(performance.now() - start),
              );
            },
            true,
          );
        });
        const insertedMarkers = [];
        for (const mode of ["canvas", "semantic"]) {
          if (mode === "semantic") {
            await editor
              .getByRole("button", { name: "Accessible editor", exact: true })
              .click();
            const field = editor.getByRole("textbox", {
              name: "Paragraph 1",
              exact: true,
            });
            await field.focus();
            await field.press("End");
          } else {
            const canvas = editor.locator("canvas").first();
            await canvas.click({ position: { x: 110, y: 115 } });
          }
          const marker = ` Perf${randomUUID().replaceAll("-", "").slice(0, 12)}`;
          const inserted = marker.repeat(3);
          insertedMarkers.push(inserted);
          await page.evaluate(() => {
            window.__proserInputFrames = [];
          });
          for (const character of inserted) {
            await page.keyboard.insertText(character);
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(resolve)),
            );
          }
          const values = await page.evaluate(() => window.__proserInputFrames);
          if (values.length < 20)
            throw new Error(`Insufficient ${mode} input samples.`);
          run.samples[mode] = {
            count: values.length,
            p95Ms: p95(values),
            maximumMs: Math.max(...values),
          };
          if (p95(values) > typingBudget)
            report.failures.push(
              `${name}/${wordTarget}/${mode}: p95 ${p95(values).toFixed(1)}ms >${typingBudget}ms`,
            );
          const saveStarted = performance.now();
          await page
            .getByRole("button", { name: "Save window changes", exact: true })
            .click();
          let saved;
          const deadline = Date.now() + 20000;
          do {
            saved = await call(
              `/api/books/${bookId}/scenes/${sceneId}/document`,
            );
            if (saved.projection.text.includes(inserted)) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (Date.now() < deadline);
          if (!saved.projection.text.includes(inserted))
            throw new Error(`${mode} input was not durably saved.`);
          let restoredText = saved.projection.text;
          // Mode switching preserves the caret; newer input may be nested in
          // an earlier marker. Undo insertion evidence in reverse order.
          for (const value of [...insertedMarkers].reverse())
            restoredText = restoredText.replace(value, "");
          if (restoredText !== source.projection.text)
            throw new Error(
              `${mode} changed source text outside the complete typed input.`,
            );
          if (
            JSON.stringify(saved.document.layout) !==
              JSON.stringify(source.document.layout) ||
            JSON.stringify(saved.document.changes) !==
              JSON.stringify(source.document.changes) ||
            JSON.stringify(saved.document.comments) !==
              JSON.stringify(source.document.comments)
          )
            throw new Error(
              `${mode} changed layout or review state while typing.`,
            );
          run.samples[mode].saveLatencyMs = performance.now() - saveStarted;
          if (
            JSON.stringify(saved.document.blocks.slice(1)) !==
            JSON.stringify(source.document.blocks.slice(1))
          )
            throw new Error(`${mode} changed unaffected canonical blocks.`);
          run.savedSourceHash = saved.contentHash;
          await page.waitForFunction(
            (id) =>
              Array.from(
                document.querySelectorAll(
                  `[data-scene-id="${id}"] [role="status"]`,
                ),
              ).some((node) => node.textContent.trim().startsWith("Saved")),
            String(sceneId),
            { timeout: 20000 },
          );
        }
        const warmStarted = performance.now();
        await page
          .getByRole("button", { name: "Next scene", exact: true })
          .click();
        await page.waitForURL(
          (url) =>
            url.searchParams.get("sceneId") ===
            String(manifest.scenes[1].sceneId),
        );
        await page
          .locator(`[data-scene-id="${manifest.scenes[1].sceneId}"]`)
          .getByRole("region", { name: "Manuscript document", exact: true })
          .locator("canvas")
          .first()
          .waitFor({ state: "visible" });
        run.warmNavigationMs = performance.now() - warmStarted;
        if (run.warmNavigationMs > 1000)
          report.failures.push(
            `${name}/${wordTarget}: warm navigation ${Math.round(run.warmNavigationMs)}ms >1000ms`,
          );
        const metrics = await cdp.send("Performance.getMetrics");
        run.memory = Object.fromEntries(
          metrics.metrics
            .filter((metric) =>
              [
                "JSHeapUsedSize",
                "JSHeapTotalSize",
                "LayoutCount",
                "LayoutDuration",
                "TaskDuration",
              ].includes(metric.name),
            )
            .map((metric) => [metric.name, metric.value]),
        );
        if (name === "desktop") {
          run.publications = [];
          const publicationSource = await call(
            `/api/books/${bookId}/document-manifest`,
          );
          for (const format of ["docx", "pdf"]) {
            const started = performance.now();
            let job = await call(
              `/api/books/${bookId}/document-publication-jobs`,
              {
                operationId: randomUUID(),
                expectedRevisionId: publicationSource.revisionId,
                options: {
                  format,
                  mode: "final",
                  preset: "submission-manuscript",
                },
              },
            );
            const deadline = Date.now() + 180000;
            while (
              ["pending", "running"].includes(job.status) &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              job = await call(
                `/api/books/${bookId}/document-publication-jobs/${job.id}`,
              );
            }
            if (
              job.status !== "completed" ||
              !job.downloadPath ||
              job.sourceRevisionId !== publicationSource.revisionId
            )
              throw new Error(
                `${format} publication ${job.id} did not complete against the exact performance source: ${job.status}/${job.errorCode}`,
              );
            const response = await page.request.get(
              new URL(job.downloadPath, base).href,
              {
                headers: {
                  "x-proser-expected-user": encodeURIComponent(session.user.id),
                },
                timeout: 180000,
              },
            );
            const bytes = await response.body();
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            if (
              !response.ok() ||
              response.headers()["x-content-sha256"] !== sha256
            )
              throw new Error(
                `${format} publication ${job.id} download checksum failed.`,
              );
            run.publications.push({
              format,
              jobId: job.id,
              artifactId: job.artifactId,
              sourceRevisionId: job.sourceRevisionId,
              sourceHash: job.sourceHash,
              durationMs: performance.now() - started,
              byteLength: bytes.length,
              sha256,
            });
          }
        }
        await page.screenshot({
          path: path.join(output, `${name}-${wordTarget}.png`),
          fullPage: false,
        });
        page.off("response", collect);
        // Keep disposable revisions/artifacts available for inspection; a separate
        // explicit cleanup can tombstone these exact recorded fixture IDs.
        await writeFile(
          path.join(output, "performance.json"),
          JSON.stringify(report, null, 2),
        );
      } catch (error) {
        report.failures.push(
          `${name}/${wordTarget}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await page
          .screenshot({
            path: path.join(output, `${name}-${wordTarget}-failure.png`),
            fullPage: false,
          })
          .catch(() => undefined);
        await writeFile(
          path.join(output, "performance.json"),
          JSON.stringify(report, null, 2),
        );
      }
    }
    await context.close();
  }
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  await writeFile(
    path.join(output, "performance.json"),
    JSON.stringify(report, null, 2),
  );
}
process.stdout.write(
  JSON.stringify({
    report: path.join(output, "performance.json"),
    failures: report.failures,
    completedProfiles: report.profiles.map((profile) => ({
      name: profile.name,
      runs: profile.runs.length,
    })),
  }) + "\n",
);
if (
  report.failures.length ||
  report.profiles.length !== 2 ||
  report.profiles.some((profile) => profile.runs.length !== 3)
)
  process.exitCode = 1;
