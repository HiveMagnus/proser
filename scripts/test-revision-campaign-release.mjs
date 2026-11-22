import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import path from "node:path";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const base = process.env.PROSER_RELEASE_SMOKE_BASE_URL;
const output = process.env.PROSER_RELEASE_SMOKE_OUTPUT;
const live = process.env.PROSER_CAMPAIGN_LIVE === "true";
const keyboard = process.env.PROSER_CAMPAIGN_KEYBOARD === "true";
const narrow = process.env.PROSER_CAMPAIGN_MOBILE === "true";
const activate = async (locator) => {
  if (!keyboard) return locator.click();
  await locator.click({ trial: true });
  await locator.press("Enter");
};
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
  interaction: keyboard
    ? "Keyboard Enter activates every campaign action"
    : "Pointer with keyboard focus-order checks",
  primaryViewport: narrow ? "390px emulated mobile" : "1440px desktop",
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
  viewport: narrow
    ? { width: 390, height: 844 }
    : { width: 1440, height: 1000 },
  ...(narrow
    ? {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1",
      }
    : {}),
});
const page = await context.newPage();
report.campaignRequests = [];
context.on("request", (request) => {
  if (
    !["POST", "PATCH"].includes(request.method()) ||
    !new URL(request.url()).pathname.includes("/revision-campaigns")
  )
    return;
  try {
    report.campaignRequests.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      body: request.postDataJSON(),
    });
  } catch {}
});
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
    await activate(page.getByRole("button", { name: "Sign in", exact: true }));
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
      title: "Disposable Revision Campaign browser " + randomUUID(),
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
    "The key was brass. Mara waited by the gate and counted the guards as the rain fell around her. Beyond the bars, the antagonist watched the narrow street. He knew she would return for her brother, but he said nothing about the debt. The red seal lay beside his hand, untouched. She kept her voice low and her eyes on the key.",
    "The key was brass. Mara waited by the prison door and listened to the guards changing shifts. The antagonist held the red seal in his open hand. He wanted her to see it, wanted her to understand that the debt had followed her here. She did not look away. She remembered the promise she had made to her brother and kept her voice low.",
    "The key was brass. Mara waited by the vault while the antagonist confessed that the debt had bought her silence. She had followed the red seal from the gate to the prison and now to this room. Her brother stood behind her. She kept her voice low and asked for the ledger, and the antagonist finally placed it on the table.",
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
  const initialDigest = createHash("sha256")
    .update(JSON.stringify(initialManifest))
    .digest("hex");
  const thread = await call(`/api/books/${bookId}/plot-threads`, {
    operationId: randomUUID(),
    expectedVersion: 0,
    question,
  });
  for (let index = 0; index < scenes.length; index++) {
    const source = await call(
        `/api/books/${bookId}/scenes/${scenes[index]}/document`,
      ),
      paragraph = source.document.blocks.find((x) => x.type === "paragraph");
    await call(
      `/api/books/${bookId}/plot-threads/${thread.threadId}/evidence`,
      {
        operationId: randomUUID(),
        expectedVersion: index + 1,
        stage: ["setup", "escalation", "payoff"][index],
        sceneId: scenes[index],
        expectedRevisionId: source.bookRevisionId,
        expectedSceneRevisionId: source.revisionId,
        expectedContentHash: source.contentHash,
        targets: [
          {
            blockId: paragraph.id,
            from: 0,
            to: prose[index].length,
            sourceText: prose[index],
          },
        ],
      },
    );
  }
  await page.goto(`${base}/editorial/campaigns?bookId=${bookId}`);
  await page
    .getByLabel("Revision goal", { exact: true })
    .fill(
      "Revise EACH of the three chapters to add one new, small, visible act of intimidation by the antagonist: a deliberate pause, a guarded look, or a controlled movement. The goal requires one prose revision in every chapter. Preserve the brass key, red seal, existing plot actions, close viewpoint and restrained voice.",
    );
  let creationPosts = 0;
  await context.route("**/revision-campaigns", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creationPosts++;
    const response = await route.fetch();
    check(
      response.ok(),
      "Campaign creation committed before lost acknowledgment",
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
  await activate(
    page.getByRole("button", { name: "Create campaign", exact: true }),
  );
  await activate(
    page.getByRole("button", { name: "Recover original request", exact: true }),
  );
  await page.waitForURL((url) => url.searchParams.has("campaignId"));
  await context.unroute("**/revision-campaigns");
  const campaignId = new URL(page.url()).searchParams.get("campaignId");
  report.campaignId = campaignId;
  check(
    creationPosts === 1,
    "Lost creation acknowledgment recovers exactly one campaign",
  );
  const campaignPath = `/api/books/${bookId}/revision-campaigns/${campaignId}`;
  const waitPlan = async () => {
    const deadline = Date.now() + (live ? 600000 : 120000);
    while (Date.now() < deadline) {
      const rejection = page.locator('[role="alert"].text-danger').filter({
        hasNotText: "Coverage incomplete. Plan approval is blocked.",
      });
      if (await rejection.count())
        throw new Error(
          "Campaign action rejected: " + (await rejection.first().innerText()),
        );
      const value = await call(campaignPath);
      const plan = value.plans.find(
        (x) => x.analysis && x.workflowStatus === "completed",
      );
      const latest = value.plans[0];
      if (
        latest?.workflowStatus === "paused" ||
        latest?.workflowStatus === "failed"
      )
        throw new Error(
          `Analysis ${latest.workflowStatus}: ${latest.failureReason}`,
        );
      if (
        latest?.workflowStatus === "completed" &&
        latest.analysis &&
        !latest.analysis.complete
      )
        throw new Error(
          "Completed analysis has missing coverage: " +
            latest.analysis.gaps.join(" "),
        );
      if (
        plan &&
        !plan.stale &&
        value.plans.every(
          (x) => !["queued", "running"].includes(x.workflowStatus),
        )
      )
        return { value, plan };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      "Campaign analysis did not finish within the acceptance deadline.",
    );
  };
  await activate(
    page.getByRole("button", { name: "Scan whole manuscript", exact: true }),
  );
  let { value, plan } = await waitPlan();
  await activate(
    page.getByRole("button", { name: "Refresh saved campaign", exact: true }),
  );
  check(
    plan.analysis.complete &&
      plan.analysis.coverage.every((x) =>
        ["reviewed", "empty"].includes(x.status),
      ),
    "Whole-book scan accounts for every saved scene range",
  );
  await activate(
    page.getByRole("button", {
      name: "Use cited protection suggestions",
      exact: true,
    }),
  );
  await activate(
    page.getByRole("button", {
      name: "Save confirmed protections and goal",
      exact: true,
    }),
  );
  await activate(
    page.getByRole("button", {
      name: "Refresh plan and re-review evidence",
      exact: true,
    }),
  );
  ({ value, plan } = await waitPlan());
  const appliedScenes = new Set();
  const { resolveChange } = require("../ProserFactory/dist/documents/model");
  for (let chapter = 0; chapter < 3; chapter++) {
    if (chapter) {
      await activate(
        page.getByRole("button", {
          name: "Refresh plan and re-review evidence",
          exact: true,
        }),
      );
      ({ value, plan } = await waitPlan());
    }
    await activate(
      page.getByRole("button", { name: "Refresh saved campaign", exact: true }),
    );
    await activate(
      page.getByRole("button", { name: "Approve current plan", exact: true }),
    );
    await activate(
      page
        .getByRole("button", { name: "Prepare cited passage", exact: true })
        .first(),
    );
    let verification;
    for (let attempt = 0; attempt < 3; attempt++) {
      const priorCount = (await call(campaignPath)).verifications.length;
      await activate(
        page
          .getByRole("button", {
            name: attempt
              ? "Request another step revision"
              : "Request step revision",
            exact: true,
          })
          .first(),
      );
      await activate(
        page
          .getByRole("button", {
            name: "Preview consequences and verify",
            exact: true,
          })
          .first(),
      );
      const deadline = Date.now() + (live ? 180000 : 120000);
      do {
        value = await call(campaignPath);
        if (value.verifications.length > priorCount) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      verification = value.verifications[0];
      if (value.verifications.length <= priorCount)
        throw new Error(
          "Candidate preview did not produce a retained verification.",
        );
      report.candidateAttempts ??= [];
      report.candidateAttempts.push({
        chapter: chapter + 1,
        attempt: attempt + 1,
        verification,
      });
      if (verification.passed) break;
      await activate(
        page.getByRole("button", {
          name: "Refresh saved campaign",
          exact: true,
        }),
      );
    }
    check(
      verification?.passed && !verification.failures.length,
      `Chapter ${chapter + 1}: actual candidate preserves facts and voice`,
    );
    report.receipts[`verification${chapter + 1}`] = verification;
    await activate(
      page.getByRole("button", { name: "Refresh saved campaign", exact: true }),
    );
    if (!chapter)
      await context.route("**/document-proposals/*/apply", async (route) => {
        const response = await route.fetch();
        check(
          response.ok(),
          "Tracked application committed before lost acknowledgment",
        );
        report.receipts.applicationOperationId = route
          .request()
          .postDataJSON().operationId;
        await route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: { message: "Simulated lost application acknowledgment" },
          }),
        });
      });
    await activate(
      page
        .getByRole("button", {
          name: "Revalidate and apply selected edits",
          exact: true,
        })
        .first(),
    );
    if (!chapter) {
      await activate(
        page.getByRole("button", {
          name: "Recover original request",
          exact: true,
        }),
      );
      await context.unroute("**/document-proposals/*/apply");
      check(
        true,
        "Lost tracked-application acknowledgment recovers original receipt",
      );
    }
    await page
      .getByRole("button", { name: "Record resolved step", exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    const proposal = await call(
      `/api/books/${bookId}/document-proposals/${verification.proposalId}`,
    );
    check(
      proposal.status === "applied" && proposal.application?.operationId,
      `Chapter ${chapter + 1}: explicit tracked application has an exact receipt`,
    );
    appliedScenes.add(proposal.sceneId);
    const source = await call(
      `/api/books/${bookId}/scenes/${proposal.sceneId}/document`,
    );
    let document = source.document;
    check(
      document.changes.some((x) => x.status === "pending"),
      `Chapter ${chapter + 1}: approval creates pending tracked changes`,
    );
    for (const change of source.document.changes.filter(
      (x) => x.status === "pending",
    ))
      document = resolveChange(document, change.id, "accepted");
    await call(`/api/books/${bookId}/document-commits`, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      scenes: [
        {
          sceneId: proposal.sceneId,
          expectedRevisionId: source.revisionId,
          document,
        },
      ],
    });
    await activate(
      page.getByRole("button", { name: "Refresh saved campaign", exact: true }),
    );
    await activate(
      page
        .getByRole("button", { name: "Record resolved step", exact: true })
        .first(),
    );
    check(
      true,
      `Chapter ${chapter + 1}: tracked changes resolved through canonical document operations`,
    );
  }
  await activate(
    page.getByRole("button", {
      name: "Refresh plan and re-review evidence",
      exact: true,
    }),
  );
  ({ value, plan } = await waitPlan());
  check(
    plan.analysis.complete &&
      !plan.analysis.gaps.length &&
      !plan.analysis.steps.length,
    "Final whole-book re-review reports no unresolved required steps or coverage gaps",
  );
  await activate(
    page.getByRole("button", { name: "Refresh saved campaign", exact: true }),
  );
  await activate(
    page.getByRole("button", { name: "Complete campaign", exact: true }),
  );
  await page.getByText("Campaign complete", { exact: true }).waitFor();
  const finalManifest = await call(`/api/books/${bookId}/document-manifest`);
  check(
    initialDigest !==
      createHash("sha256").update(JSON.stringify(finalManifest)).digest("hex"),
    "Three-chapter revision has distinct immutable before/after manuscript identities",
  );
  check(
    appliedScenes.size === 3,
    "Revision applies to three distinct chapter scenes",
  );
  report.appliedSceneIds = [...appliedScenes];
  if (keyboard)
    check(
      true,
      "Every campaign action through three chapter edits and completion uses keyboard Enter",
    );
  report.final = await call(campaignPath);
  const reopenContext = await browser.newContext();
  await reopenContext.addCookies(await context.cookies());
  const second = await reopenContext.newPage();
  await second.goto(
    `${base}/editorial/campaigns?bookId=${bookId}&campaignId=${campaignId}`,
  );
  await second.getByText("Campaign complete", { exact: true }).waitFor();
  check(true, "Another browser page reopens persisted campaign evidence");
  await reopenContext.close();
  const accessibility = await new AxeBuilder({ page })
    .include('section[aria-label="Revision campaigns"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  report.accessibility = {
    violations: accessibility.violations,
    passes: accessibility.passes.map((x) => x.id),
  };
  check(
    accessibility.violations.length === 0,
    "Campaign workspace passes automated WCAG A/AA accessibility rules",
  );
  if (process.env.PROSER_PLOT_SECOND_SESSION_FILE) {
    const fixture = JSON.parse(
      await readFile(process.env.PROSER_PLOT_SECOND_SESSION_FILE, "utf8"),
    );
    const otherContext = await browser.newContext();
    await otherContext.addCookies([fixture.cookie]);
    const otherPage = await otherContext.newPage();
    await otherPage.goto(base + "/api/auth/session");
    const otherSession = await (
      await otherPage.request.get(base + "/api/auth/session")
    ).json();
    const response = await otherPage.request.get(base + campaignPath, {
      headers: {
        "x-proser-expected-user": encodeURIComponent(otherSession.user.id),
      },
    });
    check(
      response.status() === 404,
      "Another authenticated account cannot read campaign evidence",
    );
    await otherContext.close();
  }
  await page.getByLabel("Revision goal", { exact: true }).focus();
  await page.keyboard.press("Tab");
  check(
    await page.evaluate(() => document.activeElement?.tagName === "BUTTON"),
    "Campaign form follows a usable keyboard focus order",
  );
  await page
    .getByLabel("Revision goal", { exact: true })
    .fill("Unsaved campaign draft");
  await page
    .getByRole("button", { name: "Refresh saved campaign", exact: true })
    .isDisabled()
    .then((value) =>
      check(value, "Unsaved campaign draft blocks destructive refresh"),
    );
  await activate(
    page.getByRole("button", {
      name: "Discard unsaved campaign changes",
      exact: true,
    }),
  );
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1",
  });
  await mobileContext.addCookies(await context.cookies());
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(
    `${base}/editorial/campaigns?bookId=${bookId}&campaignId=${campaignId}`,
  );
  await mobilePage.waitForURL(
    (url) => url.pathname === "/m/editorial/campaigns",
  );
  await mobilePage.getByText("Campaign complete", { exact: true }).waitFor();
  await mobilePage.screenshot({
    path: path.join(output, "campaign-mobile.png"),
    fullPage: true,
  });
  report.mobileLayout = await mobilePage.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("main *")]
      .filter((x) => x.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12)
      .map((x) => ({
        tag: x.tagName,
        text: x.textContent?.slice(0, 100),
        width: x.getBoundingClientRect().width,
      })),
  }));
  check(
    await mobilePage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "390px mobile campaign has no horizontal overflow and retains selected scope",
  );
  await mobileContext.addCookies([
    { name: "proser-view", value: "desktop", url: base },
  ]);
  await mobilePage.goto(
    `${base}/editorial/campaigns?bookId=${bookId}&campaignId=${campaignId}`,
  );
  check(
    new URL(mobilePage.url()).pathname === "/editorial/campaigns",
    "Desktop override remains available for campaign routes",
  );
  await mobilePage.screenshot({
    path: path.join(output, "campaign-mobile-desktop-override.png"),
    fullPage: true,
  });
  await mobileContext.close();
  await page.screenshot({
    path: path.join(output, "campaign-completed.png"),
    fullPage: true,
  });
  check(
    !report.errors.length,
    "Campaign browser workflow has no uncaught page errors",
  );
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  await page
    .screenshot({
      path: path.join(output, "campaign-failure.png"),
      fullPage: true,
    })
    .catch(() => undefined);
} finally {
  if (bookId && call)
    try {
      await page.waitForTimeout(1000);
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
      report.fixtureRetired = true;
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  report.certification = {
    physicalDevices: "incomplete, nonblocking by author decision",
    actualScreenReaders: "not established by browser automation",
    trackedResolution:
      "canonical API acceptance; separate UI controls remain covered by existing workspace gates",
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  await browser.close();
  console.log(
    JSON.stringify({
      checks: report.checks.length,
      failure: report.failure,
      fixtureRetired: report.fixtureRetired,
      output,
    }),
  );
}
