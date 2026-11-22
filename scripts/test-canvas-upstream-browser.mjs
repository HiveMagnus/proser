import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  reserveCanvasOutput,
  startCanvasFixture,
  installCanvasWorkerProbe,
  verifyCanvasWorkers,
  settleCanvasFrame,
  closeCanvasFixture,
} from "./canvas-browser-fixture.mjs";
const factory = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = factory("playwright");
const output = await reserveCanvasOutput(
  process.env.PROSER_UPSTREAM_BROWSER_OUTPUT ??
    fileURLToPath(
      new URL("../output/upstream-current-20261012/browser/", import.meta.url),
    ),
);
let server;
const fixture = {
  output,
  entry: "upstream-input.html",
  root: fileURLToPath(
    new URL("../ProserAuthor/packages/canvas-engine/browser/", import.meta.url),
  ),
};
const report = {
  passed: false,
  fixtureMode: "production",
  checks: [],
  differential: [],
  failures: [],
  browserErrors: [],
  physicalDeviceAcceptance: "unverified",
  performanceCertification: "deferred-R6",
};
let browser;
let page;
try {
  server = await startCanvasFixture(fixture);
  report.fixtureAssets = server.assets;
  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  await installCanvasWorkerProbe(page);
  page.on("pageerror", (error) => report.browserErrors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "upstream-input.html");
  await page.waitForFunction(() => Boolean(window.upstreamAcceptance));
  const snapshot = () =>
    page.evaluate(() => window.upstreamAcceptance.snapshot());
  const click = async (query) => {
    const before = await snapshot();
    const point = await page.evaluate(
      (query) => window.upstreamAcceptance.point(query),
      query,
    );
    // A keydown can reveal the focused input at the old anchor. Complete that
    // and its deferred cursor work before scrolling and measuring the target.
    await page.keyboard.down("Shift");
    await settleCanvasFrame(page);
    await page
      .locator(`canvas[data-index="${point.pageNo}"]`)
      .scrollIntoViewIfNeeded();
    await settleCanvasFrame(page);
    const visible = await page.evaluate(
      (query) => window.upstreamAcceptance.point(query),
      query,
    );
    const viewport = page.viewportSize();
    assert.ok(
      visible.x >= 0 &&
        visible.x < viewport.width &&
        visible.y >= 0 &&
        visible.y < viewport.height,
      `Selection target must be visible: ${JSON.stringify(visible)}`,
    );
    await page.mouse.click(visible.x, visible.y);
    await page.keyboard.up("Shift");
    const after = await snapshot();
    report.clicks ??= [];
    report.clicks.push({
      query,
      point: visible,
      before: before.range,
      after: after.range,
    });
  };
  await page.evaluate(() => window.upstreamAcceptance.mount());
  const initial = await snapshot();
  const anchor = await page.evaluate(() =>
    window.upstreamAcceptance.place("Line001"),
  );
  await click("Line004");
  const selected = await snapshot();
  assert.equal(selected.range.startIndex, anchor.range.startIndex);
  await page.keyboard.press("Shift+ArrowDown");
  const extended = await snapshot();
  assert.equal(extended.range.startIndex, selected.range.startIndex);
  assert.ok(extended.range.endIndex > selected.range.endIndex);
  await page.keyboard.press("Shift+ArrowUp");
  const shrunk = await snapshot();
  assert.equal(shrunk.range.startIndex, selected.range.startIndex);
  assert.ok(shrunk.range.endIndex < extended.range.endIndex);
  assert.deepEqual(shrunk.value, initial.value);
  report.checks.push(
    "native Shift+click then Shift+Down/Up retains the original anchor and exact Unicode/IDs",
  );

  const aboveInitial = await page.evaluate(() =>
    window.upstreamAcceptance.mount(),
  );
  await page.evaluate(() => window.upstreamAcceptance.place("Line010"));
  const aboveAnchor = await snapshot();
  await click("Line007");
  const above = await snapshot();
  await page.keyboard.press("Shift+ArrowUp");
  const aboveExtended = await snapshot();
  assert.equal(above.range.endIndex, aboveAnchor.range.endIndex);
  assert.equal(aboveExtended.range.endIndex, aboveAnchor.range.endIndex);
  assert.ok(aboveExtended.range.startIndex < above.range.startIndex);
  assert.deepEqual(aboveExtended.value, aboveInitial.value);
  report.checks.push(
    "native upward Shift selection keeps the lower anchor fixed",
  );

  const multipageInitial = await page.evaluate(() =>
    window.upstreamAcceptance.mount(),
  );
  const multipageAnchor = await page.evaluate(() =>
    window.upstreamAcceptance.place("Line001"),
  );
  report.activeCase = "multipage-selection-scroll";
  await click("Line055");
  await page.waitForFunction(
    () => window.upstreamAcceptance.snapshot().scrollY > 900,
  );
  await settleCanvasFrame(page);
  const beforeScroll = await snapshot();
  assert.equal(beforeScroll.range.startIndex, multipageAnchor.range.startIndex);
  assert.ok(beforeScroll.range.endIndex > multipageAnchor.range.endIndex);
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("ce-inputarea"),
  );
  await page.keyboard.press("Shift+ArrowUp");
  await page.waitForFunction((before) => {
    const range = window.upstreamAcceptance.snapshot().range;
    return (
      range.startIndex !== before.startIndex ||
      range.endIndex !== before.endIndex
    );
  }, beforeScroll.range);
  await settleCanvasFrame(page);
  const afterScroll = await snapshot();
  report.selectionScroll = {
    before: { range: beforeScroll.range, scrollY: beforeScroll.scrollY },
    after: { range: afterScroll.range, scrollY: afterScroll.scrollY },
  };
  assert.ok(beforeScroll.scrollY > 900);
  assert.ok(Math.abs(afterScroll.scrollY - beforeScroll.scrollY) < 900);
  assert.equal(afterScroll.range.startIndex, beforeScroll.range.startIndex);
  assert.deepEqual(afterScroll.value, multipageInitial.value);
  report.checks.push(
    "shrinking a multipage selection follows its active end without jumping to the anchor",
  );

  await page.evaluate(() => window.upstreamAcceptance.mount("table"));
  const tableInitial = await snapshot();
  await page.evaluate(() => window.upstreamAcceptance.place("Line001"));
  const tableAnchor = await snapshot();
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press("Shift+ArrowDown");
    const selected = await snapshot();
    assert.equal(selected.range.startIndex, tableAnchor.range.startIndex);
    assert.equal(selected.tableContext, false);
    assert.ok(selected.range.endIndex > selected.range.startIndex);
    assert.deepEqual(selected.value, tableInitial.value);
  }
  report.checks.push(
    "native Shift+Down crosses tables as whole objects without collapsing or entering a cell",
  );
  for (const kind of ["plain", "giant", "layout", "table"])
    report.differential.push(
      await page.evaluate(
        (kind) => window.upstreamAcceptance.differential(kind),
        kind,
      ),
    );
  report.checks.push(
    "opt-in incremental and full layout agree after Unicode edits and undo/redo; Proser geometry falls back",
  );
  assert.deepEqual(report.browserErrors, []);
  report.workers = await verifyCanvasWorkers(page);
  report.passed = true;
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack });
  report.stateAtFailure = await page
    ?.evaluate(() => {
      const state = window.upstreamAcceptance.snapshot();
      return { range: state.range, scrollY: state.scrollY };
    })
    .catch(() => null);
  process.exitCode = 1;
} finally {
  const cleanup = await closeCanvasFixture(browser, server, report);
  await writeFile(
    output + "/result.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(report));
  if (cleanup) process.exitCode = 1;
}
