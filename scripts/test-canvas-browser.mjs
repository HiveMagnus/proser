import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  reserveCanvasOutput,
  startCanvasFixture,
  installCanvasWorkerProbe,
  verifyCanvasWorkers,
  settleCanvasFrame,
  closeCanvasFixture,
  waitForBrowserState,
} from "./canvas-browser-fixture.mjs";
const factory = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const { chromium } = factory("playwright");
const output = await reserveCanvasOutput(
  process.env.PROSER_CANVAS_BROWSER_OUTPUT ??
    fileURLToPath(
      new URL("../output/playwright/canvas-native/", import.meta.url),
    ),
);
const modules = [
  "document-passage-scope-journal",
  "document-rejected-edits",
  "document-layout-journal",
  "document-comment-journal",
  "document-layout-history",
  "document-history-navigation",
].map((name) =>
  fileURLToPath(
    new URL(`../ProserAuthor/apps/web/src/lib/${name}.ts`, import.meta.url),
  ),
);
let server;
let report = { passed: false, checks: [], fixtureMode: "production" };
let browser;
try {
  server = await startCanvasFixture({
    output,
    modules,
    // Native fixtures consume the checked generated contract source even in a
    // fresh checkout; application builds continue using the package's own build.
    alias: {
      "@cheftaco/proser-contracts": fileURLToPath(
        new URL(
          "../ProserAuthor/packages/contracts/src/index.ts",
          import.meta.url,
        ),
      ),
    },
    root: fileURLToPath(
      new URL("../ProserAuthor/packages/editor/browser/", import.meta.url),
    ),
  });
  report.fixtureAssets = server.assets;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await installCanvasWorkerProbe(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const externalImages = [];
  let ownedImages = 0;
  await page.route("**/api/images/42/content", async (route) => {
    ownedImages++;
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.route("https://image-probe.invalid/**", async (route) => {
    externalImages.push(route.request().url());
    await route.abort();
  });
  let ownedResponseSeen = false;
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/api/images/42/content" &&
      response.status() === 200
    )
      ownedResponseSeen = true;
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(
    () => Boolean(window.canvasAcceptance),
    undefined,
    {
      timeout: 20_000,
    },
  );
  const caretChecks = [];
  for (const property of ["bold", "italic", "underline", "strikeout"]) {
    for (const initial of [true, false]) {
      for (const toggles of [0, 1, 2, 3]) {
        await page.evaluate(
          ({ property, initial, toggles }) =>
            window.canvasAcceptance.mountCaretFormatting(
              property,
              initial,
              toggles,
            ),
          { property, initial, toggles },
        );
        await page.keyboard.type("Z");
        await page.waitForFunction(() =>
          window.canvasAcceptance
            .caretFormattingValue()
            .some((element) => element.value.includes("Z")),
        );
        const value = await page.evaluate(() =>
          window.canvasAcceptance.caretFormattingValue(),
        );
        const expected = initial !== Boolean(toggles % 2);
        const characters = value.flatMap((element) =>
          Array.from(element.value).map((character) => ({
            character,
            style: Boolean(element[property]),
          })),
        );
        if (
          characters.map(({ character }) => character).join("") !== "AZBC" ||
          characters.find(({ character }) => character === "Z")?.style !==
            expected ||
          characters
            .filter(({ character }) => character !== "Z")
            .some(({ style }) => style !== initial)
        )
          throw new Error(
            "Caret formatting toggle failed: " +
              JSON.stringify({ property, initial, toggles, expected, value }),
          );
        caretChecks.push({ property, initial, toggles, expected });
        await page.evaluate(() =>
          window.canvasAcceptance.unmountCaretFormatting(),
        );
      }
    }
  }
  const result = await page.evaluate(() => window.canvasAcceptance.run());
  result.identityChecks = await page.evaluate(() =>
    window.canvasAcceptance.identityAcceptance(),
  );
  result.checks.push(
    "explicit synchronous/worker identity retention, native repeated paste uniqueness, independent pasted-cell edits, undo/redo and recreation",
  );
  result.caretFormattingChecks = caretChecks;
  result.checks.push(
    "native caret bold/italic/underline/strikeout toggle pending input formatting without modifying surrounding text",
  );
  result.scopeJournalChecks = await page.evaluate(
    async (modulePath) => {
      const journal = await import(modulePath);
      const verify = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const userId = "bounded-scope-browser-" + crypto.randomUUID(),
        bookId = "1",
        sceneIds = [4, 5];
      const key = journal.passageScopeJournalKey(userId, bookId, sceneIds);
      const request = {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevisionId: "source-book",
        kind: "move-blocks",
        source: { sceneId: 4 },
        destination: { sceneId: 5 },
        blocks: [{ blockId: "owned-whole-block", sourceHash: "a".repeat(64) }],
        placement: "end",
      };
      const row = {
        key,
        userId,
        bookId,
        sceneIds,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        history: [],
        redo: [],
        pending: { kind: "transfer", request },
      };
      await journal.writePassageScopeJournal(row);
      verify(
        !(await journal.readPassageScopeJournal(
          "other-user",
          bookId,
          sceneIds,
        )),
        "Cross-account scoped journal was exposed.",
      );
      verify(
        !(await journal.readPassageScopeJournal(userId, bookId, [4, 6])),
        "Cross-window scoped journal was exposed.",
      );
      verify(
        JSON.stringify(
          (await journal.readPassageScopeJournal(userId, bookId, sceneIds))
            .pending,
        ) === JSON.stringify(row.pending),
        "Exact pending scope request changed.",
      );
      let rejected = false;
      try {
        await journal.writePassageScopeJournal(
          { ...row, version: crypto.randomUUID() },
          "wrong-version",
        );
      } catch {
        rejected = true;
      }
      verify(
        rejected,
        "Competing-tab scope mutation overwrote the retained operation.",
      );
      rejected = false;
      try {
        await journal.writePassageScopeJournal(
          {
            ...row,
            version: crypto.randomUUID(),
            pending: {
              ...row.pending,
              request: { ...request, placement: "start" },
            },
          },
          row.version,
        );
      } catch {
        rejected = true;
      }
      verify(rejected, "An unknown scope operation was silently replaced.");
      rejected = false;
      try {
        await journal.writePassageScopeJournal(
          { ...row, version: crypto.randomUUID(), pending: undefined },
          row.version,
          crypto.randomUUID(),
        );
      } catch {
        rejected = true;
      }
      verify(
        rejected,
        "An unrelated receipt cleared the retained scope operation.",
      );
      const acknowledged = {
        ...row,
        version: crypto.randomUUID(),
        pending: undefined,
        history: [
          {
            beforeBookRevisionId: "source-book",
            afterBookRevisionId: "committed-book",
            sceneIds,
          },
        ],
      };
      await journal.writePassageScopeJournal(
        acknowledged,
        row.version,
        request.operationId,
      );
      const saved = await journal.readPassageScopeJournal(
        userId,
        bookId,
        sceneIds,
      );
      verify(
        !saved.pending &&
          saved.history[0].afterBookRevisionId === "committed-book",
        "Acknowledged scope history lost exact immutable references.",
      );
      const expired = {
        ...acknowledged,
        version: crypto.randomUUID(),
        updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      };
      await journal.writePassageScopeJournal(expired, acknowledged.version);
      verify(
        !(await journal.readPassageScopeJournal(userId, bookId, sceneIds)),
        "Expired scoped history was exposed.",
      );
      verify(
        !JSON.stringify(saved).includes("document"),
        "Scoped operation history retained complete scene bodies.",
      );
      return [
        "scope journal exact request recovery",
        "scope journal authenticated identity and scene isolation",
        "scope journal competing-tab CAS",
        "unknown scope request preservation",
        "exact scope acknowledgement proof",
        "immutable sparse scope history",
        "scope journal thirty-day retention",
      ];
    },
    server.moduleUrl(
      fileURLToPath(
        new URL(
          "../ProserAuthor/apps/web/src/lib/document-passage-scope-journal.ts",
          import.meta.url,
        ),
      ),
    ),
  );
  result.checks.push(
    "native IndexedDB sparse scope journal fences competing tabs, unknown operations and incorrect acknowledgements",
  );
  await page.evaluate(() => window.canvasAcceptance.mountReadOnlyStories());
  await page
    .locator('[aria-label="Page editing surface"] canvas')
    .first()
    .dblclick({ position: { x: 150, y: 35 } });
  await page.keyboard.type("BLOCKED STORY EDIT");
  const ownedStoryProof = await page.evaluate(() => ({
    value: window.canvasAcceptance.controlled(),
    errors: window.canvasAcceptance.storyErrors(),
  }));
  if (
    ownedStoryProof.value.text !== ownedStoryProof.value.original ||
    ownedStoryProof.value.document.layout.header[0].runs[0].text !==
      "Owned header story" ||
    !ownedStoryProof.errors.some((value) => value.includes("Page setup"))
  )
    throw new Error(
      "Read-only owned story attempt changed the body/header or omitted its editing guidance.",
    );
  result.checks.push(
    "owned header/footer pointer and typing attempts preserve story and body data with explicit Page setup guidance",
  );
  const imagePolicy = await page.evaluate(() =>
    window.canvasAcceptance.imageSourceProof(),
  );
  result.checks.push(
    "document image policy prevents external fetches before paste/render/history validation and preserves owned assets",
  );
  await waitForBrowserState(
    async () => ownedResponseSeen,
    (seen) => seen,
    "the owned fixture image response",
  );
  await settleCanvasFrame(page);
  if (externalImages.length || !ownedImages || !imagePolicy.owned)
    throw new Error(
      "Document image source policy failed: " +
        JSON.stringify({ externalImages, ownedImages, imagePolicy }),
    );

  await page.evaluate(() => window.canvasAcceptance.mountNamed());
  await page
    .locator('[aria-label="Page editing surface"] canvas')
    .first()
    .click({ position: { x: 160, y: 112 } });
  await page.keyboard.press("Control+a");
  await page.waitForFunction(
    () =>
      window.canvasAcceptance.controlled().selection?.targets[0]?.sourceText ===
      "Inherited named style",
  );
  await page.keyboard.press("Control+b");
  await page.waitForFunction(() =>
    window.canvasAcceptance
      .controlled()
      .document.blocks[0].runs.some((run) => run.style.bold === false),
  );
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.waitForFunction(() =>
    window.canvasAcceptance
      .controlled()
      .document.blocks[0].runs.some((run) => run.style.bold === true),
  );
  const styled = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    styled.text !== styled.original ||
    styled.document.blocks[0].style.name !== "chapter_style" ||
    !styled.document.blocks[0].runs.every(
      (run) => run.style.characterStyleId === "character_child",
    )
  )
    throw new Error("Named formatting keyboard/toolbar lost reference or text");
  result.checks.push(
    "leading paragraph sentinel keyboard and owned toolbar toggle named formatting without losing references",
  );
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await page.waitForFunction(() =>
    window.canvasAcceptance
      .controlled()
      .document.blocks[0].runs.every(
        (run) => run.style.highlight === "#ffff00",
      ),
  );
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await page.waitForFunction(() =>
    window.canvasAcceptance
      .controlled()
      .document.blocks[0].runs.every(
        (run) => run.style.highlight === undefined,
      ),
  );
  const highlighted = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    highlighted.text !== highlighted.original ||
    highlighted.document.blocks[0].style.name !== "chapter_style" ||
    !highlighted.document.blocks[0].runs.every(
      (run) => run.style.characterStyleId === "character_child",
    )
  )
    throw new Error(
      "Highlight toggle changed source text or named style references.",
    );
  result.checks.push(
    "owned highlight toggle applies yellow and clears it while preserving source text and named styles",
  );
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Paragraph 1", exact: true }).focus();
  await page.getByLabel("More formatting", { exact: true }).click();
  await page.getByLabel("Space before", { exact: true }).fill("18");
  await page.getByLabel("Space before", { exact: true }).press("Enter");
  await page.getByLabel("First line indent", { exact: true }).fill("-12");
  await page.getByLabel("First line indent", { exact: true }).press("Enter");
  await page.getByLabel("Keep with next paragraph", { exact: true }).check();
  await page.getByLabel("Start paragraph on new page", { exact: true }).check();
  const paragraphStyle = await page.evaluate(
    () => window.canvasAcceptance.controlled().document.blocks[0].style,
  );
  if (
    paragraphStyle.name !== "chapter_style" ||
    paragraphStyle.before !== 18 ||
    paragraphStyle.firstLineIndent !== -12 ||
    !paragraphStyle.keepWithNext ||
    !paragraphStyle.pageBreakBefore
  )
    throw new Error(
      "Semantic paragraph layout controls lost inherited style or direct properties",
    );
  result.checks.push(
    "semantic paragraph spacing indentation and pagination controls preserve named style",
  );
  for (const kind of ["paragraph", "table"]) {
    await page.evaluate(
      (kind) => window.canvasAcceptance.mountOversized(kind),
      kind,
    );
    await page
      .getByRole("button", { name: "Next passage", exact: true })
      .click();
    await page.waitForFunction(() => {
      const previous = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Previous passage",
      );
      return previous && !previous.disabled;
    });
    const canvas = page
      .locator('[aria-label="Page editing surface"] canvas')
      .first();
    await canvas.click({ position: { x: 80, y: 100 } });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type(" SLICED ");
    await page.waitForFunction(
      () =>
        window.canvasAcceptance.controlled().text.includes(" SLICED ") &&
        window.canvasAcceptance.controlled().text.replace(" SLICED ", "") ===
          window.canvasAcceptance.controlled().original,
    );
    // Native content events and the parent metadata-binding layout effect must
    // finish before a new selection is sent to the replaced passage surface.
    await settleCanvasFrame(page);
    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForFunction(() =>
      Boolean(window.canvasAcceptance.controlled().selection?.targets?.length),
    );
    const edited = await page.evaluate(() =>
      window.canvasAcceptance.controlled(),
    );
    if (
      !edited.text.includes(" SLICED ") ||
      edited.text.replace(" SLICED ", "") !== edited.original
    )
      throw new Error(
        "Oversized " +
          kind +
          " edit lost exact source outside its slice. " +
          JSON.stringify({
            length: edited.text.length,
            originalLength: edited.original.length,
            errors,
            marker: edited.text.indexOf(" SLICED "),
            text: edited.text.slice(2200, 2600),
          }),
      );
    if (
      !edited.selection?.targets?.length ||
      edited.selection.targets[0].from < 2000
    )
      throw new Error(
        "Oversized " +
          kind +
          " selection retained runtime rather than canonical offsets.",
      );
    if (kind === "table") {
      const table = edited.document.blocks[0];
      if (
        table.widths.join(",") !== "130,170" ||
        table.rows[0].cells.length !== 2 ||
        table.rows[0].cells[1].paragraphs[0].runs[0].text !==
          "Protected neighbour"
      )
        throw new Error(
          "Oversized table edit flattened topology or neighbouring content.",
        );
    }
    await page
      .getByRole("button", { name: "Previous passage", exact: true })
      .click();
    result.checks.push(
      "oversized " +
        kind +
        " native text slice exact source and canonical selection preservation",
    );
  }
  await page.evaluate(() => window.canvasAcceptance.unmountControlled());
  const rejectedModule = fileURLToPath(
    new URL(
      "../ProserAuthor/apps/web/src/lib/document-rejected-edits.ts",
      import.meta.url,
    ),
  );
  const rejectedChecks = await page.evaluate(async (modulePath) => {
    const journal = await import(modulePath);
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const base = window.canvasAcceptance.controlled().document;
    const userId = "raw-" + crypto.randomUUID();
    const scope = { kind: "scene", id: "42" };
    const row = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      userId,
      bookId: "1",
      scope,
      updatedAt: Date.now(),
      baseRevisionId: "exact-base",
      baseContentHash: "a".repeat(64),
      editorVersion: "1.0.4-proser.2",
      canonicalBase: base,
      nativeValue: { unsupported: { colspan: 2 } },
      error: "Unsupported merge",
    };
    await journal.writeRejectedDocumentEdit(row);
    assert(
      !(await journal.readRejectedDocumentEdit(userId + "other", "1", scope)),
      "Raw quarantine leaked across authenticated users",
    );
    assert(
      !(await journal.readRejectedDocumentEdit(userId, "1", {
        kind: "layout-story",
        id: "42",
      })),
      "Raw quarantine leaked across story scopes",
    );
    const retained = await journal.readRejectedDocumentEdit(userId, "1", scope);
    assert(
      JSON.stringify(retained.nativeValue) ===
        JSON.stringify(row.nativeValue) &&
        retained.baseRevisionId === row.baseRevisionId,
      "Raw quarantine lost original unsupported value/source",
    );
    let conflict = false;
    try {
      await journal.writeRejectedDocumentEdit({
        ...row,
        id: crypto.randomUUID(),
      });
    } catch {
      conflict = true;
    }
    assert(
      conflict,
      "Competing raw quarantine silently overwrote an unknown edit",
    );
    await journal.deleteRejectedDocumentEdit(userId, "1", scope, "stale-id");
    assert(
      await journal.readRejectedDocumentEdit(userId, "1", scope),
      "Stale raw discard erased a newer edit",
    );
    await journal.deleteRejectedDocumentEdit(userId, "1", scope, row.id);
    assert(
      !(await journal.readRejectedDocumentEdit(userId, "1", scope)),
      "Explicit raw discard failed",
    );
    await journal.writeRejectedDocumentEdit({
      ...row,
      updatedAt: Date.now() - 31 * 86400000,
    });
    assert(
      !(await journal.readRejectedDocumentEdit(userId, "1", scope)),
      "Expired raw quarantine remained visible",
    );
    return [
      "raw quarantine ownership and story isolation",
      "exact unsupported value and source preservation",
      "competing-tab CAS",
      "stale discard fencing",
      "explicit discard and thirty-day retention",
    ];
  }, server.moduleUrl(rejectedModule));
  const layoutJournal = fileURLToPath(
    new URL(
      "../ProserAuthor/apps/web/src/lib/document-layout-journal.ts",
      import.meta.url,
    ),
  );
  const layoutChecks = await page.evaluate(async (modulePath) => {
    const journal = await import(modulePath);
    const assert = (value, message) => {
      if (!value) throw new Error(message);
    };
    const pageLayout = {
      preset: "manuscript",
      width: 794,
      height: 1123,
      margins: [76, 76, 76, 76],
      font: "Georgia",
      fontSize: 16,
      pageNumbers: true,
      header: [],
      footer: [],
    };
    const layout = {
      schemaVersion: 1,
      book: pageLayout,
      chapters: {},
      frontMatter: [],
      backMatter: [],
      styles: { text: {}, paragraph: {} },
    };
    const row = {
      schemaVersion: 1,
      userId: "layout-fixture-owner",
      bookId: crypto.randomUUID(),
      journalRevision: crypto.randomUUID(),
      updatedAt: Date.now(),
      baseRevisionId: crypto.randomUUID(),
      baseLayoutRevisionId: crypto.randomUUID(),
      layout,
      baseLayout: structuredClone(layout),
    };
    await journal.writeLayoutDraft(row);
    assert(
      (await journal.readLayoutDraft(row.userId, row.bookId))
        .journalRevision === row.journalRevision,
      "Layout recovery did not retain its exact journal revision.",
    );
    assert(
      (await journal.readLayoutDraft("another-fixture-owner", row.bookId)) ===
        undefined,
      "Layout draft leaked across accounts.",
    );
    let rejected = false;
    try {
      await journal.writeLayoutDraft({
        ...row,
        journalRevision: crypto.randomUUID(),
      });
    } catch {
      rejected = true;
    }
    assert(
      rejected,
      "A competing first write replaced another tab's layout draft.",
    );
    const next = {
      ...row,
      journalRevision: crypto.randomUUID(),
      layout: { ...layout, book: { ...pageLayout, font: "Liberation Serif" } },
    };
    await journal.writeLayoutDraft(next, row.journalRevision);
    const pending = {
      ...next,
      journalRevision: crypto.randomUUID(),
      pending: {
        schemaVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevisionId: row.baseRevisionId,
        expectedScopes: { layout: row.baseLayoutRevisionId },
        layout: next.layout,
      },
    };
    await journal.writeLayoutDraft(pending, next.journalRevision);
    rejected = false;
    try {
      await journal.writeLayoutDraft(
        {
          ...pending,
          journalRevision: crypto.randomUUID(),
          pending: { ...pending.pending, operationId: crypto.randomUUID() },
        },
        pending.journalRevision,
      );
    } catch {
      rejected = true;
    }
    assert(
      rejected,
      "An unresolved layout operation was replaced by a different request.",
    );
    await journal.deleteLayoutDraft(
      row.userId,
      row.bookId,
      pending.pending.operationId,
      "obsolete-journal-version",
    );
    assert(
      (await journal.readLayoutDraft(row.userId, row.bookId)).pending
        .operationId === pending.pending.operationId,
      "Stale layout acknowledgement deleted current recovery.",
    );
    await journal.deleteLayoutDraft(
      row.userId,
      row.bookId,
      pending.pending.operationId,
      pending.journalRevision,
    );
    assert(
      (await journal.readLayoutDraft(row.userId, row.bookId)) === undefined,
      "Acknowledged layout recovery was retained.",
    );
    const storyPending = {
      ...row,
      bookId: crypto.randomUUID(),
      journalRevision: crypto.randomUUID(),
      pendingStory: {
        storyId: "header-fixture",
        request: {
          schemaVersion: 1,
          operationId: crypto.randomUUID(),
          expectedRevisionId: row.baseRevisionId,
          expectedLayoutRevisionId: row.baseLayoutRevisionId,
          expectedContentHash: "a".repeat(64),
          operations: [
            {
              kind: "fixture-original-intent",
              operationId: crypto.randomUUID(),
            },
          ],
        },
      },
    };
    await journal.writeLayoutDraft(storyPending);
    assert(
      JSON.stringify(
        (await journal.readLayoutDraft(row.userId, storyPending.bookId))
          .pendingStory,
      ) === JSON.stringify(storyPending.pendingStory),
      "Prepared story request did not survive browser journal read.",
    );
    for (const replacement of [
      {
        ...storyPending,
        pendingStory: {
          ...storyPending.pendingStory,
          request: { ...storyPending.pendingStory.request, operations: [] },
        },
      },
      { ...storyPending, pendingStory: undefined, pending: pending.pending },
    ]) {
      rejected = false;
      try {
        await journal.writeLayoutDraft(
          { ...replacement, journalRevision: crypto.randomUUID() },
          storyPending.journalRevision,
        );
      } catch {
        rejected = true;
      }
      assert(
        rejected,
        "Uncertain story operation was replaced by a changed intent or competing layout save.",
      );
    }
    await journal.deleteLayoutDraft(
      row.userId,
      storyPending.bookId,
      crypto.randomUUID(),
      storyPending.journalRevision,
    );
    assert(
      Boolean(await journal.readLayoutDraft(row.userId, storyPending.bookId)),
      "Foreign operation acknowledgement deleted prepared story recovery.",
    );
    await journal.deleteLayoutDraft(
      row.userId,
      storyPending.bookId,
      storyPending.pendingStory.request.operationId,
      storyPending.journalRevision,
    );
    assert(
      (await journal.readLayoutDraft(row.userId, storyPending.bookId)) ===
        undefined,
      "Exact acknowledged story operation was not cleared.",
    );
    const expired = {
      ...row,
      bookId: crypto.randomUUID(),
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };
    await journal.writeLayoutDraft(expired);
    assert(
      (await journal.readLayoutDraft(expired.userId, expired.bookId)) ===
        undefined,
      "Expired layout recovery remained visible.",
    );
    return [
      "layout journal ownership",
      "layout competing-tab CAS",
      "layout exact pending request",
      "layout stale acknowledgement",
      "layout acknowledged deletion",
      "layout thirty-day retention",
      "story original intent restart recovery",
      "story uncertain request replacement refusal",
      "story exact acknowledgement deletion",
    ];
  }, server.moduleUrl(layoutJournal));

  const commentJournal = fileURLToPath(
    new URL(
      "../ProserAuthor/apps/web/src/lib/document-comment-journal.ts",
      import.meta.url,
    ),
  );
  const commentChecks = await page.evaluate(async (modulePath) => {
    const journal = await import(modulePath);
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const row = {
      schemaVersion: 1,
      userId: "comment-fixture-owner",
      bookId: crypto.randomUUID(),
      scope: { kind: "scene", id: "1" },
      commentId: "comment",
      updatedAt: Date.now(),
      request: {
        operationId: crypto.randomUUID(),
        expectedRevisionId: crypto.randomUUID(),
        expectedSceneRevisionId: crypto.randomUUID(),
        action: "resolved",
      },
    };
    await journal.writeDocumentCommentIntent(row);
    assert(
      !(await journal.readDocumentCommentIntent(
        "another-owner",
        row.bookId,
        row.scope,
      )),
      "Comment operation crossed authenticated identities.",
    );
    assert(
      !(await journal.readDocumentCommentIntent(row.userId, row.bookId, {
        kind: "layout-story",
        id: "1",
      })),
      "Scene comment operation crossed story scopes.",
    );
    assert(
      JSON.stringify(
        (
          await journal.readDocumentCommentIntent(
            row.userId,
            row.bookId,
            row.scope,
          )
        ).request,
      ) === JSON.stringify(row.request),
      "Comment recovery changed exact request.",
    );
    let rejected = false;
    try {
      await journal.writeDocumentCommentIntent({
        ...row,
        request: { ...row.request, operationId: crypto.randomUUID() },
      });
    } catch {
      rejected = true;
    }
    assert(rejected, "Competing tab replaced unknown comment operation.");
    await journal.deleteDocumentCommentIntent(
      row.userId,
      row.bookId,
      row.scope,
      "obsolete-operation",
    );
    assert(
      Boolean(
        await journal.readDocumentCommentIntent(
          row.userId,
          row.bookId,
          row.scope,
        ),
      ),
      "Stale acknowledgement deleted current comment operation.",
    );
    await journal.deleteDocumentCommentIntent(
      row.userId,
      row.bookId,
      row.scope,
      row.request.operationId,
    );
    assert(
      !(await journal.readDocumentCommentIntent(
        row.userId,
        row.bookId,
        row.scope,
      )),
      "Acknowledged comment operation remained recoverable.",
    );
    const expired = {
      ...row,
      bookId: crypto.randomUUID(),
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };
    await journal.writeDocumentCommentIntent(expired);
    assert(
      !(await journal.readDocumentCommentIntent(
        expired.userId,
        expired.bookId,
        expired.scope,
      )),
      "Expired comment recovery remained visible.",
    );
    return [
      "comment journal authenticated ownership",
      "comment scene/story isolation",
      "comment exact request recovery",
      "comment competing-tab CAS",
      "comment stale acknowledgement fence",
      "comment acknowledged deletion",
      "comment thirty-day retention",
    ];
  }, server.moduleUrl(commentJournal));

  const layoutHistoryPath = fileURLToPath(
    new URL(
      "../ProserAuthor/apps/web/src/lib/document-layout-history.ts",
      import.meta.url,
    ),
  );
  const layoutHistoryChecks = await page.evaluate(async (modulePath) => {
    const history = await import(modulePath);
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const page = {
      preset: "book",
      width: 600,
      height: 800,
      margins: [40, 40, 40, 40],
      font: "Georgia",
      fontSize: 16,
      pageNumbers: true,
      header: [],
      footer: [],
    };
    const original = {
      schemaVersion: 1,
      book: page,
      chapters: {},
      frontMatter: [],
      backMatter: [],
      styles: { text: {}, paragraph: {} },
    };
    const row = {
      schemaVersion: 1,
      userId: "layout-history-owner",
      bookId: crypto.randomUUID(),
      version: crypto.randomUUID(),
      updatedAt: Date.now(),
      cursor: 0,
      frames: [{ layout: original, revisionId: crypto.randomUUID() }],
    };
    await history.writeLayoutHistory(row);
    assert(
      !(await history.readLayoutHistory("another-owner", row.bookId)),
      "Layout undo history crossed authenticated identities.",
    );
    const changed = structuredClone(original);
    changed.book.fontSize = 18;
    const appended = history.appendLayoutHistory(row, changed);
    await history.writeLayoutHistory(appended, row.version);
    const stored = await history.readLayoutHistory(row.userId, row.bookId);
    assert(
      stored.frames[0].revisionId === row.frames[0].revisionId &&
        stored.frames[1].revisionId === undefined &&
        stored.cursor === 1,
      "Unsaved layout frame invented an owned revision or dropped saved proof.",
    );
    let rejected = false;
    try {
      await history.writeLayoutHistory(row, row.version);
    } catch {
      rejected = true;
    }
    assert(
      rejected,
      "Competing-tab layout history silently overwrote a newer journal.",
    );
    const expired = {
      ...row,
      bookId: crypto.randomUUID(),
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };
    await history.writeLayoutHistory(expired);
    assert(
      !(await history.readLayoutHistory(expired.userId, expired.bookId)),
      "Expired layout undo history remained visible.",
    );
    const replacement = {
      ...expired,
      version: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    await history.writeLayoutHistory(replacement);
    assert(
      Boolean(
        await history.readLayoutHistory(replacement.userId, replacement.bookId),
      ),
      "Expired history blocked a new authenticated journal.",
    );
    return [
      "layout undo ownership",
      "layout exact saved revision proof",
      "layout provisional frames remain unowned",
      "layout history competing-tab CAS",
      "layout history thirty-day retention",
      "layout expired journal renewal",
    ];
  }, server.moduleUrl(layoutHistoryPath));
  let profileSession;
  if (process.env.PROFILE_CANVAS) {
    profileSession = await page.context().newCDPSession(page);
    await profileSession.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await profileSession.send("Profiler.enable");
    await profileSession.send("Profiler.start");
  }
  await page.evaluate(() => window.canvasAcceptance.mountControlled());
  await page
    .locator("canvas")
    .first()
    .click({ position: { x: 110, y: 115 } });
  const marker = " Perf0123456789ab".repeat(3);
  for (const character of marker) {
    await page.keyboard.insertText(character);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
  }
  await page.waitForFunction(
    (marker) => window.canvasAcceptance.controlled().text.includes(marker),
    marker,
  );
  if (profileSession) {
    const { profile } = await profileSession.send("Profiler.stop");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const directory = resolve(output, "profile");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "canvas-input.cpuprofile"),
      JSON.stringify(profile),
    );
    const totals = new Map();
    const nodes = new Map(
      profile.nodes.map((node) => [node.id, node.callFrame]),
    );
    profile.samples.forEach((sample, index) => {
      const frame = nodes.get(sample);
      const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").slice(-2).join("/")} ${frame.lineNumber + 1}`;
      totals.set(
        key,
        (totals.get(key) || 0) + profile.timeDeltas[index] / 1000,
      );
    });
    process.stderr.write(
      JSON.stringify([...totals].sort((a, b) => b[1] - a[1]).slice(0, 25)) +
        "\n",
    );
  }
  const controlled = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    !controlled.text.includes(marker) ||
    controlled.text.replace(marker, "") !== controlled.original
  )
    throw new Error(
      `Controlled Canvas input failed exact preservation: ${JSON.stringify(controlled.text.slice(0, 250))}`,
    );
  result.checks.push(
    "controlled Canvas first character and three repeated markers preserve exact original text",
  );
  await page
    .getByRole("combobox", { name: "Scene passage", exact: true })
    .selectOption("19");
  await page
    .locator("canvas")
    .first()
    .click({ position: { x: 110, y: 115 } });
  const lastMarker = " LastPassage😀";
  await page.keyboard.insertText(lastMarker);
  await page.waitForFunction(
    (marker) => window.canvasAcceptance.controlled().text.includes(marker),
    lastMarker,
  );
  const lastPassage = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    !lastPassage.text.includes(lastMarker) ||
    lastPassage.text.replace(marker, "").replace(lastMarker, "") !==
      lastPassage.original
  )
    throw new Error("Passage navigation lost offscreen canonical content.");
  await page.getByText("Find in text", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search document", exact: true })
    .fill("w0_0_5");
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Scene passage"]').value === "0",
  );
  result.checks.push(
    "bounded passage navigation and scene-wide search preserve offscreen canonical text",
  );
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const firstField = page.getByRole("textbox", {
    name: "Paragraph 1",
    exact: true,
  });
  await firstField.focus();
  await firstField.evaluate((field) => {
    field.setSelectionRange(4, 4);
    field.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Page editor", exact: true }).click();
  const switchMarker = "ModeSwitch😀";
  await page.keyboard.insertText(switchMarker);
  await page.waitForFunction(
    (marker) => window.canvasAcceptance.controlled().text.includes(marker),
    switchMarker,
  );
  const switched = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    !switched.text.startsWith("w0_0" + switchMarker + "_0") ||
    switched.text
      .replace(marker, "")
      .replace(lastMarker, "")
      .replace(switchMarker, "") !== switched.original
  )
    throw new Error(
      `Semantic-to-Canvas switch lost its stable UTF16 caret or canonical text: ${switched.text.slice(0, 220)}`,
    );
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const restored = await firstField.evaluate((field) => ({
    focused: field === document.activeElement,
    from: field.selectionStart,
    to: field.selectionEnd,
  }));
  if (
    !restored.focused ||
    restored.from !== 4 + switchMarker.length ||
    restored.to !== restored.from
  )
    throw new Error(
      "Canvas-to-semantic switch lost its canonical caret/focus.",
    );
  result.checks.push(
    "Canvas and semantic mode switches restore stable UTF16 caret and keyboard focus",
  );
  await page.getByRole("button", { name: "Page editor", exact: true }).click();
  const beforeBoundary = await page.evaluate(
    () => window.canvasAcceptance.controlled().text,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (before) =>
      window.canvasAcceptance.controlled().text !== before &&
      window.canvasAcceptance.controlled().text.replace("\n\n", "") === before,
    beforeBoundary,
  );
  const splitBoundary = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (splitBoundary.text.replace("\n\n", "") !== beforeBoundary)
    throw new Error(
      "Native Enter lost text instead of splitting the canonical paragraph.",
    );
  await page.keyboard.press("Backspace");
  await page.waitForFunction(
    (before) => window.canvasAcceptance.controlled().text === before,
    beforeBoundary,
  );
  const joinedBoundary = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (joinedBoundary.text !== beforeBoundary)
    throw new Error(
      `Native Backspace did not join the canonical paragraph boundary: ${JSON.stringify({ before: beforeBoundary.slice(0, 100), after: joinedBoundary.text.slice(0, 100), changes: joinedBoundary.document.changes.slice(-2), blocks: joinedBoundary.document.blocks.slice(0, 3) })}`,
    );
  const afterJoinMarker = "AfterNativeJoin";
  await page.keyboard.insertText(afterJoinMarker);
  await page.waitForFunction(
    (marker) => window.canvasAcceptance.controlled().text.includes(marker),
    afterJoinMarker,
  );
  const afterJoin = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (afterJoin.text.replace(afterJoinMarker, "") !== beforeBoundary)
    throw new Error("Typing after native split/join lost canonical text.");
  result.checks.push(
    "native Enter and Backspace preserve canonical physical identities and typing through external metadata bindings",
  );
  const compositionBefore = await page.evaluate(
    () => window.canvasAcceptance.controlled().text,
  );
  const inputSession = await page.context().newCDPSession(page);
  await inputSession.send("Input.imeSetComposition", {
    text: "漢",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .waitFor();
  if (
    !(await page
      .getByRole("button", { name: "Accessible editor", exact: true })
      .isDisabled())
  )
    throw new Error("Canvas composition did not protect mode switching.");
  if (
    (await page.evaluate(() => window.canvasAcceptance.controlled().text)) !==
    compositionBefore
  )
    throw new Error(
      "Intermediate Canvas composition escaped into canonical authority.",
    );
  await inputSession.send("Input.insertText", { text: "漢字" });
  await page.waitForFunction(() =>
    window.canvasAcceptance.controlled().text.includes("漢字"),
  );
  const composed = await page.evaluate(
    () => window.canvasAcceptance.controlled().text,
  );
  if (
    composed.replace("漢字", "") !== compositionBefore ||
    (await page
      .getByRole("button", { name: "Accessible editor", exact: true })
      .isDisabled())
  )
    throw new Error(
      "Canvas IME completion lost exact text or retained a stale composition fence.",
    );
  result.checks.push(
    "native Chromium IME keeps intermediate input fenced and commits exact completed composition",
  );
  await page.evaluate(() => window.canvasAcceptance.mountControlled(true));
  await page
    .getByRole("button", { name: "Touch selection", exact: true })
    .click();
  const rectangle = await page.locator("canvas").first().boundingBox();
  await inputSession.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const touch = (x, y) => ({
    x: rectangle.x + x,
    y: rectangle.y + y,
    radiusX: 2,
    radiusY: 2,
    force: 1,
    id: 1,
  });
  await inputSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touch(45, 35)],
  });
  await inputSession.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [touch(160, 35)],
  });
  await inputSession.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForFunction(() =>
    window.canvasAcceptance
      .controlled()
      .selection?.targets.some((target) => Boolean(target.sourceText)),
  );
  const touched = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    !touched.selection?.targets.length ||
    touched.selection.targets.every((target) => !target.sourceText) ||
    touched.text !== touched.original
  )
    throw new Error(
      "Trusted touch drag did not retain a canonical text selection without mutating content.",
    );
  result.checks.push(
    "native Chromium touch drag selects stable canonical spans without writing content",
  );
  await inputSession.send("Emulation.setTouchEmulationEnabled", {
    enabled: false,
  });
  await inputSession.detach();
  await page.evaluate(() => window.canvasAcceptance.unmountControlled());
  await page.evaluate(() => window.canvasAcceptance.mountControlled());
  await page
    .getByRole("checkbox", { name: "Track my edits", exact: true })
    .check();
  await page
    .locator("canvas")
    .first()
    .click({ position: { x: 110, y: 115 } });
  const trackedMarker = "TrackedTyping";
  for (const character of trackedMarker) {
    await page.keyboard.insertText(character);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
  }
  await page.waitForFunction(
    (marker) => window.canvasAcceptance.controlled().text.includes(marker),
    trackedMarker,
  );
  const tracked = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    !tracked.text.includes(trackedMarker) ||
    tracked.text.replace(trackedMarker, "") !== tracked.original ||
    tracked.document.changes.filter(
      (change) => change.kind === "insertion" && change.status === "pending",
    ).length !== 1
  )
    throw new Error(
      "Manual tracked typing failed exact preservation or durable same-change continuation.",
    );
  await page
    .getByRole("combobox", { name: "Review view", exact: true })
    .selectOption("original");
  await page
    .getByRole("button", { name: "Accessible editor", exact: true })
    .click();
  const originalVisible = await page
    .getByRole("article", { name: "Semantic manuscript", exact: true })
    .innerText();
  if (originalVisible.includes(trackedMarker))
    throw new Error("Original view displayed pending manual insertions.");
  result.checks.push(
    "authenticated manual typing retains one durable pending insertion and original view reverses it",
  );
  await page.evaluate(() => window.canvasAcceptance.unmountControlled());
  await page.evaluate(() => window.canvasAcceptance.mountControlled());
  await page
    .getByRole("checkbox", { name: "Track my edits", exact: true })
    .check();
  await page
    .locator("canvas")
    .first()
    .click({ position: { x: 110, y: 115 } });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    window.canvasAcceptance
      .controlled()
      .document.changes.some(
        (change) =>
          change.kind === "paragraphSplit" && change.status === "pending",
      ),
  );
  const trackedSplit = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  await page.keyboard.insertText("BoundaryTyping");
  await page.waitForFunction(() =>
    window.canvasAcceptance.controlled().text.includes("BoundaryTyping"),
  );
  const trackedSplitTyping = await page.evaluate(() =>
    window.canvasAcceptance.controlled(),
  );
  if (
    trackedSplitTyping.text.replace("BoundaryTyping", "") !==
      trackedSplit.text ||
    trackedSplitTyping.originalView !== trackedSplitTyping.original ||
    !trackedSplitTyping.document.changes.some(
      (change) =>
        change.kind === "paragraphSplit" && change.status === "pending",
    ) ||
    !trackedSplitTyping.document.changes.some(
      (change) => change.kind === "insertion" && change.status === "pending",
    )
  )
    throw new Error(
      "Pending split followed by native typing lost original/final review projections: " +
        JSON.stringify({ split: trackedSplit, typed: trackedSplitTyping }),
    );
  result.checks.push(
    "native tracked paragraph split followed by typing retains separate insertion and exact original projection",
  );
  await page.evaluate(() => window.canvasAcceptance.unmountControlled());

  await page.evaluate(() =>
    window.canvasAcceptance.mountControlled(false, true),
  );
  await page
    .locator("canvas")
    .first()
    .click({ position: { x: 110, y: 115 } });
  const emptyMarker = "New empty scene 😀";
  await page.keyboard.insertText(emptyMarker);
  await page.waitForFunction(
    (marker) => window.canvasAcceptance.controlled().text === marker,
    emptyMarker,
  );
  const emptyDocument = await page.evaluate(
    () => window.canvasAcceptance.controlled().document,
  );
  if (
    !emptyDocument.blocks.length ||
    emptyDocument.blocks[0].type !== "paragraph" ||
    !emptyDocument.blocks[0].id ||
    !emptyDocument.blocks[0].runs[0].id
  )
    throw new Error(
      "Typing into an emptied scene lost canonical paragraph/run identities.",
    );
  result.checks.push(
    "typing into an empty scene creates stable canonical identities without changing scene ownership",
  );
  const historyModule = fileURLToPath(
    new URL(
      "../ProserAuthor/apps/web/src/lib/document-history-navigation.ts",
      import.meta.url,
    ),
  );
  await page.evaluate(async (modulePath) => {
    const navigation = await import(modulePath);
    const state = (window.historyAcceptance = {
      dirty: false,
      pending: undefined,
      bubbles: 0,
      navigation,
    });
    state.cleanup = navigation.registerDocumentNavigationFence({
      dirty: () => state.dirty,
      blocked: (intent) => {
        state.pending = intent;
      },
    });
    window.addEventListener("popstate", () => {
      state.bubbles++;
    });
    history.pushState({ __NA: true, tree: "dashboard-tree" }, "", "#dashboard");
    history.pushState({ __NA: true, tree: "editor-tree" }, "", "#editor");
    state.dirty = true;
    history.back();
  }, server.moduleUrl(historyModule));
  await page.waitForFunction(
    () => window.historyAcceptance.pending && location.hash === "#editor",
  );
  const blocked = await page.evaluate(() => ({
    bubbles: window.historyAcceptance.bubbles,
    tree: history.state.tree,
    pending: window.historyAcceptance.pending,
  }));
  if (
    blocked.bubbles !== 0 ||
    blocked.tree !== "editor-tree" ||
    blocked.pending.kind !== "history"
  )
    throw new Error("Dirty Back traversal mounted an unacknowledged route.");
  await page.evaluate(() => {
    const state = window.historyAcceptance;
    state.dirty = false;
    state.navigation.resumeDocumentHistory(state.pending.index);
  });
  await page.waitForFunction(
    () =>
      location.hash === "#dashboard" && window.historyAcceptance.bubbles === 1,
  );
  await page.evaluate(() => {
    const state = window.historyAcceptance;
    state.pending = undefined;
    state.dirty = true;
    history.forward();
  });
  await page.waitForFunction(
    () => window.historyAcceptance.pending && location.hash === "#dashboard",
  );
  const forward = await page.evaluate(() => ({
    bubbles: window.historyAcceptance.bubbles,
    tree: history.state.tree,
  }));
  if (forward.bubbles !== 1 || forward.tree !== "dashboard-tree")
    throw new Error("Dirty Forward traversal escaped its original session.");
  await page.evaluate(() => {
    const state = window.historyAcceptance;
    state.dirty = false;
    state.navigation.resumeDocumentHistory(state.pending.index);
    state.cleanup();
  });
  await page.waitForFunction(
    () => location.hash === "#editor" && window.historyAcceptance.bubbles === 2,
  );
  result.checks.push(
    "native Back/Forward preserve unacknowledged session and untouched Next history state until saved",
  );
  const layoutExample = await page.evaluate(() =>
    window.canvasAcceptance.mountLayoutExample(),
  );
  if (!layoutExample.exact || layoutExample.pages !== 2)
    throw new Error(
      "Visual layout example changed source widths/styles or pagination.",
    );
  const imageDirectory = resolve(output, "paragraph-layout");
  await mkdir(imageDirectory, { recursive: true });
  await page.locator('canvas[data-index="0"]').scrollIntoViewIfNeeded();
  await settleCanvasFrame(page);
  await page
    .locator('canvas[data-index="0"]')
    .screenshot({ path: resolve(imageDirectory, "page-1.png") });
  await page.locator('canvas[data-index="1"]').scrollIntoViewIfNeeded();
  await settleCanvasFrame(page);
  await page
    .locator('canvas[data-index="1"]')
    .screenshot({ path: resolve(imageDirectory, "page-2.png") });
  if (externalImages.length)
    throw new Error(
      "Deferred external image request escaped the source policy.",
    );
  report.workers = await verifyCanvasWorkers(page);
  if (errors.length) throw new Error(errors.join("\n"));
  report = {
    ...report,
    passed: true,
    ...result,
    layoutChecks,
    commentChecks,
    layoutHistoryChecks,
    rejectedChecks,
  };
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  const cleanup = await closeCanvasFixture(browser, server, report);
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(JSON.stringify(report) + "\n");
  if (cleanup && !report.failure) throw cleanup;
}
