import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const { databaseService } = require("./dist/lib/database");
const { documentService } = require("./dist/documents/service");
const {
  ownedStorySource,
  storyDigest,
} = require("./dist/documents/storyProposalSources");
const { createStoryDiscussion } = require("./dist/documents/storyProposals");
const {
  passageOperationRunSource,
} = require("./dist/documents/passageOperationSources");
const {
  documentFromText,
  projectDocument,
  minimalTextEdit,
} = require("./dist/documents/model");
const {
  documentProposalOutputSchema,
} = require("./dist/documents/proposalValidation");
const { deriveStoryDraft } = require("./dist/documents/storyProposalSources");
const { editedDocument } = require("./dist/documents/proposals");
const base = process.env.PROSER_RELEASE_SMOKE_BASE_URL,
  output = process.env.PROSER_RELEASE_SMOKE_OUTPUT;
if (
  !base ||
  !output ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname)
)
  throw new Error(
    "Explicit loopback story fixture output and URL are required.",
  );
const dbURL = new URL(
  process.env.DATABASE_URL ?? "postgresql://invalid/invalid",
);
if (
  dbURL.hostname !== "127.0.0.1" ||
  dbURL.port !== "55441" ||
  !/^\/proser_canvas_ai_release_[a-zA-Z0-9_]+$/.test(dbURL.pathname)
)
  throw new Error(
    "Use only fresh synthetic ai-release PostgreSQL55441 for story browser fixtures.",
  );
const report = {
  schemaVersion: 1,
  scope: "isolated genuine parent/story UI",
  providers: "no inference invoked; prevalidated fixture proposal seeded",
  checks: [],
  errors: [],
  microsoftWord: "unverified",
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
let bookId,
  call,
  userId,
  storyId,
  source,
  discussion,
  proposalId,
  localOperations,
  sceneId;
const requests = [];
page.on("pageerror", (e) => report.errors.push(e.message));
context.on("request", (req) => {
  const url = new URL(req.url());
  if (
    url.pathname.includes("document-story") ||
    url.pathname.includes("document-draft-commits")
  )
    requests.push({
      method: req.method(),
      path: url.pathname,
      data: req.postDataJSON(),
    });
});
const verify = (value, message) => {
  if (!value) throw new Error(message);
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
    const res = await page.request.fetch(base + route, {
      method,
      data,
      timeout: 120000,
      headers: {
        "x-proser-expected-user": encodeURIComponent(session.user.id),
      },
    });
    const body = await res.json();
    if (!res.ok() || !body.success)
      throw new Error(
        `${method} ${route}: ${body.error?.code ?? res.status()}`,
      );
    return body.data;
  };
  const book = await call("/api/books", {
    title: "Disposable story release " + randomUUID(),
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
  const { act } = await call(`/api/books/${bookId}/acts`, {
    title: "Source act",
    documentPreconditions: await preconditions(),
  });
  const { chapter } = await call(
    `/api/books/${bookId}/acts/${act.id}/chapters`,
    { title: "Source chapter", documentPreconditions: await preconditions() },
  );
  await call(`/api/books/${bookId}/chapters/${chapter.id}/scenes/batch`, {
    scenes: [
      {
        prose: "Actual scene body must remain intact.",
        summary: "Owned story fixture",
      },
    ],
    documentPreconditions: await preconditions(),
  });
  const manifest = await call(`/api/books/${bookId}/document-manifest`);
  sceneId = manifest.scenes[0].sceneId;
  await databaseService.connect();
  const db = databaseService.client;
  userId = (await db.book.findUniqueOrThrow({ where: { id: bookId } })).userId;
  const layout = await documentService.scope(userId, bookId, "layout");
  storyId = randomUUID();
  const document = documentFromText("Original header.", randomUUID);
  document.blocks[0].runs[0].style = { bold: true, italic: true };
  const cell = documentFromText("Protected table cell.", randomUUID).blocks[0];
  document.blocks.push({
    type: "table",
    id: randomUUID(),
    widths: [180],
    rows: [
      { id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [cell] }] },
    ],
  });
  layout.content.headerFooterStories = [
    { id: storyId, kind: "header", owner: "book", document },
  ];
  await documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: randomUUID(),
      expectedRevisionId: layout.bookRevisionId,
      expectedScopes: { layout: layout.revisionId },
      payload: { fixture: "story-browser" },
    },
    async () => ({ result: null, layout: layout.content }),
  );
  source = await ownedStorySource(db, userId, bookId, storyId);
  const paragraph = source.document.blocks[0];
  const draftOperationId = randomUUID(),
    edit = minimalTextEdit(paragraph.runs[0].text, "Original unsaved header.");
  localOperations = {
    operationId: draftOperationId,
    operations: [
      {
        id: randomUUID(),
        kind: "text",
        target: passageOperationRunSource(
          source.document,
          paragraph.id,
          paragraph.runs[0].id,
          edit.start,
          edit.end,
        ),
        expectedText: paragraph.runs[0].text.slice(edit.start, edit.end),
        replacement: edit.replacement,
      },
    ],
  };
  discussion = await createStoryDiscussion(userId, bookId, {
    schemaVersion: 1,
    operationId: randomUUID(),
    sessionId: randomUUID(),
    storyId,
    expectedRevisionId: source.bookRevisionId,
    expectedLayoutRevisionId: source.layoutRevisionId,
    expectedContentHash: source.contentHash,
    projection: "final",
    targets: [
      {
        blockId: paragraph.id,
        from: 0,
        to: 24,
        sourceText: "Original unsaved header.",
      },
    ],
    localOperations,
  });
  proposalId = randomUUID();
  const input = {
      operationId: proposalId,
      instruction: "Review exact owned header fixture.",
    },
    snapshot = discussion.snapshot,
    outputProposal = {
      reply: "Retained fixture proposal.",
      edits: [
        {
          targetId: snapshot.targets[0].targetId,
          sourceText: snapshot.targets[0].sourceText,
          replacement: "Reviewed header.",
        },
      ],
    };
  documentProposalOutputSchema.parse(outputProposal);
  editedDocument(
    deriveStoryDraft(source, localOperations, userId),
    snapshot,
    outputProposal,
    [snapshot.targets[0].targetId],
    userId,
  );
  await db.documentStoryProposal.create({
    data: {
      id: proposalId,
      discussionId: discussion.id,
      bookId,
      userId,
      storyId,
      requestHash: storyDigest({
        userId,
        bookId,
        discussionId: discussion.id,
        input,
      }),
      request: input,
      status: "ready",
      completedAt: new Date(),
      result: {
        raw: JSON.stringify(outputProposal),
        output: outputProposal,
        provenance: {
          providerId: "isolated-seeded-fixture",
          recipe: "document-proposal",
          recipeVersion: "1.0.0",
          params: { noProviderEffect: true },
        },
      },
    },
  });
  await page.goto(`${base}/manuscript?bookId=${bookId}&sceneId=${sceneId}`);
  await page
    .getByRole("button", { name: "Page setup", exact: true })
    .waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "Page setup", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit header story", exact: true })
    .click();
  const editor = page.getByText("Header story", { exact: true }).locator("..");
  await editor
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const field = editor.getByRole("textbox", {
    name: "Paragraph 1",
    exact: true,
  });
  await field.fill("Original unsaved header.");
  await page.getByText("Saved discussions", { exact: true }).last().click();
  const history = page.getByRole("complementary", {
    name: "Story discussion and proposals",
  });
  await history
    .getByRole("button")
    .filter({ hasText: /\d+\/\d+\/\d+/ })
    .first()
    .click();
  await history
    .getByRole("button", { name: "Recover ready proposal", exact: true })
    .click();
  await page.getByText("Retained fixture proposal.", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(output, "before-application.png"),
    fullPage: true,
  });
  let aborted = false;
  await context.route(
    `**/layout-stories/${storyId}/document-draft-commits`,
    async (route) => {
      if (aborted) return route.continue();
      aborted = true;
      const response = await route.fetch();
      verify(response.ok(), "Original typed save failed before lost ACK");
      await route.abort("failed");
    },
  );
  await history
    .getByRole("button", {
      name: "Save, revalidate and apply selected edits",
      exact: true,
    })
    .click();
  await page
    .getByText("Story save needs exact operation recovery.", { exact: false })
    .waitFor({ timeout: 10000 })
    .catch(() => undefined);
  await page.screenshot({
    path: path.join(output, "lost-ack.png"),
    fullPage: true,
  });
  const sent = requests.find(
    (r) => r.method === "POST" && r.path.endsWith("/document-draft-commits"),
  );
  verify(
    sent?.data.operationId === draftOperationId,
    "Parent lost original saved discussion UUID",
  );
  verify(
    JSON.stringify(sent.data.operations) ===
      JSON.stringify(localOperations.operations),
    "Parent changed original saved discussion intentions",
  );
  verify(
    (await db.documentOperation.count({
      where: { id: draftOperationId, bookId },
    })) === 1,
    "Lost ACK did not commit exactly once",
  );
  report.checks.push(
    "Exact retained discussion UUID/intents flushed through parent; one durable commit despite lost ACK",
  );
  const buttons = await page.getByRole("button").allTextContents();
  await writeFile(
    path.join(output, "buttons-after-loss.json"),
    JSON.stringify(buttons, null, 2),
  );
  const recover = page
    .getByRole("button", { name: /Recover.*(?:receipt|operation|save)/i })
    .first();
  await recover.click();
  await page
    .getByText("Story saved by Factory.", { exact: true })
    .waitFor({ timeout: 20000 });
  verify(
    requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/document-draft-commits"),
    ).length === 1,
    "Receipt recovery repeated a typed save",
  );
  report.checks.push(
    "Parent exact receipt GET recovery adopts original immutable layout without duplicate POST",
  );
  await history
    .getByRole("button", {
      name: "Save, revalidate and apply selected edits",
      exact: true,
    })
    .click();
  await page
    .getByText(/Proposal applied as tracked changes/)
    .waitFor({ timeout: 20000 });
  const after = await ownedStorySource(db, userId, bookId, storyId);
  verify(
    projectDocument(after.document).text.includes("Reviewed header."),
    "Tracked proposal not applied",
  );
  verify(
    projectDocument(after.document, "original").text.includes(
      "Original unsaved header.",
    ),
    "Original view lost saved draft",
  );
  verify(
    JSON.stringify(after.document.blocks[1]) ===
      JSON.stringify(source.document.blocks[1]),
    "Protected table changed",
  );
  verify(
    after.document.changes.every(
      (c) =>
        c.status === "pending" && c.origin === "ai" && c.authorId === userId,
    ),
    "Tracked review provenance incorrect",
  );
  const scene = await documentService.read(userId, bookId, sceneId);
  verify(
    projectDocument(scene.document).text ===
      "Actual scene body must remain intact.",
    "Actual scene body changed",
  );
  verify(
    requests.filter(
      (r) =>
        r.method === "POST" &&
        /document-story-discussions\/[^/]+\/proposals$/.test(r.path),
    ).length === 0,
    "History recovery dispatched inference",
  );
  report.checks.push(
    "Explicit revalidation and tracked apply preserved style/table/actual scene; no inference POST",
  );
  await page.screenshot({
    path: path.join(output, "applied.png"),
    fullPage: true,
  });
  report.final = {
    bookId,
    storyId,
    proposalId,
    draftOperationId,
    layoutRevisionId: after.layoutRevisionId,
    contentHash: after.contentHash,
    changes: after.document.changes.length,
  };
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await page
    .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    path.join(output, "failure-dom.txt"),
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  process.exitCode = 1;
} finally {
  if (bookId && call)
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
      report.disposableBookRetired = true;
    } catch (error) {
      report.cleanupFailure =
        error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(output, "requests.json"),
    JSON.stringify(requests, null, 2),
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
