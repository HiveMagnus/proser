import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import path from "node:path";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const base = process.env.PROSER_RELEASE_SMOKE_BASE_URL;
const output = process.env.PROSER_RELEASE_SMOKE_OUTPUT;
const live = process.env.PROSER_PLOT_LIVE === "true";
if (
  !base ||
  !output ||
  (live
    ? !process.env.PROSER_AUTHOR_ORIGIN ||
      new URL(base).protocol !== "https:" ||
      new URL(base).origin !== process.env.PROSER_AUTHOR_ORIGIN
    : new URL(base).hostname !== "localhost")
)
  throw new Error(
    "Explicit isolated or canonical live canary origin and private output required.",
  );
if (
  !process.env.PROSER_CANARY_SESSION_FILE &&
  (!process.env.PLAYWRIGHT_IAM_USERNAME || !process.env.PLAYWRIGHT_IAM_PASSWORD)
)
  throw new Error("Explicit browser credentials required.");
await mkdir(output, { recursive: true, mode: 0o700 });
const report = {
  scope: live
    ? "Production Chromium through authenticated proxy; real configured inference"
    : "Isolated Chromium through authenticated proxy; explicitly seeded inference",
  checks: [],
  errors: [],
  receipts: {},
  bookIds: [],
};
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  report.checks.push(message);
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
let call,
  bookId,
  reviewPosts = 0,
  proposalPosts = 0,
  threadId;
const question = "Will the apprentice discover who betrayed her?";
try {
  if (process.env.PROSER_CANARY_SESSION_FILE) {
    if (!live)
      throw new Error(
        "Signed session is reserved for an explicit live canary.",
      );
    const file = process.env.PROSER_CANARY_SESSION_FILE,
      info = await lstat(file);
    if (
      !path.isAbsolute(file) ||
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077
    )
      throw new Error("Canary session must be an owner-only regular file.");
    const fixture = JSON.parse(await readFile(file, "utf8"));
    if (
      fixture.kind !== "disposable-signed-author-session" ||
      !/^release-canary-[a-f0-9-]{36}$/.test(fixture.identity) ||
      fixture.cookie.url !== base ||
      fixture.cookie.expires <= Date.now() / 1000
    )
      throw new Error(
        "A fresh canonical disposable author session is required.",
      );
    await context.addCookies([fixture.cookie]);
    report.iamPasswordLogin = "unverified: disposable signed author session";
    await page.goto(base + "/api/auth/session");
  } else {
    await page.goto(base + "/auth/signin");
    await page.getByLabel("Username").fill(process.env.PLAYWRIGHT_IAM_USERNAME);
    await page.getByLabel("Password").fill(process.env.PLAYWRIGHT_IAM_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {
      timeout: 60000,
    });
    report.iamPasswordLogin = live ? "passed" : "isolated local credentials";
  }
  const session = await (
    await page.request.get(base + "/api/auth/session")
  ).json();
  call = async (route, data, method = data === undefined ? "GET" : "POST") => {
    const response = await page.request.fetch(base + route, {
      method,
      data,
      headers: {
        "x-proser-expected-user": encodeURIComponent(session.user.id),
      },
      timeout: 160000,
    });
    const body = await response.json();
    if (!response.ok() || !body.success)
      throw new Error(
        `${route}: ${body.error?.code ?? response.status()} ${body.error?.message ?? ""}`,
      );
    return body.data;
  };
  bookId = (
    await call("/api/books", {
      title: "Disposable Plot Threads browser " + randomUUID(),
      operationId: randomUUID(),
    })
  ).id;
  report.bookIds.push(bookId);
  const preconditions = async () => {
    const manifest = await call(`/api/books/${bookId}/document-manifest`);
    return {
      operationId: randomUUID(),
      expectedRevisionId: manifest.revisionId,
      expectedScopes: { structure: manifest.scopes.structure.revisionId },
    };
  };
  const { act } = await call(`/api/books/${bookId}/acts`, {
    title: "Apprentice arc",
    documentPreconditions: await preconditions(),
  });
  const scenes = [];
  const prose = [
    "The apprentice found a broken red seal beside the stolen ledger. Only her mentor used red wax. His son had vanished into the debtors’ cells, and the apprentice had promised to bring him home. She kept the broken seal. 😀",
    "Her mentor denied writing the letter, but red wax clung to his sleeve. When she asked about his son, he stared at the locked prison gate. The ledger buyer offered her gold to stop asking questions. She refused and followed the wax trail.",
    "The mentor confessed that he had betrayed her to save his son. He handed her the missing ledger and surrendered his key to the buyer’s vault. She opened the ledger, found the prison payment beside his name, and understood why he had chosen her trust as the price.",
  ];
  for (const [index, text] of prose.entries()) {
    const { chapter } = await call(
      `/api/books/${bookId}/acts/${act.id}/chapters`,
      {
        title: ["The seal", "The sleeve", "The confession"][index],
        documentPreconditions: await preconditions(),
      },
    );
    await call(`/api/books/${bookId}/chapters/${chapter.id}/scenes/batch`, {
      scenes: [{ prose: text }],
      documentPreconditions: await preconditions(),
    });
  }
  const initialManifest = await call(`/api/books/${bookId}/document-manifest`);
  scenes.push(...initialManifest.scenes.map((scene) => scene.sceneId));
  await page.goto(`${base}/plot?bookId=${bookId}&tab=threads`);
  await page.getByRole("button", { name: "New Thread", exact: true }).click();
  await page.getByLabel("Story question", { exact: true }).fill(question);
  let createPosts = 0;
  await context.route("**/plot-threads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createPosts++;
    report.receipts.createOperationId = route
      .request()
      .postDataJSON().operationId;
    const response = await route.fetch();
    check(
      response.ok(),
      "Thread creation committed before simulated lost acknowledgment",
    );
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: { message: "Simulated lost creation acknowledgment" },
      }),
    });
  });
  await page
    .getByRole("button", { name: "Create thread", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Recover original request", exact: true })
    .click();
  await page
    .getByRole("article", { name: "Plot thread detail", exact: true })
    .waitFor();
  check(
    await page.getByText("No setup linked.", { exact: true }).isVisible(),
    "New question visibly identifies missing linked setup",
  );
  const list = await call(`/api/books/${bookId}/plot-threads`);
  check(
    list.threads.length === 1 &&
      createPosts === 1 &&
      (await page.getByRole("form", { name: "Create plot thread" }).count()) ===
        0,
    "Lost creation acknowledgment restores the original thread without leaving a duplicate creation form",
  );
  await context.unroute("**/plot-threads");
  threadId = list.threads[0].id;
  report.receipts.threadId = threadId;
  let evidencePosts = 0;
  await context.route("**/plot-threads/*/evidence", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    evidencePosts++;
    report.receipts.evidenceOperationId = route
      .request()
      .postDataJSON().operationId;
    const response = await route.fetch();
    check(
      response.ok(),
      "Evidence attachment committed before simulated lost acknowledgment",
    );
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: { message: "Simulated lost evidence acknowledgment" },
      }),
    });
  });
  for (const [index, stage] of ["setup", "escalation", "payoff"].entries()) {
    await page
      .getByRole("button", { name: `Link ${stage}`, exact: true })
      .click();
    const picker = page.getByRole("region", {
      name: `Link ${stage} excerpt`,
      exact: true,
    });
    await picker
      .getByLabel("Scene", { exact: true })
      .selectOption(String(scenes[index]));
    await picker
      .getByRole("button", { name: "Use paragraph 1", exact: true })
      .click();
    await picker
      .getByRole("button", { name: "Save linked excerpt", exact: true })
      .click();
    if (index === 0) {
      await page
        .getByRole("button", { name: "Recover original request", exact: true })
        .click();
      await context.unroute("**/plot-threads/*/evidence");
      check(
        evidencePosts === 1,
        "Lost attachment acknowledgment recovers the original evidence without a duplicate link",
      );
    }
    await picker.waitFor({ state: "detached" });
    await page
      .getByRole("article", { name: "Plot thread detail", exact: true })
      .waitFor();
  }
  const linked = await call(`/api/books/${bookId}/plot-threads/${threadId}`);
  check(
    linked.evidence.length === 3 &&
      linked.evidence.every((e, i) => e.source.text === prose[i]),
    "All three stages retain literal saved scene excerpts",
  );
  check(
    linked.checks.length === 0,
    "Stage coverage and narrative order checks clear after linking the three scenes",
  );
  await context.route("**/plot-threads/*/reviews", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    reviewPosts++;
    report.receipts.reviewOperationId = route
      .request()
      .postDataJSON().operationId;
    const response = await route.fetch({ timeout: 160000 });
    check(
      response.ok(),
      "Review provider response completed before simulated lost acknowledgment",
    );
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: { message: "Simulated lost review acknowledgment" },
      }),
    });
  });
  await page
    .getByRole("button", { name: "Review payoff", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Recover original request", exact: true })
    .waitFor({ timeout: 160000 });
  await page
    .getByRole("button", { name: "Recover original request", exact: true })
    .click();
  const reviewed = await call(`/api/books/${bookId}/plot-threads/${threadId}`);
  report.provider = reviewed.reviews[0].result?.provenance;
  if (reviewed.reviews[0].status !== "ready")
    throw new Error(
      `Original review ended ${reviewed.reviews[0].status}: ${reviewed.reviews[0].errorCode}. Its result is retained; no redispatch.`,
    );
  check(
    reviewed.reviews[0].status === "ready" && reviewPosts === 1,
    "Lost review acknowledgment recovers the saved critique without another inference call",
  );
  await page.getByText(/AI assessment:/).waitFor({ timeout: 30000 });
  check(
    (await call(`/api/books/${bookId}/document-manifest`)).revisionId ===
      initialManifest.revisionId,
    "Thread authoring and payoff review leave canonical manuscript unchanged",
  );
  await page
    .getByLabel("Your assessment", { exact: true })
    .selectOption("weak");
  await page
    .getByLabel("Review notes", { exact: true })
    .fill("Make the red wax connect to the confession more clearly.");
  await page
    .getByRole("button", { name: "Save my assessment", exact: true })
    .click();
  await page
    .getByText("Saved author assessment: weak", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Offer a small revision", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Prepare cited passage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Request small revision", exact: true })
    .waitFor();
  await context.route("**/document-discussions/*/proposals", async (route) => {
    if (route.request().method() === "POST") proposalPosts++;
    return route.continue();
  });
  await page
    .getByRole("button", { name: "Request small revision", exact: true })
    .click();
  await page
    .getByText("Saved proposal: ready", { exact: true })
    .waitFor({ timeout: 160000 });
  check(
    (await page.locator("del").count()) > 0 &&
      (await page.locator("ins").count()) > 0,
    "Cited revision displays exact before and after text before approval",
  );
  await page.screenshot({
    path: path.join(output, "desktop-before-after.png"),
    fullPage: true,
  });
  await context.route("**/document-proposals/*/apply", async (route) => {
    report.receipts.applyOperationId = route
      .request()
      .postDataJSON().operationId;
    const response = await route.fetch({ timeout: 30000 });
    check(
      response.ok(),
      "Tracked application committed before simulated lost acknowledgment",
    );
    await route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: { message: "Simulated lost application acknowledgment" },
      }),
    });
  });
  await page
    .getByRole("button", {
      name: "Revalidate and apply selected edits",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Recover original request", exact: true })
    .click();
  await page.getByText(/This saved review uses earlier thread/).waitFor();
  const applied = await call(
    `/api/books/${bookId}/document-operations/${report.receipts.applyOperationId}`,
  );
  check(
    applied.operationId === report.receipts.applyOperationId &&
      proposalPosts === 1,
    "Lost application acknowledgment recovers the original tracked-change receipt",
  );
  const reopenedContext = await browser.newContext({
    storageState: await context.storageState(),
    viewport: { width: 1440, height: 1000 },
  });
  const reopened = await reopenedContext.newPage();
  await reopened.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
  await reopened
    .getByText("Saved author assessment: weak", { exact: true })
    .waitFor();
  check(
    (await reopened
      .getByLabel("Story question", { exact: true })
      .inputValue()) === question,
    "Another browser context reopens the question, evidence, critique and saved author assessment",
  );
  const currentThread = await call(
    `/api/books/${bookId}/plot-threads/${threadId}`,
  );
  const staleEvidence = currentThread.evidence.filter((item) => item.stale);
  check(
    staleEvidence.length > 0 &&
      currentThread.reviews[0].stale &&
      staleEvidence.every(
        (item) =>
          item.source.text ===
          linked.evidence.find((original) => original.id === item.id)?.source
            .text,
      ),
    "Approved tracked application marks affected evidence and review stale while retaining exact original quotations",
  );
  const currentEvidence = currentThread.evidence.find((item) => !item.stale);
  check(
    Boolean(currentEvidence),
    "At least one unchanged excerpt remains navigable after the selected revision",
  );
  await reopened.locator(`a[href*="evidenceId=${currentEvidence.id}"]`).click();
  await reopened
    .getByText(
      `Opened exact ${currentEvidence.stage} evidence from Plot Threads.`,
      { exact: true },
    )
    .waitFor();
  const capture = reopened.getByRole("button", {
    name: "Add selection to plot thread",
    exact: true,
  });
  await capture.waitFor();
  await capture.click();
  await reopened
    .getByLabel("Thread", { exact: true })
    .selectOption(String(threadId));
  await reopened
    .getByLabel("Stage", { exact: true })
    .selectOption("escalation");
  await reopened
    .getByRole("button", { name: "Save selection link", exact: true })
    .click();
  await reopened
    .getByText("Saved escalation evidence. Inspect it in Plot Threads.", {
      exact: true,
    })
    .waitFor();
  check(
    (await call(`/api/books/${bookId}/plot-threads/${threadId}`)).evidence
      .length === 4,
    "Exact evidence navigation restores editor selection and editor capture saves a durable link",
  );
  const mobileContext = await browser.newContext({
    storageState: await context.storageState(),
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
  await mobile.getByLabel("Story question", { exact: true }).waitFor();
  check(
    new URL(mobile.url()).pathname === "/m/plot",
    "Phone routing preserves book and thread identity in the mobile workflow",
  );
  check(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile workflow has no horizontal overflow at 390px",
  );
  await mobile.getByLabel("Story question", { exact: true }).focus();
  await mobile.keyboard.press("Tab");
  check(
    await mobile.evaluate(() => document.activeElement?.tagName === "TEXTAREA"),
    "Thread form follows a usable keyboard focus order",
  );
  await mobile.screenshot({
    path: path.join(output, "mobile-thread.png"),
    fullPage: true,
  });
  await mobileContext.addCookies([
    { name: "proser-view", value: "desktop", url: base },
  ]);
  await mobile.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
  check(
    new URL(mobile.url()).pathname === "/plot",
    "Persistent desktop override remains honored for Plot Studio",
  );
  const foreign = await page.request.get(
    `${base}/api/books/${bookId}/plot-threads/${threadId}`,
    { headers: { "x-proser-expected-user": "foreign-session" } },
  );
  check(
    foreign.status() === 409,
    "Proxy rejects a stale or foreign authenticated-session precondition",
  );
  const secondBook = await call("/api/books", {
    title: "Disposable alternate thread book " + randomUUID(),
    operationId: randomUUID(),
  });
  report.bookIds.push(secondBook.id);
  await reopened.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
  await reopened
    .getByLabel("Plot threads manuscript")
    .selectOption(String(secondBook.id));
  await reopened
    .getByText("No plot threads. Create a story question to begin.", {
      exact: true,
    })
    .waitFor();
  check(
    (await reopened.getByLabel("Story question", { exact: true }).count()) ===
      0,
    "Book switching removes the previous manuscript’s thread details",
  );
  if (process.env.PROSER_PLOT_SECOND_SESSION_FILE) {
    const filename = process.env.PROSER_PLOT_SECOND_SESSION_FILE,
      info = await lstat(filename);
    if (
      !path.isAbsolute(filename) ||
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077
    )
      throw new Error("Second session must be an owner-only regular file.");
    const other = JSON.parse(await readFile(filename, "utf8"));
    if (
      other.kind !== "disposable-signed-author-session" ||
      !/^release-canary-[a-f0-9-]{36}$/.test(other.identity) ||
      other.cookie.url !== base ||
      other.cookie.expires <= Date.now() / 1000
    )
      throw new Error("Fresh second disposable author session required.");
    await reopened.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
    await reopened.getByLabel("Story question", { exact: true }).waitFor();
    // Use the actual sign-out boundary so in-flight session rotation cannot
    // overwrite a replacement fixture cookie from the previous identity.
    await reopened.getByRole("button", { name: session.user.name }).click();
    await reopened
      .getByRole("menuitem", { name: "Sign Out", exact: true })
      .click();
    await reopened.waitForURL((url) => url.pathname === "/auth/signin");
    await reopened.getByLabel("Username", { exact: true }).waitFor();
    await reopenedContext.clearCookies();
    await reopenedContext.addCookies([other.cookie]);
    await reopened.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
    await reopened.getByRole("alert").waitFor();
    const changedSession = await (
      await reopened.request.get(base + "/api/auth/session")
    ).json();
    const denied = await reopened.request.get(
      `${base}/api/books/${bookId}/plot-threads/${threadId}`,
      {
        headers: {
          "x-proser-expected-user": encodeURIComponent(changedSession.user.id),
        },
      },
    );
    report.accountSwitch = {
      originalUser: session.user.id,
      currentUser: changedSession.user.id,
      deniedStatus: denied.status(),
      boundary: "UI sign-out followed by a new disposable signed session",
    };
    check(
      changedSession.user.id !== session.user.id && denied.status() === 404,
      "Changing authenticated account rejects the prior owner’s thread through the proxy",
    );
    check(
      (await reopened.getByLabel("Story question", { exact: true }).count()) ===
        0,
      "Account change removes prior owner question, evidence and review UI",
    );
  }
  const publishSource = await call(`/api/books/${bookId}/document-manifest`);
  let publication = await call(
    `/api/books/${bookId}/document-publication-jobs`,
    {
      operationId: randomUUID(),
      expectedRevisionId: publishSource.revisionId,
      options: { format: "docx", mode: "retain-review", preset: "saved" },
    },
  );
  const publicationDeadline = Date.now() + 90000;
  while (
    ["pending", "running"].includes(publication.status) &&
    Date.now() < publicationDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    publication = await call(
      `/api/books/${bookId}/document-publication-jobs/${publication.id}`,
    );
  }
  check(
    publication.status === "completed" && publication.artifactId,
    "Disposable manuscript publishes through the same-origin proxy with tracked review retained",
  );
  const artifact = await call(
    `/api/books/${bookId}/document-publication-artifacts/${publication.artifactId}`,
  );
  const download = await page.request.get(base + publication.downloadPath, {
    headers: { "x-proser-expected-user": encodeURIComponent(session.user.id) },
  });
  check(
    download.ok() &&
      createHash("sha256")
        .update(await download.body())
        .digest("hex") === artifact.sha256,
    "Published DOCX bytes match their retained Factory artifact digest",
  );
  report.receipts.publicationId = publication.id;
  report.receipts.publicationSha256 = artifact.sha256;
  await page.goto(`${base}/plot?bookId=${bookId}&threadId=${threadId}`);
  await page
    .getByLabel("Thread notes", { exact: true })
    .fill("Draft from interrupted update");
  const updatePattern = `**/plot-threads/${threadId}`;
  await context.route(updatePattern, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    report.receipts.unappliedOperationId = route
      .request()
      .postDataJSON().operationId;
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "Save thread changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Recover original request", exact: true })
    .waitFor();
  await context.unroute(updatePattern);
  const beforeCompetingUpdate = await call(
    `/api/books/${bookId}/plot-threads/${threadId}`,
  );
  report.receipts.competingOperationId = randomUUID();
  await call(
    `/api/books/${bookId}/plot-threads/${threadId}`,
    {
      operationId: report.receipts.competingOperationId,
      expectedVersion: beforeCompetingUpdate.version,
      notes: "Concurrent saved author update",
    },
    "PATCH",
  );
  await page
    .getByRole("button", { name: "Recover original request", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "No saved receipt" })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Retry identical recorded request",
      exact: true,
    })
    .click();
  await page
    .getByRole("region", { name: "Plot thread request recovery", exact: true })
    .waitFor({ state: "detached" });
  check(
    (await page.getByLabel("Thread notes", { exact: true }).inputValue()) ===
      "Draft from interrupted update" &&
      (await call(`/api/books/${bookId}/plot-threads/${threadId}`)).notes ===
        "Concurrent saved author update",
    "An absent original receipt followed by a version-conflict replay frees recovery while preserving the unsaved draft and competing saved update",
  );
  await page
    .getByRole("button", {
      name: "Discard unsaved thread changes",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Refresh threads", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Thread notes"]')?.value ===
      "Concurrent saved author update",
  );
  check(
    (await page.getByLabel("Thread notes", { exact: true }).inputValue()) ===
      "Concurrent saved author update",
    "The author can reload current thread inputs after a definitively unapplied original request",
  );
  check(
    report.errors.length === 0,
    "Browser workflow completed without uncaught application errors",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  process.exitCode = 1;
  await page
    .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    path.join(output, "failure-ui.txt"),
    await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
    { mode: 0o600 },
  );
} finally {
  if (call && bookId) {
    try {
      for (const retiringBook of report.bookIds) {
        const manifest = await call(
          `/api/books/${retiringBook}/document-manifest`,
        );
        await call(
          `/api/books/${retiringBook}`,
          {
            documentPreconditions: {
              operationId: randomUUID(),
              expectedRevisionId: manifest.revisionId,
              expectedScopes: {
                structure: manifest.scopes.structure.revisionId,
              },
            },
          },
          "DELETE",
        );
      }
      report.retiredCanary = true;
    } catch (error) {
      report.retirementFailure = error.message;
      process.exitCode = 1;
    }
  }
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: path.join(output, "report.json"),
      failure: report.failure,
    }) + "\n",
  );
}
