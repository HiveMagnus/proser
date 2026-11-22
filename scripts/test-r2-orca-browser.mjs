import {
  writeOrcaFixture,
  installOrcaFixtureAssets,
} from "./orca-browser-fixture.mjs";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  reserveCanvasOutput,
  startCanvasFixture,
  installCanvasWorkerProbe,
  verifyCanvasWorkers,
  closeCanvasFixture,
} from "./canvas-browser-fixture.mjs";

const run = promisify(execFile);
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const outputArgument = flag("--output");
if (
  !process.argv.includes("--output") ||
  !outputArgument ||
  outputArgument.startsWith("--")
)
  throw new Error("--output requires an explicit diagnostic directory.");
const output = resolve(outputArgument);
const repository = fileURLToPath(new URL("../", import.meta.url));
const sourceDigest = async (name) =>
  createHash("sha256")
    .update(
      await readFile(
        resolve(
          repository,
          "ProserAuthor/packages/editor/src/components",
          name,
        ),
      ),
    )
    .digest("hex");
const semanticSourceSha256 = await sourceDigest("semantic-document.tsx");
const nativeSourceSha256 = await sourceDigest("canvas-document-editor.tsx");
const factory = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = factory("playwright");
const fixture = await writeOrcaFixture(output, repository);
let server, browser, page;
let acceptanceComplete = false;
let primaryFailure;
const checks = [];
const errors = [];
const modeTransitions = [];
let lastModeCommandAt = 0;
let startupReadiness;
const keyboard = async (...keys) =>
  run("/usr/bin/python3", [
    fileURLToPath(new URL("./test-r2-orca-session.py", import.meta.url)),
    "--keys",
    ...keys,
  ]);
const speechSince = async (offset) =>
  (await readFile(resolve(output, "orca-debug.log"), "utf8"))
    .slice(offset)
    .split("\n")
    .filter((line) => line.includes("SPEECH OUTPUT:"))
    .join("\n");
const focusSnapshot = () =>
  page.evaluate(() => ({
    documentFocused: document.hasFocus(),
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute("aria-label"),
    text: document.activeElement?.textContent?.trim().slice(0, 80),
  }));
const waitForSpeech = async (offset, pattern) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const speech = await speechSince(offset);
    if (pattern.test(speech)) return speech;
    await new Promise((done) => setTimeout(done, 100));
  }
  const speech = await speechSince(offset);
  assert.match(speech, pattern, "Timed out awaiting a fresh Orca announcement");
};
const ensureOrcaMode = async (mode) => {
  // Historical announcements can predate automatic focus-mode transitions.
  // Toggle and require a fresh acknowledgement; at most two toggles establish
  // either desired mode without trusting an old line or retrying test actions.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Orca binds double/triple Insert+a to sticky modes; its pinned runtime
    // doubleClickTimeout is 0.5s. Keep these intentional single toggles apart.
    const remaining = 650 - (Date.now() - lastModeCommandAt);
    if (remaining > 0) await new Promise((done) => setTimeout(done, remaining));
    const offset = (await readFile(resolve(output, "orca-debug.log"), "utf8"))
      .length;
    const beforeFocus = await focusSnapshot();
    lastModeCommandAt = Date.now();
    await keyboard("Insert+a");
    const speech = await waitForSpeech(
      offset,
      /SPEECH OUTPUT: '(Focus mode|Browse mode)'/,
    );
    const announced = [
      ...speech.matchAll(/SPEECH OUTPUT: '(Focus mode|Browse mode)'/g),
    ].at(-1)?.[1];
    modeTransitions.push({
      requested: mode,
      announced,
      at: new Date().toISOString(),
      beforeFocus,
      afterFocus: await focusSnapshot(),
      speech,
    });
    if (announced === mode) return;
  }
  assert.fail(`Orca did not freshly acknowledge its ${mode} keyboard command`);
};
const stopPageReading = async () => {
  const offset = (await readFile(resolve(output, "orca-debug.log"), "utf8"))
    .length;
  await keyboard("Control_L");
  const deadline = Date.now() + 15000;
  let observedActivity = -1,
    quietSince = Date.now();
  while (Date.now() < deadline) {
    const log = (
      await readFile(resolve(output, "orca-debug.log"), "utf8")
    ).slice(offset);
    const activity = Math.max(
      log.lastIndexOf("__sayAllProgressCallback"),
      log.lastIndexOf("WEB SAY ALL:"),
      log.lastIndexOf("WEB: SayAll called"),
    );
    if (activity !== observedActivity) {
      observedActivity = activity;
      quietSince = Date.now();
    }
    const state = [
      ...log.matchAll(
        /WEB: textLines complete\. Verifying SayAll status|DEFAULT: (?:Not in SayAll|SayAll is interrupted)/g,
      ),
    ].at(-1);
    if (
      log.includes("DEFAULT: Interrupting presentation") &&
      state &&
      state.index > activity &&
      Date.now() - quietSince >= 300
    ) {
      startupReadiness = {
        input: "Control_L",
        state: state[0],
        at: new Date().toISOString(),
        focus: await focusSnapshot(),
      };
      return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(
    "Orca page-load SayAll did not become observably quiescent after Control stop",
  );
};
try {
  let url;
  {
    server = await startCanvasFixture({
      output: await reserveCanvasOutput(resolve(output, "canvas-browser")),
      root: fixture,
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
    url = server.resolvedUrls.local[0];
  }
  browser = await chromium.launch({
    headless: false,
    args: ["--force-renderer-accessibility", "--disable-gpu"],
  });
  page = await browser.newPage();
  await installCanvasWorkerProbe(page);
  await installOrcaFixtureAssets(page);
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector("textarea");
  await run("/usr/bin/python3", [
    fileURLToPath(new URL("./test-r2-orca-session.py", import.meta.url)),
    "--focus",
    "Proser R2 Orca",
  ]);
  await stopPageReading();
  const initialFocusOffset = (
    await readFile(resolve(output, "orca-debug.log"), "utf8")
  ).length;
  await page.getByRole("button", { name: "Reader start" }).focus();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Reader start",
  );
  await waitForSpeech(initialFocusOffset, /SPEECH OUTPUT:.*Reader start/);
  const offset = (await readFile(resolve(output, "orca-debug.log"), "utf8"))
    .length;
  await keyboard("Tab");
  await new Promise((done) => setTimeout(done, 800));
  const focusSpeech = await speechSince(offset);
  assert.match(focusSpeech, /SPEECH OUTPUT:.*Paragraph 1/);
  checks.push(
    "Orca announces the editable paragraph after an actual X11 Tab event",
  );
  await ensureOrcaMode("Focus mode");
  await keyboard("Control_L+End", "space", "p", "r", "o", "o", "f");
  await page.waitForFunction(() => (window.orcaEdits ?? 0) > 0);
  assert.match(
    await page
      .getByRole("textbox", { name: "Paragraph 1", exact: true })
      .inputValue(),
    /proof$/,
  );
  checks.push("Actual X11 typing changes the controlled semantic paragraph");
  const paragraphOffset = (
    await readFile(resolve(output, "orca-debug.log"), "utf8")
  ).length;
  await keyboard("Alt_L+Down", "Control_L+a");
  await new Promise((done) => setTimeout(done, 600));
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Paragraph 2",
  );
  assert.match(
    await speechSince(paragraphOffset),
    /SPEECH OUTPUT:.*Unicode 😀 é/,
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Paragraph 2", exact: true })
      .evaluate(
        (field) =>
          field.selectionStart === 0 &&
          field.selectionEnd === field.value.length,
      ),
    true,
  );
  checks.push(
    "Alt+Down moves keyboard focus to the next canonical paragraph and Orca announces its Unicode text selection",
  );
  await page.getByRole("button", { name: "Reader start" }).focus();
  await new Promise((done) => setTimeout(done, 200));
  await ensureOrcaMode("Browse mode");
  const browseOffset = (
    await readFile(resolve(output, "orca-debug.log"), "utf8")
  ).length;
  await keyboard("h");
  await new Promise((done) => setTimeout(done, 800));
  const headingSpeech = await speechSince(browseOffset);
  assert.match(
    headingSpeech,
    /SPEECH OUTPUT:.*(R2 screen reader manuscript|Heading|heading)/,
  );
  checks.push(
    "Orca heading navigation announces manuscript headings using a real X11 quick-navigation key",
  );
  await page.getByRole("button", { name: "Read only mode" }).focus();
  const modeOffset = (await readFile(resolve(output, "orca-debug.log"), "utf8"))
    .length;
  await keyboard("Return");
  await page.waitForSelector("textarea", { state: "detached" });
  await new Promise((done) => setTimeout(done, 500));
  assert.match(
    await speechSince(modeOffset),
    /SPEECH OUTPUT:.*Read-only mode enabled/,
  );
  checks.push(
    "Orca announces the live read-only state after keyboard activation",
  );
  for (const [key, pattern, description] of [
    ["l", /SPEECH OUTPUT:.*(list|First list item)/i, "semantic list"],
    [
      "t",
      /SPEECH OUTPUT:.*(Manuscript table|table with)/i,
      "table caption and topology",
    ],
    [
      "g",
      /SPEECH OUTPUT:.*Accessible image description/i,
      "owned image alternative text",
    ],
  ]) {
    await page.getByRole("button", { name: "Reader start" }).focus();
    await new Promise((done) => setTimeout(done, 150));
    const start = (await readFile(resolve(output, "orca-debug.log"), "utf8"))
      .length;
    await keyboard(key);
    await new Promise((done) => setTimeout(done, 600));
    assert.match(await speechSince(start), pattern);
    checks.push(
      `Orca quick navigation announces ${description} in read-only mode`,
    );
  }
  await page.getByRole("button", { name: "Open native editor" }).focus();
  await new Promise((done) => setTimeout(done, 200));
  await keyboard("Return");
  const nativeRegion = page.getByRole("region", {
    name: "Page editing surface",
    exact: true,
  });
  await nativeRegion.waitFor();
  await page.waitForSelector('[aria-label="Canvas writing input"]', {
    state: "attached",
  });
  const originalNative = await page.evaluate(() => window.nativeFixture);
  await page.evaluate(() => {
    window.nativeKeyEvents = [];
    window.nativeFocusEvents = [];
    document.addEventListener(
      "focusin",
      (event) =>
        window.nativeFocusEvents.push({
          label: event.target?.getAttribute?.("aria-label"),
          tag: event.target?.tagName,
          text: event.target?.textContent?.slice(0, 60),
        }),
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        const record = {
          key: event.key,
          shift: event.shiftKey,
          target: event.target?.getAttribute?.("aria-label"),
        };
        const host = event.target?.closest?.(
          '[aria-label="Page editing surface"]',
        );
        if (event.key === "Tab" && host) {
          const candidates = [
            ...document.querySelectorAll(
              "button,input,select,textarea,a[href],summary,[tabindex]",
            ),
          ].filter(
            (node) =>
              node.tabIndex >= 0 &&
              !node.matches(":disabled") &&
              !node.closest("[inert]") &&
              !host.contains(node) &&
              node !== host &&
              node.getClientRects().length > 0,
          );
          const direction = event.shiftKey
            ? Node.DOCUMENT_POSITION_PRECEDING
            : Node.DOCUMENT_POSITION_FOLLOWING;
          const destination = (
            event.shiftKey ? candidates.reverse() : candidates
          ).find(
            (node) => event.target.compareDocumentPosition(node) & direction,
          );
          record.destination = destination
            ? {
                label: destination.getAttribute("aria-label"),
                tag: destination.tagName,
                text: destination.textContent.slice(0, 60),
                rect: destination.getBoundingClientRect().toJSON(),
                tabIndex: destination.tabIndex,
                detailsOpen: destination.closest("details")?.open,
                visibility: getComputedStyle(destination).visibility,
              }
            : null;
        }
        setTimeout(
          () =>
            window.nativeKeyEvents.push({
              ...record,
              prevented: event.defaultPrevented,
              active: document.activeElement?.getAttribute("aria-label"),
              tag: document.activeElement?.tagName,
            }),
          0,
        );
      },
      true,
    );
  });
  await new Promise((done) => setTimeout(done, 600));
  await keyboard("Shift_L+Tab");
  await new Promise((done) => setTimeout(done, 300));
  const backwardsFocus = await page.evaluate(() => ({
    label: document.activeElement?.getAttribute("aria-label"),
    tag: document.activeElement?.tagName,
  }));
  console.log(JSON.stringify({ backwardsFocus }));
  console.log(
    JSON.stringify({
      nativeKeyEvents: await page.evaluate(() => window.nativeKeyEvents),
    }),
  );
  console.log(
    JSON.stringify({
      nativeFocusEvents: await page.evaluate(() => window.nativeFocusEvents),
    }),
  );
  await writeFile(
    resolve(output, "native-focus-diagnostics.json"),
    JSON.stringify(
      await page.evaluate(() => ({
        keys: window.nativeKeyEvents,
        focus: window.nativeFocusEvents,
      })),
      null,
      2,
    ) + "\n",
  );
  assert.notEqual(
    backwardsFocus.label,
    "Canvas writing input",
    "Backward Tab must leave the Canvas input rather than loop through its enclosing entry region",
  );
  assert.equal(
    await page.evaluate(() => window.nativeFixture.canonical),
    originalNative.canonical,
  );
  await new Promise((done) => setTimeout(done, 200));
  const nativeOffset = (
    await readFile(resolve(output, "orca-debug.log"), "utf8")
  ).length;
  await keyboard("Tab");
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Canvas writing input",
  );
  assert.match(
    await speechSince(nativeOffset),
    /SPEECH OUTPUT:.*Canvas writing input/,
  );
  checks.push(
    "Keyboard Tab enters the actual paginated Canvas input and Orca announces its owned label",
  );
  await ensureOrcaMode("Focus mode");
  await keyboard("n", "a", "t", "i", "v", "e");
  await page.waitForFunction(
    (before) => window.nativeFixture.text !== before,
    originalNative.text,
  );
  const typedNative = await page.evaluate(() => window.nativeFixture);
  assert.equal(typedNative.text, "native" + originalNative.text);
  assert.equal(typedNative.protected, originalNative.protected);
  assert.notEqual(typedNative.canonical, originalNative.canonical);
  checks.push(
    "Actual X11 native typing changes only its target text while canonical styles, layout, table, image and review state remain intact",
  );
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .focus();
  await new Promise((done) => setTimeout(done, 200));
  const accessibleOffset = (
    await readFile(resolve(output, "orca-debug.log"), "utf8")
  ).length;
  await keyboard("Return");
  const firstAccessible = page.getByRole("textbox", {
    name: "Paragraph 1",
    exact: true,
  });
  await firstAccessible.waitFor();
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(
    await firstAccessible.evaluate(
      (field) =>
        document.activeElement === field &&
        field.selectionStart === 6 &&
        field.selectionEnd === 6,
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.nativeFixture.canonical),
    typedNative.canonical,
  );
  assert.match(
    await speechSince(accessibleOffset),
    /SPEECH OUTPUT:.*Paragraph 1/,
  );
  checks.push(
    "Keyboard mode switching announces the accessible paragraph and preserves its canonical document and UTF-16 caret",
  );
  await ensureOrcaMode("Focus mode");
  await keyboard("Control_L+z");
  await page.waitForFunction(
    (count) => window.nativeFixture.undoCount > count,
    typedNative.undoCount,
  );
  assert.notEqual(
    await page.evaluate(() => window.nativeFixture.canonical),
    typedNative.canonical,
  );
  await keyboard("Control_L+y");
  await page.waitForFunction(
    (count) => window.nativeFixture.redoCount > count,
    typedNative.redoCount,
  );
  assert.equal(
    await page.evaluate(() => window.nativeFixture.canonical),
    typedNative.canonical,
  );
  checks.push(
    "Accessible keyboard undo/redo uses the shared owned history callback and restores the exact native canonical state",
  );
  await page.getByRole("button", { name: "Page editor", exact: true }).focus();
  await new Promise((done) => setTimeout(done, 200));
  await keyboard("Return");
  await page.waitForSelector('[aria-label="Canvas writing input"]', {
    state: "attached",
  });
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(
    await page.evaluate(() => window.nativeFixture.canonical),
    typedNative.canonical,
  );
  await nativeRegion.focus();
  await new Promise((done) => setTimeout(done, 400));
  await ensureOrcaMode("Focus mode");
  const historyBefore = await page.evaluate(() => window.nativeFixture);
  await keyboard("Control_L+z", "Control_L+y");
  await page.waitForFunction(
    (counts) =>
      window.nativeFixture.undoCount > counts.undoCount &&
      window.nativeFixture.redoCount > counts.redoCount,
    historyBefore,
  );
  assert.equal(
    await page.evaluate(() => window.nativeFixture.canonical),
    typedNative.canonical,
  );
  assert.deepEqual(await page.evaluate(() => window.nativeErrors ?? []), []);
  checks.push(
    "Returning to Canvas keeps canonical identity and keyboard history under the same owned callback journal",
  );
  const preview = page.getByText("Read this passage", { exact: true });
  await preview.focus();
  await new Promise((done) => setTimeout(done, 200));
  await keyboard("Return");
  await page.getByRole("article", { name: "Semantic manuscript" }).waitFor();
  assert.equal(
    await page.evaluate(() => window.nativeFixture.canonical),
    typedNative.canonical,
  );
  checks.push(
    "Read this passage exposes the same native draft as semantic read-only content without a document mutation",
  );
  assert.deepEqual(errors, []);
  assert.equal(
    await sourceDigest("semantic-document.tsx"),
    semanticSourceSha256,
    "Semantic source changed during the retained Orca run",
  );
  assert.equal(
    await sourceDigest("canvas-document-editor.tsx"),
    nativeSourceSha256,
    "Native adapter source changed during the retained Orca run",
  );
  await page.screenshot({
    path: resolve(output, "orca-headed.png"),
    fullPage: true,
  });
  const utterances = (await readFile(resolve(output, "orca-debug.log"), "utf8"))
    .split("\n")
    .filter((line) => line.includes("SPEECH OUTPUT:"));
  await writeFile(
    resolve(output, "speech-output.log"),
    utterances.join("\n") + "\n",
  );
  await writeFile(
    resolve(output, "acceptance.json"),
    JSON.stringify(
      {
        status: "pass",
        checks,
        browserVersion: browser.version(),
        input: "XTest X11 keyboard events observed by actual AT-SPI/Orca",
        workers: await verifyCanvasWorkers(page),
        fixtureMode: "production",
        fixtureAssets: server.assets,
        semanticSourceSha256,
        nativeSourceSha256,
        modeTransitions,
        startupReadiness,
        speechOutputSha256: createHash("sha256")
          .update(utterances.join("\n") + "\n")
          .digest("hex"),
        browserErrors: errors,
        limits: [
          "Orca generated speech and dispatcher dummy-sink output; audible synthesis and physical braille unverified",
          "Linux Chromium semantic editing; this does not certify iPhone VoiceOver or physical keyboard/touch hardware",
          "Standalone synthetic component fixture; persisted full application workflow has separate authenticated acceptance",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ status: "pass", checks }));
  acceptanceComplete = true;
} catch (error) {
  primaryFailure = error;
  await writeFile(
    resolve(output, "acceptance.json"),
    JSON.stringify(
      {
        status: "fail",
        checks,
        error: error.message,
        browserErrors: errors,
        focus: await focusSnapshot().catch(() => undefined),
        modeTransitions,
        startupReadiness,
        recentSpeech: (await speechSince(0)).split("\n").slice(-20),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  const terminal = {
    passed: acceptanceComplete && !primaryFailure,
    acceptanceComplete,
    primaryFailure: primaryFailure?.message,
  };
  const cleanup = await closeCanvasFixture(browser, server, terminal);
  const directory = await reserveCanvasOutput(
    resolve(output, "canvas-terminal"),
  );
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify(terminal, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  if (cleanup && !primaryFailure) throw cleanup;
}
