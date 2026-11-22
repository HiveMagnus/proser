/** Finite production canary over a pre-admitted disposable identity/book.
 * Never changes IAM, creates books, dispatches inference or deletes history. */
import { createRequire } from "node:module";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const sessionFile = process.env.PROSER_CANARY_SESSION_FILE;
const grantFile = process.env.PROSER_CANARY_GRANT_FILE;
const output = process.env.PROSER_CANARY_EVIDENCE_FILE;
for (const filename of [
  sessionFile,
  grantFile,
  output && path.dirname(output),
]) {
  if (!filename || !path.isAbsolute(filename))
    throw new Error("Explicit private absolute canary paths required.");
  const info = await lstat(filename);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077
  )
    throw new Error(
      "Canary inputs/output directory must be private and operator-owned.",
    );
}
const session = JSON.parse(await readFile(sessionFile, "utf8"));
const grant = JSON.parse(await readFile(grantFile, "utf8"));
if (
  session.kind !== "disposable-signed-author-session" ||
  !/^release-canary-[a-f0-9-]{36}$/.test(session.identity) ||
  !Number.isSafeInteger(grant.bookId) ||
  grant.bookId < 1 ||
  !Number.isSafeInteger(grant.userId) ||
  session.factoryIdentity !== `release-fixture:${session.identity}` ||
  grant.fixtureIdentity !== session.factoryIdentity
)
  throw new Error(
    "Only the explicitly admitted disposable release fixture may be tested.",
  );
const base = new URL(session.cookie.url);
const fixtureOrigin = process.env.PROSER_CANARY_FIXTURE_ORIGIN;
const isolated = Boolean(fixtureOrigin);
if (isolated) {
  const selected = new URL(fixtureOrigin);
  if (
    !["localhost", "127.0.0.1"].includes(selected.hostname) ||
    !["http:", "https:"].includes(selected.protocol) ||
    selected.origin !== fixtureOrigin ||
    selected.origin !== base.origin ||
    !selected.port ||
    Number(selected.port) < 1024
  )
    throw new Error(
      "An isolated driver override must exactly match the signer-selected loopback origin and nonprivileged port.",
    );
} else if (
  base.protocol !== "https:" ||
  base.origin !== process.env.PROSER_AUTHOR_ORIGIN
)
  throw new Error("Exact production Author origin required.");
const report = {
  schemaVersion: 1,
  kind: isolated
    ? "authenticated-isolated-document-workspace"
    : "authenticated-deployed-document-workspace",
  origin: base.origin,
  startedAt: new Date().toISOString(),
  bookId: grant.bookId,
  userId: grant.userId,
  identity: session.identity,
  iamPasswordLogin: "unverified",
  R2: "deferred",
  R6: "deferred",
  checks: [],
  operationIds: [],
  interruptedSaveDispatches: [],
  fullSceneWritingReads: [],
  failures: [],
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const cookie = { ...session.cookie };
delete cookie.expires;
await context.addCookies([cookie]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let writing = true;
context.on("request", (request) => {
  if (
    writing &&
    request.method() === "GET" &&
    /\/scenes\/\d+\/document$/.test(new URL(request.url()).pathname)
  )
    report.fullSceneWritingReads.push(new URL(request.url()).pathname);
});
const verify = (condition, message) => {
  if (!condition) throw new Error(message);
};
let call;
const saved = async () => {
  await page
    .getByText("Saved", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
};
try {
  await page.goto(new URL("/api/auth/session", base).href);
  const actualSession = await (
    await page.request.get(new URL("/api/auth/session", base).href)
  ).json();
  verify(
    actualSession.user?.id === session.identity,
    "Installed Author did not authenticate the standard disposable fixture session.",
  );
  call = async (
    route,
    data,
    method = data === undefined ? "GET" : "POST",
    expected = 200,
  ) => {
    const response = await page.request.fetch(new URL(route, base).href, {
      method,
      data,
      timeout: 120000,
      headers: {
        "x-proser-expected-user": encodeURIComponent(actualSession.user.id),
      },
    });
    const body = await response.json();
    verify(
      response.status() === expected && (expected >= 400 || body.success),
      `${method} ${route}: ${response.status()} ${body.error?.code ?? ""}`,
    );
    return body.data;
  };
  const root = `/api/books/${grant.bookId}`;
  const capabilities = await call("/api/books/document-capabilities");
  verify(
    capabilities.enabled &&
      capabilities.actorId === grant.userId &&
      capabilities.passageOperations === "typed-operations-v1",
    "Proxy identity/capability mismatch.",
  );
  const manifest = await call(root + "/document-manifest");
  const scene = manifest.scenes.find((item) => !item.deletedAt);
  verify(scene, "Pre-admitted fixture has no scene.");
  report.sceneId = scene.sceneId;
  const route = `/manuscript?bookId=${grant.bookId}&sceneId=${scene.sceneId}`;
  await page.goto(new URL(route, base).href);
  await saved();
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  let field = page.getByRole("textbox", { name: "Paragraph 1", exact: true });
  const initial = await field.inputValue();
  const marker = ` Browser ${randomUUID()} 😀`;
  const originalSource = await call(
    root +
      `/scenes/${scene.sceneId}/document-passages?maxCharacters=8000&maxParagraphs=24&maxRuns=256`,
  );
  const stalePage = await context.newPage();
  await stalePage.goto(new URL(route, base).href);
  await stalePage
    .getByText("Saved", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await stalePage
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const staleField = stalePage.getByRole("textbox", {
    name: "Paragraph 1",
    exact: true,
  });
  const staleText = await staleField.inputValue();
  stalePage.on("pageerror", (error) => errors.push(error.message));
  const saveResponse = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passages/operations"),
  );
  await field.fill(initial + marker);
  const firstSave = await saveResponse;
  verify(firstSave.ok(), "Production bounded save failed.");
  const firstReceipt = (await firstSave.json()).data;
  report.operationIds.push(firstReceipt.operationId);
  verify(
    !("scenes" in firstReceipt),
    "Production save exposed complete scenes.",
  );
  await saved();
  const recovered = await call(
    root + `/document-operations/${firstReceipt.operationId}`,
  );
  verify(
    recovered.revisionId === firstReceipt.revisionId,
    "Exact saved operation recovery changed its committed revision.",
  );
  const staleResponse = stalePage.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/document-passages/operations"),
  );
  await staleField.fill(staleText + " STALE");
  verify(
    (await staleResponse).status() === 412,
    "Stale production tab overwrote the new revision.",
  );
  await stalePage
    .getByRole("button", { name: "Compare saved passage", exact: true })
    .click();
  await stalePage
    .getByRole("button", {
      name: "Use saved passage and discard retained draft",
      exact: true,
    })
    .click();
  await stalePage.getByText("Saved", { exact: true }).first().waitFor();
  await stalePage.close();
  report.checks.push(
    "standard encrypted session authenticates the exact fixture through the installed same-origin proxy",
    "bounded edit durable receipt and exact recovery",
    "concurrent authenticated tabs reject stale writes with412 and explicit draft reconciliation",
  );
  await page.reload();
  await saved();
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  field = page.getByRole("textbox", { name: "Paragraph 1", exact: true });
  verify(
    (await field.inputValue()) === initial + marker,
    "Save/reload changed the intended text.",
  );
  report.checks.push("saved Unicode text reopens exactly");
  let dropped = false;
  const droppedIds = [];
  await page.route("**/document-passages/operations", async (intercepted) => {
    report.interruptedSaveDispatches.push(
      intercepted.request().postDataJSON().operationId,
    );
    if (dropped) {
      await intercepted.continue();
      return;
    }
    dropped = true;
    const request = intercepted.request().postDataJSON();
    droppedIds.push(request.operationId);
    const durable = await intercepted.fetch();
    verify(durable.ok(), "Interrupted save was not committed at Factory.");
    await intercepted.abort("failed");
  });
  await field.fill(initial + marker + " Lost-ACK");
  await page
    .getByRole("button", { name: "Check original receipt", exact: true })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Check original receipt", exact: true })
    .click();
  await saved();
  await page.unroute("**/document-passages/operations");
  const lost = await call(root + `/document-operations/${droppedIds[0]}`);
  verify(
    lost.status === "completed",
    "Lost acknowledgement did not recover its completed original operation.",
  );
  verify(
    report.interruptedSaveDispatches.length === 1 &&
      report.interruptedSaveDispatches[0] === droppedIds[0],
    "Receipt recovery repeated an interrupted document mutation.",
  );
  verify(
    lost.operationId === droppedIds[0],
    "Recovery returned a different operation UUID.",
  );
  report.operationIds.push(droppedIds[0]);
  report.checks.push(
    "lost save acknowledgement recovers the original durable operation without duplicate dispatch",
  );
  await page.reload();
  await saved();
  await page.setViewportSize({ width: 1440, height: 1600 });
  const canvas = page.locator('canvas[data-index="0"]').first();
  await canvas.waitFor();
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas[data-index="0"]');
      if (!canvas) return false;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let offset = 0; offset < pixels.length; offset += 4)
        if (
          pixels[offset + 3] > 0 &&
          pixels[offset] < 190 &&
          pixels[offset + 1] < 190 &&
          pixels[offset + 2] < 190
        )
          ink++;
      return ink > 100;
    },
    undefined,
    { timeout: 10000 },
  );
  await canvas.screenshot({
    path: path.join(path.dirname(output), "production-canvas-page.png"),
  });
  report.checks.push("actual Canvas page renders after recovery");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    new URL(`/m/studio?bookId=${grant.bookId}&sceneId=${scene.sceneId}`, base)
      .href,
  );
  await saved();
  report.checks.push(
    "preserved /m/studio mounts the acknowledged bounded document",
  );
  writing = false;
  await page.goto(
    new URL(`/m/read?bookId=${grant.bookId}&sceneId=${scene.sceneId}`, base)
      .href,
  );
  await page
    .getByText("Lost-ACK", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  report.checks.push(
    "preserved /m/read displays saved revision content without mutation",
  );
  verify(
    report.fullSceneWritingReads.length === 0,
    "Writing UI loaded a complete scene document.",
  );
  verify(errors.length === 0, `Browser exceptions: ${errors.join("; ")}`);
  report.sourceBookRevisionId = originalSource.bookRevisionId;
  report.finalManifestRevisionId = (
    await call(root + "/document-manifest")
  ).revisionId;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failures.push(error instanceof Error ? error.message : String(error));
  report.failureStack = error instanceof Error ? error.stack : undefined;
  for (const [index, current] of context.pages().entries())
    await current
      .screenshot({
        path: path.join(path.dirname(output), `failure-${index}.png`),
      })
      .catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  await browser.close();
}
process.stdout.write(
  JSON.stringify({
    passed: report.passed,
    checks: report.checks.length,
    failures: report.failures,
    evidence: output,
  }) + "\n",
);
