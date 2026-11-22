import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { testR2QuickDraft } from "./test-r2-quick-draft.mjs";
import { testR2AuthenticatedWorkspace } from "./test-r2-authenticated-workspace.mjs";
import { testR2BookCatalog } from "./test-r2-book-catalog.mjs";
import { testManuscriptNavigation } from "./test-manuscript-navigation.mjs";
import { settleCanvasFrame } from "./canvas-browser-fixture.mjs";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const base = new URL(
  process.env.PROSER_RELEASE_SMOKE_BASE_URL ?? "http://localhost:3320",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw new Error("Release workspace fixtures require loopback Author.");
const username = process.env.PLAYWRIGHT_IAM_USERNAME,
  password = process.env.PLAYWRIGHT_IAM_PASSWORD;
if (!username || !password)
  throw new Error("Explicit disposable browser credentials are required.");
const output = path.resolve(
  process.env.PROSER_RELEASE_SMOKE_OUTPUT ??
    "output/playwright/release-workspace",
);
await mkdir(output, { recursive: true, mode: 0o700 });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  checks: [],
  failures: [],
  browserErrors: [],
  fullSceneUIReads: [],
  readerSceneReads: [],
  maximumPassageResponseBytes: 0,
  mobileCertification: "pending-physical-device-R2",
  performanceCertification: "deferred-R6",
  microsoftWord: "unverified",
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
let bookId;
const errors = report.browserErrors;
let editing = true;
page.on("pageerror", (error) => errors.push(error.message));
context.on("request", (request) => {
  if (
    request.method() === "GET" &&
    /\/scenes\/\d+\/document(?:\?|$)/.test(new URL(request.url()).pathname)
  )
    (editing ? report.fullSceneUIReads : report.readerSceneReads).push(
      new URL(request.url()).pathname,
    );
});
context.on("response", async (response) => {
  if (
    response.request().method() === "GET" &&
    /\/document-passages(?:\?|$)/.test(response.url())
  ) {
    try {
      const body = await response.body();
      report.maximumPassageResponseBytes = Math.max(
        report.maximumPassageResponseBytes,
        body.byteLength,
      );
    } catch {}
  }
});
const verify = (condition, message) => {
  if (!condition) throw new Error(message);
};
const saved = async () => {
  // Deliver the input/change task and React paint before observing Saved;
  // the label from the previous revision must not satisfy this wait.
  await settleCanvasFrame(page);
  await page
    .getByText("Saved", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
};
let call;
try {
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
  call = async (route, data, method = data === undefined ? "GET" : "POST") => {
    const response = await page.request.fetch(new URL(route, base).href, {
      method,
      data,
      timeout: 120000,
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
  const book = await call("/api/books", {
    title: `Disposable bounded release ${randomUUID()}`,
    operationId: randomUUID(),
  });
  bookId = book.id;
  const preconditions = async () => {
    const manifest = await call(`/api/books/${bookId}/document-manifest`);
    return {
      operationId: randomUUID(),
      expectedRevisionId: manifest.revisionId,
      expectedScopes: { structure: manifest.scopes.structure.revisionId },
    };
  };
  const { act } = await call(`/api/books/${bookId}/acts`, {
    title: "Release fixture",
    documentPreconditions: await preconditions(),
  });
  const { chapter } = await call(
    `/api/books/${bookId}/acts/${act.id}/chapters`,
    { title: "Bounded source", documentPreconditions: await preconditions() },
  );
  const giant = Array.from({ length: 300000 }, () => "word").join(" ");
  await call(`/api/books/${bookId}/chapters/${chapter.id}/scenes/batch`, {
    scenes: [
      { prose: giant, summary: "Single giant paragraph fixture" },
      {
        prose: "Destination paragraph retains its own text.",
        summary: "Adjacent destination fixture",
      },
    ],
    documentPreconditions: await preconditions(),
  });
  const manifest = await call(`/api/books/${bookId}/document-manifest`),
    first = manifest.scenes[0],
    second = manifest.scenes[1];
  await page.goto(
    new URL(`/manuscript?bookId=${bookId}&sceneId=${first.sceneId}`, base).href,
  );
  await saved();
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const field = page.getByRole("textbox", { name: "Paragraph 1", exact: true });
  await field.waitFor();
  const initial = await field.inputValue();
  verify(
    initial.length < 16001,
    "The browser loaded the complete giant scene.",
  );
  const staleTab = await context.newPage();
  staleTab.on("pageerror", (error) => errors.push(error.message));
  await staleTab.goto(
    new URL(`/manuscript?bookId=${bookId}&sceneId=${first.sceneId}`, base).href,
  );
  await staleTab
    .getByText("Saved", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await staleTab
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const staleField = staleTab.getByRole("textbox", {
    name: "Paragraph 1",
    exact: true,
  });
  const staleOriginal = await staleField.inputValue();
  const marker = " release-proof";
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passages/operations"),
  );
  const modified = initial.slice(0, 100) + marker + initial.slice(100);
  await field.fill(modified);
  const committed = await response;
  verify(committed.ok(), "Bounded typing failed its revision-safe commit.");
  const receipt = (await committed.json()).data;
  verify(
    !("scenes" in receipt) &&
      receipt.result.passage &&
      receipt.result.operationMappings,
    "Typing acknowledgement transported complete scenes or omitted mappings.",
  );
  await saved();
  const projected = (await call(`/api/books/${bookId}/scenes/${first.sceneId}`))
    .scene;
  verify(
    projected.prose === giant.slice(0, 100) + marker + giant.slice(100),
    "Bounded typing modified content outside its exact intended source.",
  );
  const staleResponse = staleTab.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passages/operations"),
  );
  await staleField.fill(
    staleOriginal.slice(0, 200) + " forbidden-stale" + staleOriginal.slice(200),
  );
  verify(
    (await staleResponse).status() === 412,
    "A stale browser tab overwrote a newer structured revision.",
  );
  await staleTab
    .getByRole("button", { name: "Compare saved passage", exact: true })
    .waitFor();
  verify(
    (
      await staleTab
        .locator("[data-run-id]")
        .filter({ hasText: "forbidden-stale" })
        .first()
        .textContent()
    ).includes("forbidden-stale"),
    "The stale-tab draft was lost after rejection.",
  );
  await staleTab
    .getByRole("button", { name: "Compare saved passage", exact: true })
    .click();
  await staleTab
    .getByRole("button", {
      name: "Use saved passage and discard retained draft",
      exact: true,
    })
    .click();
  await staleTab.getByText("Saved", { exact: true }).first().waitFor();
  if (
    await staleTab
      .getByRole("button", { name: "Accessible editor", exact: true })
      .count()
  )
    await staleTab
      .getByRole("button", { name: "Accessible editor", exact: true })
      .click();
  verify(
    (await staleField.inputValue()).includes(marker) &&
      !(await staleField.inputValue()).includes("forbidden-stale"),
    "Explicit stale-draft reconciliation did not preserve the acknowledged newer source.",
  );
  await staleTab.close();
  report.checks.push(
    "concurrent browser tabs reject stale writes with412, retain the conflicting draft and reconcile only after explicit saved-source comparison",
  );
  report.checks.push(
    "300000-word single paragraph loads a bounded passage; exact typing commits sparse receipts and preserves all offscreen text",
  );
  await page.reload();
  await saved();
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  verify(
    (
      await page
        .getByRole("textbox", { name: "Paragraph 1", exact: true })
        .inputValue()
    ).includes(marker),
    "Saved bounded typing did not survive reload.",
  );
  report.checks.push("edit-save-reload preserves the exact committed passage");
  await page
    .getByRole("combobox", { name: "Manuscript editing scope", exact: true })
    .selectOption("book");
  await page
    .locator("[data-bounded-scene]")
    .nth(1)
    .getByText("Saved", { exact: true })
    .waitFor();
  const select = page.getByRole("listbox", {
    name: "Whole blocks to transfer",
  });
  await select.waitFor();
  const selectedId = await select
    .locator("option")
    .first()
    .getAttribute("value");
  await select.selectOption([selectedId]);
  const moveResponse = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passage-transfers"),
  );
  await page
    .getByRole("button", {
      name: "Move whole selected blocks atomically",
      exact: true,
    })
    .click();
  const moved = await moveResponse;
  verify(moved.ok(), "Atomic whole paragraph transfer failed.");
  const moveReceipt = (await moved.json()).data;
  verify(
    moveReceipt.result.passages.length === 2 && !("scenes" in moveReceipt),
    "Scope transfer acknowledgement transported full scene bodies.",
  );
  await page
    .getByRole("button", { name: "Undo last scene transfer", exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Undo last scene transfer",
    );
    return button && !button.disabled;
  });
  const restoreResponse = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passage-scope-restores"),
  );
  await page
    .getByRole("button", { name: "Undo last scene transfer", exact: true })
    .click();
  const restored = await restoreResponse;
  verify(restored.ok(), "Atomic complete scope restoration failed.");
  verify(
    (await call(`/api/books/${bookId}/scenes/${first.sceneId}`)).scene.prose ===
      projected.prose,
    "Scoped undo did not restore the complete giant body.",
  );
  verify(
    (await call(`/api/books/${bookId}/scenes/${second.sceneId}`)).scene
      .prose === "Destination paragraph retains its own text.",
    "Scoped undo changed the destination original.",
  );
  report.checks.push(
    "whole giant paragraph transfer and complete two-scene undo use only sparse identities and immutable revision references",
  );
  await page
    .getByRole("button", { name: "Load source scene end", exact: true })
    .click();
  await page
    .locator("[data-bounded-scene]")
    .first()
    .getByText("Saved", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Load destination beginning", exact: true })
    .click();
  await page
    .locator("[data-bounded-scene]")
    .nth(1)
    .getByText("Saved", { exact: true })
    .waitFor();
  const preview = page.getByRole("region", {
    name: "Adjacent saved scene excerpts",
    exact: true,
  });
  await preview.evaluate((element) => {
    const scenes = element.querySelectorAll("[data-scene-id]"),
      first = scenes[0].querySelectorAll("[data-run-id]"),
      last = scenes[1].querySelector("[data-run-id]");
    const source = first[first.length - 1].firstChild,
      destination = last.firstChild;
    const range = document.createRange();
    range.setStart(source, source.textContent.length - 4);
    range.setEnd(destination, 11);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page
    .getByText("2 qualified styled ranges selected.", { exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Paste two scene parts", exact: true })
    .evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "left-piece\n---scene---\nright-piece");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  verify(
    (await page
      .getByRole("textbox", { name: "Source scene paste part", exact: true })
      .inputValue()) === "left-piece",
    "First clipboard part did not retain its scene scope.",
  );
  verify(
    (await page
      .getByRole("textbox", {
        name: "Destination scene paste part",
        exact: true,
      })
      .inputValue()) === "right-piece",
    "Second clipboard part did not retain its scene scope.",
  );
  await page
    .getByLabel("Track multipart text for review", { exact: true })
    .check();
  const pasteResponse = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passage-commits"),
  );
  await page
    .getByRole("button", {
      name: "Apply multipart text atomically",
      exact: true,
    })
    .click();
  const pasted = await pasteResponse;
  verify(
    pasted.ok(),
    "Tracked multipart paste failed its atomic compound commit.",
  );
  const pasteReceipt = (await pasted.json()).data;
  verify(
    pasteReceipt.result.passages.length === 2 &&
      pasteReceipt.result.passages.every((value) =>
        value.passage.changeSummaries.some(
          (change) => change.status === "pending",
        ),
      ),
    "Multipart paste lost its pending authenticated tracked changes.",
  );
  const firstFinal = (
      await call(`/api/books/${bookId}/scenes/${first.sceneId}`)
    ).scene.prose,
    secondFinal = (await call(`/api/books/${bookId}/scenes/${second.sceneId}`))
      .scene.prose;
  verify(
    firstFinal === projected.prose.slice(0, -4) + "left-piece",
    "Multipart paste changed offscreen source text.",
  );
  verify(
    secondFinal === "right-piece paragraph retains its own text.",
    "Multipart paste changed the destination outside its exact range.",
  );
  const sourceOriginal = await call(
    `/api/books/${bookId}/scenes/${first.sceneId}/document-passages?projection=original&edge=last&maxCharacters=8000&maxParagraphs=24&maxRuns=256`,
  );
  const destinationOriginal = await call(
    `/api/books/${bookId}/scenes/${second.sceneId}/document-passages?projection=original&maxCharacters=8000&maxParagraphs=24&maxRuns=256`,
  );
  verify(
    sourceOriginal.paragraphs[0].paragraph.runs
      .map((run) => run.text)
      .join("")
      .endsWith("word") &&
      !sourceOriginal.paragraphs[0].paragraph.runs.some((run) =>
        run.text.includes("left-piece"),
      ),
    "Original source view did not reverse multipart insertion/deletion.",
  );
  verify(
    destinationOriginal.paragraphs[0].paragraph.runs
      .map((run) => run.text)
      .join("") === "Destination paragraph retains its own text.",
    "Original destination view did not reverse multipart insertion/deletion.",
  );
  const undoPaste = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passage-scope-restores"),
  );
  await page
    .getByRole("button", { name: "Undo last scene transfer", exact: true })
    .click();
  verify(
    (await undoPaste).ok(),
    "Scoped undo of tracked multipart paste failed.",
  );
  verify(
    (await call(`/api/books/${bookId}/scenes/${first.sceneId}`)).scene.prose ===
      projected.prose,
    "Multipart scoped undo failed to restore the full source scene.",
  );
  verify(
    (await call(`/api/books/${bookId}/scenes/${second.sceneId}`)).scene
      .prose === "Destination paragraph retains its own text.",
    "Multipart scoped undo failed to restore the full destination scene.",
  );
  report.checks.push(
    "stable DOM adjacent selection, two-part clipboard paste, authenticated tracked changes, original projections and complete compound undo preserve both scene identities",
  );
  await page
    .getByRole("region", { name: "Scene 1 document", exact: true })
    .scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1440, height: 1600 });
  const paper = page
    .locator("[data-bounded-scene]")
    .first()
    .locator('canvas[data-index="0"]')
    .first();
  await paper.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const paper = document.querySelector(
        '[data-bounded-scene] canvas[data-index="0"]',
      );
      if (!paper) return false;
      const context = paper.getContext("2d");
      if (!context) return false;
      const image = context.getImageData(0, 0, paper.width, paper.height).data;
      let ink = 0;
      for (let i = 0; i < image.length; i += 4)
        if (
          image[i + 3] > 0 &&
          image[i] < 190 &&
          image[i + 1] < 190 &&
          image[i + 2] < 190
        )
          ink++;
      return ink > 100;
    },
    undefined,
    { timeout: 10000 },
  );
  await paper.screenshot({
    path: path.join(output, "bounded-canvas-page.png"),
  });
  report.checks.push(
    "the acknowledged Canvas passage paints text on its working page after complete scoped undo",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("region", { name: "Scene 1 document", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "bounded-workspace.png"),
    fullPage: false,
  });
  verify(
    report.fullSceneUIReads.length === 0,
    "A bounded workspace made a whole-scene document request.",
  );
  verify(
    report.maximumPassageResponseBytes > 0 &&
      report.maximumPassageResponseBytes <= 256 * 1024,
    "Passage responses exceeded the bounded transport.",
  );
  verify(
    errors.length === 0,
    "Authenticated workspace raised browser exceptions: " + errors.join("; "),
  );
  report.checks.push(
    "authenticated desktop editing makes no whole-scene document reads and every passage response stays within 256KiB",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    new URL(`/m/studio?bookId=${bookId}&sceneId=${second.sceneId}`, base).href,
  );
  await page
    .locator("[data-bounded-scene]")
    .getByText("Saved", { exact: true })
    .waitFor();
  verify(
    report.fullSceneUIReads.length === 0,
    "Mobile studio made a whole-scene document request.",
  );
  editing = false;
  await page.goto(
    new URL(`/m/read?bookId=${bookId}&sceneId=${second.sceneId}`, base).href,
  );
  await page
    .getByText("Destination paragraph retains its own text.", { exact: false })
    .first()
    .waitFor();
  report.checks.push(
    "mobile studio and semantic reader routes retain canonical scene identity on the authenticated same-origin proxy",
  );
  // Exercise the real native Canvas selection and input path, rather than only
  // painting Canvas after semantic-mode edits. Selection must never rebuild it.
  editing = true;
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(
    new URL(`/manuscript?bookId=${bookId}&sceneId=${second.sceneId}`, base)
      .href,
  );
  await saved();
  const nativeWorkspace = page.locator(
    `[data-bounded-scene][data-scene-id="${second.sceneId}"]`,
  );
  const nativePaper = nativeWorkspace.locator('canvas[data-index="0"]').first();
  await nativePaper.scrollIntoViewIfNeeded();
  await nativePaper.evaluate((paper) => {
    window.nativeInteractionCanvas = paper;
  });
  await nativePaper.dblclick({ position: { x: 100, y: 90 }, timeout: 5000 });
  await page.waitForFunction(
    (sceneId) => {
      const option = document.querySelector(
        `[data-scene-id="${sceneId}"] select[aria-label="Discussion target"] option[value="selection"]`,
      );
      return option && !option.disabled;
    },
    second.sceneId,
    { timeout: 5000 },
  );
  verify(
    await nativePaper.evaluate(
      (paper) => paper === window.nativeInteractionCanvas,
    ),
    "Selecting native Canvas text destroyed the active editor.",
  );
  const nativeSave = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/document-passages/operations"),
    { timeout: 30000 },
  );
  await page.keyboard.insertText("CanvasNative");
  verify((await nativeSave).ok(), "Native Canvas typing failed to save.");
  await saved();
  verify(
    (await call(`/api/books/${bookId}/scenes/${second.sceneId}`)).scene
      .prose === "CanvasNative paragraph retains its own text.",
    "Native Canvas typing changed text outside its selected word.",
  );
  verify(
    await nativePaper.evaluate(
      (paper) => paper === window.nativeInteractionCanvas,
    ),
    "An unchanged save acknowledgement rebuilt the native Canvas editor.",
  );
  await page.reload();
  await saved();
  const reopenedPaper = page
    .locator(
      `[data-bounded-scene][data-scene-id="${second.sceneId}"] canvas[data-index="0"]`,
    )
    .first();
  await reopenedPaper.scrollIntoViewIfNeeded();
  await reopenedPaper.dblclick({ position: { x: 100, y: 90 }, timeout: 5000 });
  await page.getByRole("button", { name: "Bold", exact: true }).first().click();
  await saved();
  verify(
    report.fullSceneUIReads.length === 0,
    "Native Canvas requested a full scene document.",
  );
  verify(
    errors.length === 0,
    "Native Canvas raised browser exceptions: " + errors.join("; "),
  );
  report.checks.push(
    "real Canvas word selection, native typing, durable acknowledgement, reload and formatting stay responsive and preserve the active editor",
  );
  // Assert saved canonical formatting, not merely successful toolbar clicks.
  const formattedPassage = async () =>
    call(
      `/api/books/${bookId}/scenes/${second.sceneId}/document-passages?maxCharacters=8000&maxParagraphs=24&maxRuns=256`,
    );
  const selectedRuns = (passage) => {
    const runs = passage.paragraphs[0].paragraph.runs.filter((run) =>
      run.text.includes("CanvasNative"),
    );
    verify(runs.length > 0, "The exact formatting target disappeared.");
    return runs;
  };
  const format = async (action) => {
    const acknowledgement = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/document-passages/operations"),
      { timeout: 15000 },
    );
    await action();
    verify(
      (await acknowledgement).ok(),
      "Formatting failed its structured commit.",
    );
    await saved();
    return formattedPassage();
  };
  verify(
    selectedRuns(await formattedPassage()).every((run) => run.style.bold),
    "Bold was not saved on the selected word.",
  );
  for (const [name, property] of [
    ["Italic", "italic"],
    ["Underline", "underline"],
    ["Strikeout", "strikeout"],
  ]) {
    const passage = await format(() =>
      page.getByRole("button", { name, exact: true }).click(),
    );
    verify(
      selectedRuns(passage).every((run) => run.style[property]),
      `${name} was not saved on the selected word.`,
    );
  }
  let passage = await format(() =>
    page
      .getByRole("combobox", { name: "Font", exact: true })
      .selectOption("Liberation Serif"),
  );
  verify(
    selectedRuns(passage).every((run) => run.style.font === "Liberation Serif"),
    "Font did not preserve the selected target.",
  );
  const size = page.getByRole("spinbutton", { name: "Font size", exact: true });
  const revisionBeforeSize = (await formattedPassage()).sceneRevisionId;
  await size.fill("1");
  await page.waitForTimeout(900);
  verify(
    (await formattedPassage()).sceneRevisionId === revisionBeforeSize,
    "An intermediate font size committed while typing.",
  );
  passage = await format(async () => {
    await size.fill("18");
    await size.press("Enter");
  });
  verify(
    selectedRuns(passage).every((run) => run.style.size === 18),
    "Font size was not saved.",
  );
  passage = await format(async () => {
    await size.fill("96");
    await size.press("Enter");
  });
  verify(
    selectedRuns(passage).every((run) => run.style.size === 96),
    "Canvas silently rejected a supported size above 72px.",
  );
  await format(async () => {
    await size.fill("16");
    await size.press("Enter");
  });
  for (const [option, property, value] of [
    ["heading-1", "heading", 1],
    ["bullet", "list", "bullet"],
    ["number", "list", "number"],
  ]) {
    passage = await format(() =>
      page
        .getByRole("combobox", { name: "Paragraph style", exact: true })
        .selectOption(option),
    );
    verify(
      passage.paragraphs[0].paragraph.style[property] === value,
      `Paragraph style ${option} did not apply to the whole paragraph.`,
    );
    verify(
      !(await page
        .getByRole("button", { name: "Bold", exact: true })
        .isDisabled()),
      "Heading/list selection disabled formatting.",
    );
  }
  await format(() =>
    page
      .getByRole("combobox", { name: "Paragraph style", exact: true })
      .selectOption("body"),
  );
  passage = await format(() =>
    page.getByRole("button", { name: "Align center", exact: true }).click(),
  );
  verify(
    passage.paragraphs[0].paragraph.style.alignment === "center",
    "Paragraph alignment was not saved.",
  );
  await format(() =>
    page.getByRole("button", { name: "Align left", exact: true }).click(),
  );
  passage = await format(() =>
    page.getByLabel("Text color", { exact: true }).fill("#8b321c"),
  );
  verify(
    selectedRuns(passage).every((run) => run.style.color === "#8b321c"),
    "Text color was not saved.",
  );
  passage = await format(() =>
    page.getByLabel("Highlight color", { exact: true }).fill("#ffe88b"),
  );
  verify(
    selectedRuns(passage).every((run) => run.style.highlight === "#ffe88b"),
    "Highlight was not saved.",
  );
  await page.getByLabel("More formatting", { exact: true }).click();
  passage = await format(() =>
    page.getByRole("button", { name: "Clear highlight", exact: true }).click(),
  );
  verify(
    selectedRuns(passage).every((run) => !run.style.highlight),
    "Clear highlight did not persist.",
  );
  passage = await format(() =>
    page.getByRole("button", { name: "Highlight", exact: true }).click(),
  );
  verify(
    selectedRuns(passage).every((run) => run.style.highlight === "#ffff00"),
    "Default yellow highlight did not apply directly.",
  );
  passage = await format(() =>
    page.getByRole("button", { name: "Highlight", exact: true }).click(),
  );
  verify(
    selectedRuns(passage).every((run) => !run.style.highlight),
    "Highlight toggle did not clear its saved color.",
  );
  passage = await format(async () => {
    const field = page.getByRole("spinbutton", {
      name: "Space after",
      exact: true,
    });
    await field.fill("12");
    await field.press("Enter");
  });
  verify(
    passage.paragraphs[0].paragraph.style.after === 12,
    "Paragraph spacing did not persist.",
  );
  passage = await format(() =>
    page
      .getByRole("combobox", { name: "Paragraph line spacing", exact: true })
      .selectOption("1.5"),
  );
  verify(
    passage.paragraphs[0].paragraph.style.lineSpacing === 1.5,
    "Line spacing did not persist.",
  );
  await page.getByLabel("More formatting", { exact: true }).click();
  verify(
    (await call(`/api/books/${bookId}/scenes/${second.sceneId}`)).scene
      .prose === "CanvasNative paragraph retains its own text.",
    "Formatting changed manuscript text.",
  );
  await page.reload();
  await saved();
  passage = await formattedPassage();
  verify(
    selectedRuns(passage).every(
      (run) =>
        run.style.italic &&
        run.style.underline &&
        run.style.strikeout &&
        run.style.font === "Liberation Serif" &&
        run.style.size === 16,
    ),
    "Saved formatting did not survive reopening.",
  );
  report.checks.push(
    "native toolbar emphasis, font, validated 18/96px size, heading/list selection, alignment, color/highlight and paragraph spacing persist exact canonical targets without changing text",
  );
  await page.getByRole("button", { name: "Review panel", exact: true }).click();
  await page.getByRole("tab", { name: "Discuss", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  verify(
    await page
      .getByRole("tab", { name: "Review", exact: true })
      .evaluate(
        (tab) =>
          tab === document.activeElement &&
          tab.getAttribute("aria-selected") === "true",
      ),
    "Review tabs do not support keyboard navigation.",
  );
  await page
    .getByRole("button", { name: "Close review panel", exact: true })
    .click();
  await page.screenshot({
    path: path.join(output, "professional-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rail = document.querySelector("aside"),
      book = document.querySelector(".proser-book-select");
    return (
      rail &&
      book &&
      rail.getBoundingClientRect().width === 64 &&
      book.getBoundingClientRect().left >= rail.getBoundingClientRect().right
    );
  });
  verify(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Manuscript controls overflow the phone viewport.",
  );
  verify(
    await page
      .locator(
        ".proser-editor-toolbar input,.proser-editor-toolbar select,.proser-editor-toolbar button",
      )
      .evaluateAll((controls) =>
        controls
          .filter((control) => control.checkVisibility())
          .every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          }),
      ),
    "A formatting control is clipped on the phone viewport.",
  );
  await page.getByRole("button", { name: "Review panel", exact: true }).click();
  await page.screenshot({
    path: path.join(output, "professional-phone-review.png"),
  });
  await page
    .getByRole("button", { name: "Close review panel", exact: true })
    .click();
  report.checks.push(
    "professional workspace preserves keyboard tab navigation, closable phone review drawer and no phone-width page overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await saved();
  const tablePaper = page.locator('canvas[data-index="0"]').first();
  await tablePaper.scrollIntoViewIfNeeded();
  await tablePaper.dblclick({ position: { x: 100, y: 90 } });
  await page.keyboard.press("ArrowRight");
  await page.getByLabel("More formatting", { exact: true }).click();
  const tableReceipt = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/document-passages/operations"),
  );
  await page.getByRole("button", { name: "Insert table", exact: true }).click();
  verify((await tableReceipt).ok(), "Table insertion did not save.");
  await saved();
  const tableDocument = await call(
    `/api/books/${bookId}/scenes/${second.sceneId}/document`,
  );
  const insertedTable = tableDocument.document.blocks.find(
    (block) => block.type === "table",
  );
  verify(
    insertedTable?.rows.length === 2 &&
      insertedTable.rows.every((row) => row.cells.length === 2),
    "Inserted table is not a saved 2 by 2 canonical table.",
  );
  report.checks.push(
    "native table insertion creates a genuine saved two-by-two canonical table",
  );
  await testR2AuthenticatedWorkspace({
    page,
    context,
    call,
    bookId,
    sceneId: second.sceneId,
    base,
    report,
    setReading: (reading) => {
      editing = !reading;
    },
  });
  editing = true;
  await testR2QuickDraft({ page, context, call, base, report, output });
  await testR2BookCatalog({ page, context, call, base, report, output });
  await testManuscriptNavigation({ page, base, call, report, verify, output });
  verify(
    report.fullSceneUIReads.length === 0,
    "Authenticated editing helpers made whole-scene document reads: " +
      report.fullSceneUIReads.join(", "),
  );
  verify(
    errors.length === 0,
    "Authenticated workspace raised browser exceptions: " + errors.join("; "),
  );
  report.passed = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  report.passed = false;
  report.failureStack = error instanceof Error ? error.stack : undefined;
  for (const [index, current] of context.pages().entries())
    await current
      .screenshot({ path: path.join(output, `failure-${index}.png`) })
      .catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (bookId && call) {
    try {
      const head = await call(`/api/books/${bookId}/document-manifest`);
      await call(
        `/api/books/${bookId}`,
        {
          documentPreconditions: {
            operationId: randomUUID(),
            expectedRevisionId: head.revisionId,
            expectedScopes: { structure: head.scopes.structure.revisionId },
          },
        },
        "DELETE",
      );
      report.disposableBookDeleted = true;
    } catch (error) {
      report.failures.push(
        "Disposable cleanup: " +
          (error instanceof Error ? error.message : String(error)),
      );
      report.passed = false;
      process.exitCode = 1;
    }
  }
  await context.close();
  await browser.close();
  await writeFile(
    path.join(output, "evidence.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(report) + "\n");
}
