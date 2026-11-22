import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  reserveCanvasOutput,
  startCanvasFixture,
  installCanvasWorkerProbe,
  verifyCanvasWorkers,
} from "./canvas-browser-fixture.mjs";
const factory = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium, webkit, devices } = factory("playwright");
const root = fileURLToPath(
  new URL("../ProserAuthor/packages/canvas-engine/browser/", import.meta.url),
);
const repeatFlag = process.argv.indexOf("--repeat");
const repetitions = repeatFlag < 0 ? 1 : Number(process.argv[repeatFlag + 1]);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50)
  throw new Error("--repeat requires an integer from 1 to 50.");
let server;
const outputFlag = process.argv.indexOf("--output");
if (outputFlag >= 0 && !process.argv[outputFlag + 1])
  throw new Error("--output requires a diagnostic directory.");
let directory =
  outputFlag >= 0
    ? resolve(process.argv[outputFlag + 1])
    : fileURLToPath(
        new URL("../output/playwright/r2-native-core/", import.meta.url),
      );
directory = await reserveCanvasOutput(directory);
const receipt = {
  passed: false,
  repetitions,
  fixtureMode: "production",
  results: [],
  physicalDeviceAcceptance: "unverified",
  startedAt: new Date().toISOString(),
};
const results = receipt.results;
async function withBrowserBudget(action, browserName, mode) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${browserName} ${mode} exceeded its 30000ms Node-side budget`,
              ),
            ),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const log = (entry) =>
  process.stderr.write(`[canvas-mobile] ${JSON.stringify(entry)}\n`);
log({ event: "diagnostic-output", directory });
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
try {
  server = await startCanvasFixture({ root, output: directory });
  receipt.fixtureAssets = server.assets;
  const runs = Array.from({ length: repetitions }, (_, index) =>
    [
      ["chromium", chromium, devices["Pixel 7"]],
      ["webkit", webkit, devices["iPhone 13"]],
    ].map((entry) => [index + 1, ...entry]),
  ).flat();
  for (const [iteration, name, type, device] of runs) {
    const started = Date.now();
    const current = {
      browser: name,
      iteration,
      version: null,
      emulatedDevice: device.userAgent,
      checks: [],
      browserErrors: [],
      lifecycle: [],
      activeCase: "launch",
      cleanup: false,
      completed: false,
      physicalDeviceAcceptance: "unverified",
    };
    results.push(current);
    let browser;
    const event = (kind) => {
      const entry = {
        browser: name,
        iteration,
        version: current.version,
        event: kind,
        activeCase: current.activeCase,
        cleanup: current.cleanup,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - started,
      };
      current.lifecycle.push(entry);
      log(entry);
    };
    try {
      browser = await type.launch({ headless: true });
      current.version = browser.version();
      browser.on("disconnected", () => event("browser-disconnected"));
      event("browser-launched");
      current.activeCase = "page-startup";
      const page = await browser.newPage(device);
      await installCanvasWorkerProbe(page);
      const errors = current.browserErrors;
      page.on("crash", () => event("page-crash"));
      page.on("close", () => event("page-close"));
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.resolvedUrls.local[0]);
      await page.waitForFunction(() => Boolean(window.nativeMobile));
      const checks = current.checks;
      for (const mode of ["normal", "redirect", "destroy"]) {
        current.activeCase = `deferredFocus/${mode}`;
        event("case-start");
        const focus = await withBrowserBudget(
          () =>
            page.evaluate(
              (mode) => window.nativeMobile.deferredFocus(mode),
              mode,
            ),
          name,
          `deferredFocus(${mode})`,
        );
        assert(
          mode === "normal"
            ? focus.agentFocused && focus.attempts === 1
            : focus.externalFocused && focus.attempts === 0,
          `${name} deferred ${mode} focus violated current ownership: ${JSON.stringify(focus)}`,
        );
        checks.push(
          `deferred ${mode} cursor focus respects the current user target and lifecycle`,
        );
        event("case-passed");
      }
      current.activeCase = "rapid-editor-worker-teardown";
      event("case-start");
      await withBrowserBudget(
        () =>
          page.evaluate(async () => {
            for (let index = 0; index < 60; index++) {
              window.nativeMobile.mount();
              window.nativeMobile.select("😀", true);
              // Yield while workers start, then destroy them on the next mount.
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }),
        name,
        current.activeCase,
      );
      const rapid = await page.evaluate(() => window.nativeMobile.snapshot());
      assert(
        rapid.body === "A😀e\u0301Z" && rapid.focused,
        `${name} rapid editor teardown lost Unicode content or input focus.`,
      );
      checks.push(
        "60 rapid focused editor replacements preserve content and worker lifecycle",
      );
      event("case-passed");
      for (const table of [false, true]) {
        for (const [inputType, target, expected] of [
          ["deleteContentBackward", "e\u0301", "A😀Z"],
          ["deleteContentForward", "e\u0301", "A😀e\u0301"],
          ["insertParagraph", "😀", "A😀\ne\u0301Z"],
          ["insertLineBreak", "😀", "A😀\ne\u0301Z"],
        ]) {
          current.activeCase = `${table ? "table-cell" : "body"}/${inputType}`;
          await page.evaluate(
            ({ table, target }) => {
              window.nativeMobile.mount(undefined, table);
              window.nativeMobile.select(target, true);
            },
            { table, target },
          );
          const source = await page.evaluate(() =>
            window.nativeMobile.snapshot(),
          );
          const prevented = await page.evaluate(
            (inputType) => window.nativeMobile.intent(inputType),
            inputType,
          );
          const changed = await page.evaluate(() =>
            window.nativeMobile.snapshot(),
          );
          assert(
            prevented && changed.body === expected,
            `${name} ${inputType} changed wrong Unicode target: ${JSON.stringify(changed.body)}`,
          );
          assert(
            JSON.stringify(changed.data.header) ===
              JSON.stringify(source.data.header) &&
              JSON.stringify(changed.data.footer) ===
                JSON.stringify(source.data.footer),
            `${name} changed ancillary stories.`,
          );
          if (table)
            assert(
              JSON.stringify(changed.data.main[0].trList[0].tdList[1]) ===
                JSON.stringify(source.data.main[0].trList[0].tdList[1]),
              `${name} changed neighboring cell.`,
            );
          if (inputType === "insertLineBreak") {
            const elements = table
              ? changed.data.main[0].trList[0].tdList[0].value
              : changed.data.main;
            assert(
              elements.some(
                (element) =>
                  element.value === "\n" && element.paragraphBreak === false,
              ),
              `${name} soft line break became paragraph break.`,
            );
          }
          await page.evaluate(() => window.nativeMobile.undo());
          const restored = await page.evaluate(() =>
            window.nativeMobile.snapshot(),
          );
          assert(
            JSON.stringify(restored.data) === JSON.stringify(source.data),
            `${name} ${inputType} undo lost styles or identities.`,
          );
          await page.evaluate(() => window.nativeMobile.redo());
          assert(
            (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
              expected,
            `${name} ${inputType} redo failed.`,
          );
          checks.push(
            `${table ? "table-cell" : "body"} ${inputType} exact Unicode/styles/stories/undo/redo`,
          );
        }
      }
      current.activeCase = "keyboard-composition-viewport";
      await page.evaluate(() => {
        window.nativeMobile.mount();
        window.nativeMobile.select("e\u0301", true);
      });
      await page.keyboard.press("Backspace");
      assert(
        (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
          "A😀Z",
        `${name} physical Backspace applied twice.`,
      );
      await page.keyboard.press("Delete");
      assert(
        (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
          "A😀",
        `${name} physical Delete applied twice.`,
      );
      await page.keyboard.type("K");
      assert(
        (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
          "A😀K",
        `${name} typing after deletion lost caret.`,
      );
      checks.push(
        "keyboard deletion applies once and keeps Unicode caret for following input",
      );
      await page.evaluate(() => {
        window.nativeMobile.mount();
        window.nativeMobile.select("😀", true);
        window.nativeMobile.insert("dictated\nline");
      });
      const dictated = await page.evaluate(() =>
        window.nativeMobile.snapshot(),
      );
      assert(
        dictated.body === "A😀dictated\nlinee\u0301Z" &&
          dictated.data.main.some(
            (element) =>
              element.value === "\n" && element.paragraphBreak === false,
          ),
        `${name} multiline text input lost literal soft newline.`,
      );
      checks.push(
        "multiline text/dictation input preserves exact soft newline and Unicode",
      );
      for (const kind of ["heading", "list"]) {
        await page.evaluate((kind) => {
          window.nativeMobile.mount();
          window.nativeMobile.select("😀", true);
          window.nativeMobile.paragraphStyle(kind);
        }, kind);
        const before = await page.evaluate(() =>
          window.nativeMobile.snapshot(),
        );
        await page.keyboard.press("Shift+Enter");
        const after = await page.evaluate(() => window.nativeMobile.snapshot());
        assert(
          after.body === before.body.replace("😀", "😀\n"),
          `${name} ${kind} Shift+Enter changed text.`,
        );
        const expectedType = kind === "heading" ? "title" : "list";
        const beforeWrapper = before.data.main.find(
          (element) => element.type === expectedType,
        );
        const afterWrappers = after.data.main.filter(
          (element) => element.type === expectedType,
        );
        assert(
          afterWrappers.length === 1 &&
            afterWrappers[0][kind === "heading" ? "titleId" : "listId"] ===
              beforeWrapper[kind === "heading" ? "titleId" : "listId"],
          `${name} ${kind} soft Enter split structural identity.`,
        );
        const hasSoftBreak = (elements) =>
          elements.some((element) =>
            element.valueList
              ? hasSoftBreak(element.valueList)
              : element.value === "\n" && element.paragraphBreak === false,
          );
        assert(
          hasSoftBreak(after.data.main),
          `${name} ${kind} Shift+Enter lost soft break flag.`,
        );
        checks.push(
          `keyboard ${kind} Shift+Enter preserves soft break and container identity`,
        );
      }
      await page.evaluate(() => {
        window.nativeMobile.mount();
        window.nativeMobile.select("😀", true);
      });
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("K");
      assert(
        (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
          "A😀\nKe\u0301Z",
        `${name} keyboard soft Enter lost following typing.`,
      );
      checks.push(
        "keyboard body Shift+Enter preserves soft break and following typing",
      );
      await page.evaluate(() => {
        window.nativeMobile.mount();
        window.nativeMobile.select("e\u0301", true);
        window.nativeMobile.intent("deleteContentBackward", false, true, true);
      });
      assert(
        (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
          "A😀e\u0301Z",
        `${name} application-cancelled edit still mutated content.`,
      );
      checks.push("application beforeinput cancellation remains authoritative");
      await page.evaluate(() => {
        window.nativeMobile.mount();
        window.nativeMobile.select("e\u0301", true);
        window.nativeMobile.readonly();
      });
      const blocked = await page.evaluate(() => {
        window.nativeMobile.intent("deleteContentBackward");
        return window.nativeMobile.snapshot();
      });
      assert(
        blocked.body === "A😀e\u0301Z",
        `${name} readonly mobile deletion wrote content.`,
      );
      checks.push("readonly browser edit intentions preserve content");
      await page.evaluate(() => {
        window.nativeMobile.mount();
        window.nativeMobile.select("e\u0301", true);
        window.nativeMobile.composition("compositionstart");
      });
      const guarded = await page.evaluate(() => {
        const prevented = window.nativeMobile.intent(
          "deleteContentBackward",
          true,
        );
        return { prevented, snapshot: window.nativeMobile.snapshot() };
      });
      assert(
        !guarded.prevented && guarded.snapshot.body === "A😀e\u0301Z",
        `${name} virtual key mutated composition.`,
      );
      await page.evaluate(() =>
        window.nativeMobile.composition("compositionend"),
      );
      await page.keyboard.type("K");
      assert(
        (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
          "A😀e\u0301KZ",
        `${name} typing after composition cancellation lost caret.`,
      );
      checks.push(
        "composition input stays fenced and cancellation retains caret and subsequent typing",
      );
      current.activeCase = "visual-viewport-scroll";
      await page.evaluate(() => window.nativeMobile.viewport());
      try {
        await page.waitForFunction(
          () => {
            const bounds = window.nativeMobile.viewportResult();
            return bounds.top >= 0 && bounds.bottom <= bounds.visibleHeight + 1;
          },
          undefined,
          { timeout: 3000 },
        );
      } catch (error) {
        current.viewportAtFailure = await page
          .evaluate(() => window.nativeMobile.viewportResult())
          .catch(() => null);
        throw error;
      }
      const viewport = await page.evaluate(() =>
        window.nativeMobile.viewportResult(),
      );
      assert(
        viewport.top >= 0 && viewport.bottom <= viewport.visibleHeight + 1,
        `${name} caret hidden behind synthetic keyboard: ${JSON.stringify(viewport)}`,
      );
      checks.push(
        "visual viewport keyboard occlusion keeps caret inside visible bounds",
      );
      await page.evaluate(() => window.nativeMobile.reset());
      if (name === "chromium") {
        current.activeCase = "chromium-touch-and-trusted-composition";
        const cdp = await page.context().newCDPSession(page);
        for (const end of [
          "touchEnd",
          "touchCancel",
          "disable",
          "lost-capture",
        ]) {
          await page.evaluate(() => {
            window.nativeMobile.mount("One Two Three Four");
            window.nativeMobile.touch(true);
          });
          const points = await page.evaluate(() =>
            window.nativeMobile.touchPoints(),
          );
          const before = await page.evaluate(() =>
            window.nativeMobile.snapshot(),
          );
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [points.from],
          });
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [points.to],
          });
          if (end === "disable") {
            await page.evaluate(() => window.nativeMobile.touch(false));
            assert(
              !(await page.evaluate(() => window.nativeMobile.snapshot()))
                .captured,
              "Disabling touch selection retained pointer capture.",
            );
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
          } else if (end === "lost-capture") {
            await page.evaluate(() => window.nativeMobile.releasePointer());
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [points.to],
            });
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
          } else
            await cdp.send("Input.dispatchTouchEvent", {
              type: end,
              touchPoints: [],
            });
          const after = await page.evaluate(() =>
            window.nativeMobile.snapshot(),
          );
          assert(
            JSON.stringify(after.data) === JSON.stringify(before.data),
            `${end} touch selection mutated content: ${after.body}`,
          );
          if (end !== "touchEnd")
            assert(
              after.range.startIndex === before.range.startIndex &&
                after.range.endIndex === before.range.endIndex,
              `${end} touch cancellation lost original selection.`,
            );
          assert(
            !after.captured,
            `${end} touch selection retained pointer capture.`,
          );
          checks.push(
            `${end} actual CDP touch selection preserves content and releases capture`,
          );
        }
        await page.evaluate(() =>
          window.nativeMobile.mount("One Two Three Four"),
        );
        const points = await page.evaluate(() =>
          window.nativeMobile.touchPoints(),
        );
        await page.mouse.move(points.from.x, points.from.y);
        await page.mouse.down();
        await page.mouse.move(points.to.x, points.to.y, { steps: 3 });
        await page.mouse.up();
        assert(
          (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
            "One  Three FourTwo",
          "Mouse drag behavior changed with touch-only selection patch.",
        );
        checks.push("ordinary mouse text drag remains supported");
        await page.evaluate(() => {
          window.nativeMobile.mount();
          window.nativeMobile.select("e\u0301", true);
        });
        await cdp.send("Input.imeSetComposition", {
          text: "漢",
          selectionStart: 1,
          selectionEnd: 1,
        });
        await cdp.send("Input.insertText", { text: "漢字" });
        await page.waitForFunction(
          () => window.nativeMobile.snapshot().body === "A😀e\u0301漢字Z",
        );
        assert(
          (await page.evaluate(() => window.nativeMobile.snapshot())).body ===
            "A😀e\u0301漢字Z",
          "Trusted CDP IME did not commit exact composition once.",
        );
        checks.push(
          "trusted Chromium composition commits once with Unicode and following text intact",
        );
        await page.evaluate(() => {
          window.nativeMobile.mount(undefined, true);
          window.nativeMobile.select("e\u0301", true);
          window.nativeMobile.touch(true);
        });
        const compositionTableBefore = await page.evaluate(() =>
          window.nativeMobile.snapshot(),
        );
        await cdp.send("Input.imeSetComposition", {
          text: "漢",
          selectionStart: 1,
          selectionEnd: 1,
        });
        const tableRect = await page
          .locator("canvas[data-index]")
          .first()
          .boundingBox();
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: tableRect.x + 205, y: tableRect.y + 55 }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.send("Input.insertText", { text: "漢字" });
        await page.waitForFunction(
          () => window.nativeMobile.snapshot().body === "A😀e\u0301漢字Z",
        );
        const compositionTableAfter = await page.evaluate(() =>
          window.nativeMobile.snapshot(),
        );
        assert(
          compositionTableAfter.body === "A😀e\u0301漢字Z" &&
            JSON.stringify(
              compositionTableAfter.data.main[0].trList[0].tdList[1],
            ) ===
              JSON.stringify(
                compositionTableBefore.data.main[0].trList[0].tdList[1],
              ),
          "Touch during composition retargeted a different table cell: " +
            JSON.stringify({
              before: compositionTableBefore.body,
              after: compositionTableAfter.body,
              neighborBefore:
                compositionTableBefore.data.main[0].trList[0].tdList[1],
              neighborAfter:
                compositionTableAfter.data.main[0].trList[0].tdList[1],
            }),
        );
        checks.push(
          "touch during trusted composition preserves the original table-cell target and neighboring cell",
        );
      }
      assert(!errors.length, `${name} browser errors: ${errors.join("; ")}`);
      const workers = await verifyCanvasWorkers(page, 240);
      current.workerCount = workers.count;
      checks.push(
        "real compiled inline workers run without development module URLs or worker errors",
      );
      await page.evaluate(() => window.nativeMobile.reset());
      current.completed = true;
    } catch (error) {
      current.failure = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        activeCase: current.activeCase,
      };
      event("browser-case-failed");
      throw error;
    } finally {
      current.cleanup = true;
      event("browser-cleanup-start");
      try {
        await browser?.close();
      } catch (error) {
        current.cleanupFailure =
          error instanceof Error ? error.message : String(error);
        if (!current.failure) throw error;
      } finally {
        event("browser-cleanup-end");
      }
    }
  }
  receipt.passed = true;
} catch (error) {
  receipt.failure = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  throw error;
} finally {
  try {
    await server?.close();
  } catch (error) {
    receipt.passed = false;
    receipt.serverCleanupFailure =
      error instanceof Error ? error.message : String(error);
    if (!receipt.failure) throw error;
  } finally {
    receipt.completedAt = new Date().toISOString();
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    process.stdout.write(JSON.stringify(receipt) + "\n");
  }
}
