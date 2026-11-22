import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openReleaseBrowser } from "./document-release-browser.mjs";
import { testR2QuickDraft } from "./test-r2-quick-draft.mjs";
import { testR2AuthenticatedWorkspace } from "./test-r2-authenticated-workspace.mjs";
import { testR2BookCatalog } from "./test-r2-book-catalog.mjs";

// Focused iteration uses the same real Factory/Author runner as the complete
// acceptance suite. No direct database mutation, inference or production URL.
const base = new URL(
  process.env.PROSER_RELEASE_SMOKE_BASE_URL ?? "http://localhost:3320",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw new Error("R2 fixtures require loopback Author");
const output = path.resolve(
  process.env.PROSER_RELEASE_SMOKE_OUTPUT ?? "output/playwright/r2-focused",
);
await mkdir(output, { recursive: true, mode: 0o700 });
const { browser, context, page, profile } = await openReleaseBrowser(output);
const report = {
  browserProfile: profile,
  checks: [],
  failures: [],
  passed: false,
  browserErrors: [],
  fullSceneUIReads: [],
  readerSceneReads: [],
  hardwareCertification: "pending physical iPhone and VoiceOver",
};
page.on("pageerror", (error) => report.browserErrors.push(error.message));
let bookId,
  call,
  reading = false;
context.on("request", (request) => {
  if (
    request.method() === "GET" &&
    /\/scenes\/\d+\/document$/.test(new URL(request.url()).pathname)
  )
    (reading ? report.readerSceneReads : report.fullSceneUIReads).push(
      new URL(request.url()).pathname,
    );
});
try {
  await page.goto(new URL("/auth/signin", base).href);
  await page.getByLabel("Username").fill(process.env.PLAYWRIGHT_IAM_USERNAME);
  await page.getByLabel("Password").fill(process.env.PLAYWRIGHT_IAM_PASSWORD);
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await (profile.pointerActivation === "touch" ? signIn.tap() : signIn.click());
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"));
  const session = await (
    await page.request.get(new URL("/api/auth/session", base).href)
  ).json();
  call = async (route, data, method = data === undefined ? "GET" : "POST") => {
    const response = await page.request.fetch(new URL(route, base).href, {
      method,
      data,
      timeout: 120_000,
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
  if (process.env.PROSER_RELEASE_R2_BOOK_CATALOG_ONLY === "true") {
    await testR2BookCatalog({ page, context, call, base, report, output });
  } else if (process.env.PROSER_RELEASE_R2_QUICK_DRAFT_ONLY === "true") {
    await testR2QuickDraft({
      page,
      context,
      call,
      base,
      report,
      output,
      pointerActivation: profile.pointerActivation,
    });
  } else {
    bookId = (
      await call("/api/books", {
        title: `Disposable R2 fixture ${randomUUID()}`,
        operationId: randomUUID(),
      })
    ).id;
    const preconditions = async () => {
      const manifest = await call(`/api/books/${bookId}/document-manifest`);
      return {
        operationId: randomUUID(),
        expectedRevisionId: manifest.revisionId,
        expectedScopes: { structure: manifest.scopes.structure.revisionId },
      };
    };
    const { act } = await call(`/api/books/${bookId}/acts`, {
      title: "R2 fixture",
      documentPreconditions: await preconditions(),
    });
    const { chapter } = await call(
      `/api/books/${bookId}/acts/${act.id}/chapters`,
      { title: "R2 chapter", documentPreconditions: await preconditions() },
    );
    await call(`/api/books/${bookId}/chapters/${chapter.id}/scenes/batch`, {
      scenes: [
        {
          prose: "R2 native source paragraph.\n\nR2 unchanged paragraph.",
          summary: "R2 isolated fixture",
        },
      ],
      documentPreconditions: await preconditions(),
    });
    const manifest = await call(`/api/books/${bookId}/document-manifest`);
    const sceneId = manifest.scenes[0].sceneId;
    const saved = await call(`/api/books/${bookId}/scenes/${sceneId}/document`);
    const document = structuredClone(saved.document);
    document.blocks.push({
      type: "table",
      id: randomUUID(),
      widths: [160, 160],
      rows: [0, 1].map(() => ({
        id: randomUUID(),
        cells: [0, 1].map(() => ({
          id: randomUUID(),
          paragraphs: [
            {
              type: "paragraph",
              id: randomUUID(),
              style: {},
              runs: [{ id: randomUUID(), text: "", style: {} }],
            },
          ],
        })),
      })),
    });
    await call(`/api/books/${bookId}/document-commits`, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: manifest.revisionId,
      scenes: [{ sceneId, expectedRevisionId: saved.revisionId, document }],
    });
    await testR2AuthenticatedWorkspace({
      page,
      context,
      call,
      bookId,
      sceneId,
      base,
      report,
      setReading: (value) => {
        reading = value;
      },
    });
  }
  if (report.browserErrors.length || report.fullSceneUIReads.length)
    throw new Error("R2 browser exceptions or whole-scene editing reads");
  report.passed = true;
} catch (error) {
  report.failures.push(error.message);
  report.failureStack = error.stack;
  await page
    .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (bookId && call) {
    try {
      const manifest = await call(`/api/books/${bookId}/document-manifest`);
      await call(
        `/api/books/${bookId}`,
        {
          documentPreconditions: {
            operationId: randomUUID(),
            expectedRevisionId: manifest.revisionId,
            expectedScopes: { structure: manifest.scopes.structure.revisionId },
          },
        },
        "DELETE",
      );
      report.disposableBookDeleted = true;
    } catch (error) {
      report.failures.push(`Cleanup: ${error.message}`);
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
  console.log(JSON.stringify(report));
}
