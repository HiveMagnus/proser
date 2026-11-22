/** Isolated real-browser source/recovery proof; inference output is explicitly seeded. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const { databaseService } = require("./dist/lib/database");
const { storyDigest } = require("./dist/documents/storyProposalSources");
const {
  verifyTransitionOutput,
} = require("./dist/documents/chapterTransitions");
const { editedDocument } = require("./dist/documents/proposals");
const base = process.env.PROSER_RELEASE_SMOKE_BASE_URL,
  output = process.env.PROSER_RELEASE_SMOKE_OUTPUT;
const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !base ||
  !output ||
  new URL(base).hostname !== "localhost" ||
  database.hostname !== "127.0.0.1" ||
  database.port !== "55441" ||
  !/^\/proser_canvas_transition_release_\w+$/.test(database.pathname)
)
  throw new Error("Explicit isolated transition fixture services required.");
await mkdir(output, { recursive: true, mode: 0o700 });
const report = {
  scope: "isolated Chromium; seeded proposal, no provider call",
  checks: [],
  errors: [],
};
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
page.on("pageerror", (e) => report.errors.push(e.message));
let bookId,
  call,
  originalRevision,
  clientProposalPosts = 0;
const check = (value, message) => {
  if (!value) throw new Error(message);
  report.checks.push(message);
};
try {
  await page.goto(base + "/auth/signin");
  await page.getByLabel("Username").fill(process.env.PLAYWRIGHT_IAM_USERNAME);
  await page.getByLabel("Password").fill(process.env.PLAYWRIGHT_IAM_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {
    timeout: 60000,
  });
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
    });
    const body = await response.json();
    if (!response.ok() || !body.success)
      throw new Error(`${route}: ${body.error?.code ?? response.status()}`);
    return body.data;
  };
  const book = await call("/api/books", {
    title: "Disposable transition browser " + randomUUID(),
    operationId: randomUUID(),
  });
  bookId = book.id;
  const preconditions = async () => {
    const m = await call(`/api/books/${bookId}/document-manifest`);
    return {
      operationId: randomUUID(),
      expectedRevisionId: m.revisionId,
      expectedScopes: { structure: m.scopes.structure.revisionId },
    };
  };
  for (const actNumber of [1, 2]) {
    const { act } = await call(`/api/books/${bookId}/acts`, {
      title: `Act ${actNumber}`,
      documentPreconditions: await preconditions(),
    });
    for (const chapterNumber of [1, 2]) {
      const { chapter } = await call(
        `/api/books/${bookId}/acts/${act.id}/chapters`,
        {
          title: `Chapter ${actNumber}-${chapterNumber}`,
          documentPreconditions: await preconditions(),
        },
      );
      await call(`/api/books/${bookId}/chapters/${chapter.id}/scenes/batch`, {
        scenes: [
          {
            prose: `She reached the locked door ${actNumber}-${chapterNumber}.\n\n${"Interior context. ".repeat(200)}\n\nThe alarm sounded ${actNumber}-${chapterNumber} 😀`,
          },
        ],
        documentPreconditions: await preconditions(),
      });
    }
  }
  const batch = await call(`/api/books/${bookId}/chapter-transitions`);
  originalRevision = batch.bookRevisionId;
  check(
    batch.transitions.length === 3 &&
      batch.transitions[1].opening.label.includes("Act 2 · Chapter 1"),
    "Three canonical boundaries include act-local chapter numbering",
  );
  await databaseService.connect();
  let allowResponse;
  const blockedResponse = new Promise((resolve) => {
    allowResponse = resolve;
  });
  await context.route("**/document-discussions/*/proposals", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    clientProposalPosts++;
    const request = route.request().postDataJSON(),
      discussionId = new URL(route.request().url()).pathname.split("/").at(-2);
    const db = databaseService.client,
      discussion = await db.documentDiscussion.findUniqueOrThrow({
        where: { id: discussionId },
      });
    const snapshot = discussion.snapshot,
      target = snapshot.targets[0];
    const result = {
      reply:
        "Continuity: The alarm hands off to a locked door.\nMomentum: Carry the immediate pressure across the boundary.\nReason to keep reading: Can she enter before discovery?\nSmall revision: Add the alarm to the opening sentence.",
      edits: [
        {
          targetId: target.targetId,
          sourceText: target.sourceText,
          replacement: target.sourceText.replace("reached", "hurried to"),
        },
      ],
    };
    verifyTransitionOutput(snapshot, result);
    const source = await db.sceneDocumentRevision.findUniqueOrThrow({
      where: { id: snapshot.sourceSceneRevisionId },
    });
    editedDocument(
      source.document,
      snapshot,
      result,
      [target.targetId],
      discussion.userId,
    );
    await db.documentProposal.create({
      data: {
        id: request.operationId,
        discussionId,
        bookId,
        userId: discussion.userId,
        sceneId: discussion.sceneId,
        requestHash: storyDigest({
          userId: discussion.userId,
          bookId,
          discussionId,
          input: request,
        }),
        request,
        status: "ready",
        completedAt: new Date(),
        result: {
          raw: JSON.stringify(result),
          output: result,
          provenance: {
            providerId: "isolated-seeded-fixture",
            params: { noProviderEffect: true },
            recipe: "document-proposal",
            recipeVersion: "1.0.0",
          },
        },
      },
    });
    await blockedResponse;
    // The durable result exists, but the browser never sees the POST acknowledgement.
    await route.abort("failed");
  });
  await page.goto(`${base}/editorial?bookId=${bookId}`);
  const panel = page.getByRole("region", { name: "Chapter transitions" }),
    card = page.getByRole("article", { name: "Transition 1" });
  await card.waitFor();
  check(
    (await panel.getByRole("article").count()) === 3,
    "Editorial displays three literal boundary pairs",
  );
  check(
    (await card.innerText()).includes("The alarm sounded 1-1 😀"),
    "Ending displays the actual terminal Unicode glyph",
  );
  const otherPage = await context.newPage();
  await otherPage.goto(`${base}/editorial?bookId=${bookId}`);
  const other = otherPage.getByRole("article", { name: "Transition 1" });
  await other
    .getByRole("button", { name: "Review and offer a small revision" })
    .waitFor();
  await card.getByRole("heading", { level: 3 }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "desktop-boundaries.png"),
  });
  await card
    .getByRole("button", { name: "Review and offer a small revision" })
    .click();
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("proser-chapter-transition-reviews", 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("requests"),
            req = tx.objectStore("requests").getAll();
          req.onsuccess = () => resolve(req.result.length === 1);
          tx.oncomplete = () => db.close();
        };
      }),
  );
  await other
    .getByRole("button", { name: "Review and offer a small revision" })
    .click();
  await other.getByRole("alert").waitFor();
  check(
    (await other.getByRole("alert").innerText()).includes("already retained"),
    "Real IndexedDB prevents a competing tab from dispatching another review",
  );
  allowResponse();
  await card.getByRole("alert").waitFor();
  await card.getByRole("button", { name: "Recover saved review" }).click();
  await card
    .getByRole("heading", { name: "After · suggested opening" })
    .waitFor();
  check(
    clientProposalPosts === 1,
    "Lost acknowledgement recovery uses GET; one proposal dispatch",
  );
  check(
    (await card.innerText()).includes("She hurried to the locked door 1-2."),
    "Before/after shows the exact small opening proposal",
  );
  await card
    .getByRole("heading", { name: "Before", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "desktop-review.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await card
    .getByRole("heading", { name: "Before", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "mobile-review.png"),
  });
  check(
    await card.evaluate((article) => {
      const bounds = article.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        article.scrollWidth <= article.clientWidth
      );
    }),
    "Narrow browser view keeps chapter comparisons within viewport",
  );
  const newDevice = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await newDevice.addCookies(await context.cookies());
  let newDispatches = 0;
  newDevice.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /document-discussions.*proposals/.test(request.url())
    )
      newDispatches++;
  });
  const newPage = await newDevice.newPage();
  await newPage.goto(`${base}/editorial?bookId=${bookId}`);
  await newPage
    .getByRole("article", { name: "Transition 1" })
    .getByRole("heading", { name: "After · suggested opening" })
    .waitFor();
  check(
    newDispatches === 0,
    "Another browser loads the Factory-retained review with no new inference",
  );
  await newDevice.close();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    isMobile: true,
    hasTouch: true,
  });
  await phone.addCookies(await context.cookies());
  const phonePage = await phone.newPage();
  await phonePage.goto(`${base}/editorial?bookId=${bookId}`);
  await phonePage.waitForURL((url) => url.pathname === "/m/editorial");
  const phoneCard = phonePage.getByRole("article", { name: "Transition 1" });
  await phoneCard
    .getByRole("heading", { name: "After · suggested opening" })
    .waitFor();
  await phoneCard
    .getByRole("heading", { name: "Before", exact: true })
    .scrollIntoViewIfNeeded();
  await phonePage.screenshot({
    path: path.join(output, "phone-editorial-review.png"),
  });
  check(
    await phoneCard.evaluate((article) => {
      const bounds = article.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        article.scrollWidth <= article.clientWidth
      );
    }),
    "Emulated phone routes to /m/editorial and loads the owned deep-linked comparison",
  );
  await phone.close();

  const after = await call(`/api/books/${bookId}/document-manifest`);
  check(
    after.revisionId === originalRevision,
    "Review and recovery leave canonical manuscript revision unchanged",
  );
  report.bookId = bookId;
  report.revisionId = originalRevision;
  check(report.errors.length === 0, "No browser JavaScript errors");
} catch (failure) {
  report.failure = failure.message;
  process.exitCode = 1;
  await page
    .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
} finally {
  if (bookId && call) {
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
    report.disposableBookRetired = true;
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await browser.close();
  await require("./dist/server").shutdown();
}
console.log(
  JSON.stringify({
    checks: report.checks.length,
    failure: report.failure,
    errors: report.errors,
  }),
);
process.exit(process.exitCode ?? 0);
