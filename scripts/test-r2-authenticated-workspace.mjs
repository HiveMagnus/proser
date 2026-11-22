import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  settleCanvasFrame,
  waitForBrowserState,
} from "./canvas-browser-fixture.mjs";
import {
  canonicalDocument,
  documentFromText,
  projectDocument,
} from "../ProserAuthor/packages/contracts/dist/index.js";

/** Actual authenticated local application acceptance. Physical device and
 * screen-reader certification have separate evidence; dispatched beforeinput
 * below is an explicit synthetic input-contract check, not an iPhone gesture. */
export async function testR2AuthenticatedWorkspace({
  page,
  context,
  call,
  bookId,
  sceneId,
  base,
  report,
  setReading,
}) {
  const scenePath = `/api/books/${bookId}/scenes/${sceneId}`;
  const document = () => call(`${scenePath}/document`);
  const digest = (value) =>
    createHash("sha256").update(canonicalDocument(value)).digest("hex");
  const saved = async () => {
    await settleCanvasFrame(page);
    await page
      .getByText("Saved", { exact: true })
      .first()
      .waitFor({ timeout: 30_000 });
  };
  const navigate = async (route) => {
    await page.goto(new URL(route, base).href);
    await saved();
  };
  const acknowledgement = (ending) =>
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(ending),
      { timeout: 30_000 },
    );
  const operation = async (
    action,
    ending = "/document-passages/operations",
  ) => {
    const response = acknowledgement(ending);
    await action();
    assert.ok((await response).ok(), `R2 ${ending} must commit successfully`);
    await saved();
  };
  const mutations = [];
  const observe = (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith(`/api/books/${bookId}/`)
    )
      mutations.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
  };
  context.on("request", observe);
  try {
    const layout = await call(`/api/books/${bookId}/document-scopes/layout`);
    const nextLayout = structuredClone(layout.content);
    nextLayout.styles.paragraph.R2ReaderHeading = { heading: 2 };
    nextLayout.styles.text.R2ReaderHeading = { bold: true };
    nextLayout.headerFooterStories = [
      ...(nextLayout.headerFooterStories ?? []),
      {
        id: randomUUID(),
        owner: "book",
        kind: "header",
        document: documentFromText("R2 protected header", randomUUID),
      },
    ];
    let manifest = await call(`/api/books/${bookId}/document-manifest`);
    await call(`/api/books/${bookId}/document-layout-commits`, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: manifest.revisionId,
      expectedScopes: { layout: layout.revisionId },
      layout: nextLayout,
    });
    const beforeSeed = await document();
    const seeded = structuredClone(beforeSeed.document);
    const table = seeded.blocks.find((block) => block.type === "table");
    assert.ok(
      table?.rows[0]?.cells[0]?.paragraphs[0],
      "The prior genuine table fixture is required",
    );
    const cell = table.rows[0].cells[0].paragraphs[0];
    cell.runs = [
      { id: randomUUID(), text: "R2 cell source", style: { bold: true } },
    ];
    const adjacent = {
      type: "paragraph",
      id: randomUUID(),
      style: { name: "R2ReaderHeading" },
      runs: [
        {
          id: randomUUID(),
          text: "R2 adjacent 😀 e\u0301 text",
          style: { italic: true },
        },
      ],
    };
    seeded.blocks.push(adjacent);
    manifest = await call(`/api/books/${bookId}/document-manifest`);
    await call(`/api/books/${bookId}/document-commits`, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: manifest.revisionId,
      scenes: [
        {
          sceneId: Number(sceneId),
          expectedRevisionId: beforeSeed.revisionId,
          document: seeded,
        },
      ],
    });
    const manuscript = `/manuscript?bookId=${bookId}&sceneId=${sceneId}`;
    await navigate(manuscript);
    const original = await document();
    const originalLayout = await call(
      `/api/books/${bookId}/document-scopes/layout`,
    );
    const writesBeforeNavigation = mutations.length;
    const native = page.locator('[aria-label="Canvas writing input"]');
    const region = page.getByRole("region", {
      name: "Page editing surface",
      exact: true,
    });
    const paper = region.locator('canvas[data-index="0"]').first();
    await paper.evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerType: "touch",
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + 4,
        }),
      );
    });
    await page
      .getByRole("alert")
      .filter({ hasText: "Headers and footers are read-only" })
      .waitFor();
    await native.focus();
    await page.keyboard.type("blocked-header-write");
    await page.waitForTimeout(850);
    assert.equal((await document()).contentHash, original.contentHash);
    assert.equal(mutations.length, writesBeforeNavigation);
    assert.equal(
      (await call(`/api/books/${bookId}/document-scopes/layout`)).contentHash,
      originalLayout.contentHash,
    );
    report.checks.push(
      "R2 authenticated synthetic touch-pointer ownership guard blocks page-header typing and leaves body/layout revisions unchanged",
    );
    await page.evaluate(() => {
      window.r2FocusTrace = [];
      const active = () => ({
        label: document.activeElement?.getAttribute("aria-label"),
        tag: document.activeElement?.tagName,
      });
      document.addEventListener(
        "focusin",
        (event) =>
          window.r2FocusTrace.push({
            kind: "focusin",
            at: performance.now(),
            target: event.target?.getAttribute?.("aria-label"),
            tag: event.target?.tagName,
            active: active(),
          }),
        true,
      );
      document.addEventListener(
        "keydown",
        (event) => {
          const row = {
            kind: "keydown",
            at: performance.now(),
            key: event.key,
            shift: event.shiftKey,
            target: event.target?.getAttribute?.("aria-label"),
            active: active(),
          };
          window.r2FocusTrace.push(row);
          setTimeout(
            () =>
              window.r2FocusTrace.push({
                ...row,
                kind: "after-key",
                prevented: event.defaultPrevented,
                active: active(),
              }),
            30,
          );
        },
        true,
      );
    });
    await region.focus();
    report.r2InitialFocus = await page.evaluate(() => ({
      label: document.activeElement?.getAttribute("aria-label"),
      tag: document.activeElement?.tagName,
    }));
    await page.keyboard.press("Shift+Tab");
    report.r2FocusTrace = await page.evaluate(() => window.r2FocusTrace);
    assert.notEqual(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "Canvas writing input",
    );
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "Canvas writing input",
    );
    report.r2FocusTrace = await page.evaluate(() => window.r2FocusTrace);
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "Canvas writing input",
    );
    await page.waitForTimeout(850);
    assert.equal((await document()).contentHash, original.contentHash);
    assert.equal(mutations.length, writesBeforeNavigation);
    report.checks.push(
      "R2 authenticated native Tab/Shift+Tab exits and reenters the page input without a content commit",
    );
    const protectedBlocks = digest(original.document.blocks.slice(1));
    await operation(() => page.keyboard.type("r2native "));
    const typed = await document();
    assert.notEqual(typed.contentHash, original.contentHash);
    assert.equal(digest(typed.document.blocks.slice(1)), protectedBlocks);
    assert.ok(
      await page
        .getByRole("button", { name: "Undo saved operation", exact: true })
        .isEnabled(),
      "Saved operation undo must be enabled before beforeinput dispatch",
    );
    await operation(
      () =>
        native.evaluate((input) =>
          input.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "historyUndo",
              bubbles: true,
              cancelable: true,
            }),
          ),
        ),
      "/document-passages/restore",
    );
    assert.equal((await document()).contentHash, original.contentHash);
    assert.ok(
      await page
        .getByRole("button", { name: "Redo saved operation", exact: true })
        .isEnabled(),
      "Saved operation redo must be enabled before beforeinput dispatch",
    );
    await operation(
      () =>
        native.evaluate((input) =>
          input.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "historyRedo",
              bubbles: true,
              cancelable: true,
            }),
          ),
        ),
      "/document-passages/restore",
    );
    assert.equal((await document()).contentHash, typed.contentHash);
    report.checks.push(
      "R2 authenticated synthetic beforeinput historyUndo/historyRedo restores exact complete scene hashes through Factory owned history without native flattening",
    );
    await page
      .getByRole("button", { name: "Accessible editor", exact: true })
      .click();
    const field = (id) =>
      page.locator(`[data-block-id="${id}"] textarea`).first();
    await field(adjacent.id).waitFor();
    const beforeParagraph = await document();
    let paragraphTarget = "R2 adjacent 😀 e\u0301 text revised";
    await operation(() => field(adjacent.id).fill(paragraphTarget));
    const afterParagraph = await document();
    const editedParagraph = afterParagraph.document.blocks.find(
      (block) => block.id === adjacent.id,
    );
    assert.equal(
      canonicalDocument(editedParagraph.style),
      canonicalDocument(adjacent.style),
    );
    assert.ok(editedParagraph.runs.every((run) => run.style.italic));
    assert.equal(
      digest(
        afterParagraph.document.blocks.filter(
          (block) => block.id !== adjacent.id,
        ),
      ),
      digest(
        beforeParagraph.document.blocks.filter(
          (block) => block.id !== adjacent.id,
        ),
      ),
    );
    const beforeCell = afterParagraph;
    await operation(() => field(cell.id).fill("R2 cell source revised"));
    const afterCell = await document();
    const withoutCellText = (value) => {
      const copy = structuredClone(value);
      const target = copy.blocks.find((block) => block.id === table.id).rows[0]
        .cells[0].paragraphs[0];
      target.runs = [];
      return copy;
    };
    assert.equal(
      digest(withoutCellText(afterCell.document)),
      digest(withoutCellText(beforeCell.document)),
    );
    assert.ok(
      afterCell.document.blocks
        .find((block) => block.id === table.id)
        .rows[0].cells[0].paragraphs[0].runs.every((run) => run.style.bold),
    );
    await page.reload();
    await saved();
    assert.equal((await document()).contentHash, afterCell.contentHash);
    await page
      .getByRole("button", { name: "Accessible editor", exact: true })
      .click();
    assert.equal(await field(adjacent.id).inputValue(), paragraphTarget);
    assert.equal(await field(cell.id).inputValue(), "R2 cell source revised");
    report.checks.push(
      "R2 authenticated semantic adjacent-paragraph and table-cell edits save and reload while preserving every unrelated block, run style, object, layout and review identity",
    );
    const lostAckRoute = `**${scenePath}/document-passages/operations`;
    let lostPosts = 0,
      lostOperationId;
    const originalLostWrites = mutations.length;
    let resolveLost;
    const lostEffect = new Promise((resolve) => {
      resolveLost = resolve;
    });
    await page.route(lostAckRoute, async (route) => {
      lostPosts++;
      lostOperationId = route.request().postDataJSON().operationId;
      const response = await route.fetch();
      assert.ok(
        response.ok(),
        "The interrupted save must have reached durable Factory acknowledgement",
      );
      await route.abort("failed");
      resolveLost();
    });
    paragraphTarget += " recovered";
    await field(adjacent.id).fill(paragraphTarget);
    await lostEffect;
    await page
      .getByRole("button", { name: "Check original receipt", exact: true })
      .waitFor();
    const acceptReload = (dialog) => dialog.accept();
    page.once("dialog", acceptReload);
    await page.reload();
    page.off("dialog", acceptReload);
    await page
      .getByRole("button", { name: "Recover original operation", exact: true })
      .click();
    await saved();
    const recoveredReceipt = await call(
      `/api/books/${bookId}/document-operations/${lostOperationId}`,
    );
    assert.equal(recoveredReceipt.operationId, lostOperationId);
    assert.equal(recoveredReceipt.status, "completed");
    assert.equal(lostPosts, 1);
    assert.equal(mutations.length, originalLostWrites + 1);
    const recovered = await document();
    assert.equal(
      recovered.document.blocks
        .find((block) => block.id === adjacent.id)
        .runs.map((run) => run.text)
        .join(""),
      paragraphTarget,
    );
    await page.unroute(lostAckRoute);
    report.checks.push(
      "R2 authenticated save loses acknowledgement after Factory commits, reload retains its journal, and exact original receipt recovery sends no second mutation",
    );
    await page
      .getByRole("button", { name: "Accessible editor", exact: true })
      .click();
    await field(adjacent.id).waitFor();
    const offlineSource = await document();
    const offlineLayout = await call(
      `/api/books/${bookId}/document-scopes/layout`,
    );
    const owner = await (
      await page.request.get(new URL("/api/auth/session", base).href)
    ).json();
    const draftKey = JSON.stringify([
      "passage-v1",
      owner.user.id,
      String(bookId),
      String(sceneId),
    ]);
    const retainedDraft = () =>
      page.evaluate(
        (key) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("proser-document-drafts", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const transaction = db.transaction("drafts", "readonly");
              const request = transaction.objectStore("drafts").get(key);
              transaction.oncomplete = () => {
                db.close();
                resolve(request.result ?? null);
              };
              transaction.onerror = transaction.onabort = () => {
                db.close();
                reject(transaction.error);
              };
            };
          }),
        draftKey,
      );
    const offlineRequests = [];
    const observeOffline = (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `${scenePath}/document-passages/operations`
      )
        offlineRequests.push(request.postDataJSON());
    };
    context.on("request", observeOffline);
    const writesBeforeOffline = mutations.length;
    try {
      await context.setOffline(true);
      assert.equal(await page.evaluate(() => navigator.onLine), false);
      const suffix = ` offline 😀 e\u0301 ${randomUUID()}`;
      paragraphTarget += suffix;
      await field(adjacent.id).focus();
      await page.keyboard.press("ControlOrMeta+End");
      assert.ok(
        await field(adjacent.id).evaluate(
          (input) =>
            input.selectionStart === input.value.length &&
            input.selectionEnd === input.value.length,
        ),
        "The offline typing fixture must start at the complete textarea end, including wrapped lines",
      );
      await page.keyboard.type(suffix);
      await page
        .getByText("Offline · retained changes", { exact: true })
        .waitFor();
      assert.ok(
        await page
          .getByRole("button", { name: "Save changes", exact: true })
          .isDisabled(),
        "Offline drafts must not advertise an available network save",
      );
      const draft = await waitForBrowserState(
        retainedDraft,
        (row) =>
          Boolean(row?.document && row.prepared?.operationId) &&
          row.prepared.documentKey === canonicalDocument(row.document) &&
          row.document.blocks
            .find((block) => block.id === adjacent.id)
            ?.runs.map((run) => run.text)
            .join("") === paragraphTarget,
        "the retained offline operation intent",
      );
      assert.ok(draft?.document && draft.prepared?.operationId);
      assert.equal(
        draft.pending,
        undefined,
        "No offline request was dispatched",
      );
      assert.equal(draft.userId, owner.user.id);
      assert.equal(draft.passage.sceneRevisionId, offlineSource.revisionId);
      assert.equal(
        draft.prepared.documentKey,
        canonicalDocument(draft.document),
      );
      assert.equal(
        draft.document.blocks
          .find((block) => block.id === adjacent.id)
          .runs.map((run) => run.text)
          .join(""),
        paragraphTarget,
      );
      assert.equal(offlineRequests.length, 0);
      assert.equal(mutations.length, writesBeforeOffline);
      page.once("dialog", acceptReload);
      // Retire the active autosave session while still offline. Reconnecting a
      // live editor could legitimately autosave before a slow reload starts.
      await page.goto("about:blank");
      page.off("dialog", acceptReload);
      await context.setOffline(false);
      await page.goto(new URL(manuscript, base).href);
      assert.equal(await page.evaluate(() => navigator.onLine), true);
      await page
        .getByRole("button", { name: "Restore retained draft", exact: true })
        .waitFor();
      assert.equal((await document()).contentHash, offlineSource.contentHash);
      assert.equal(
        offlineRequests.length,
        0,
        "Reopening must await explicit retained-draft restoration",
      );
      const reopened = await retainedDraft();
      assert.equal(reopened.prepared.operationId, draft.prepared.operationId);
      assert.equal(digest(reopened.document), digest(draft.document));
      await operation(() =>
        page
          .getByRole("button", { name: "Restore retained draft", exact: true })
          .click(),
      );
      assert.equal(offlineRequests.length, 1);
      assert.equal(offlineRequests[0].operationId, draft.prepared.operationId);
      const receipt = await call(
        `/api/books/${bookId}/document-operations/${draft.prepared.operationId}`,
      );
      assert.equal(receipt.status, "completed");
      const acknowledged = await document();
      const withoutTargetText = (value) => {
        const copy = structuredClone(value);
        copy.blocks.find((block) => block.id === adjacent.id).runs = [];
        return copy;
      };
      assert.equal(
        digest(withoutTargetText(acknowledged.document)),
        digest(withoutTargetText(offlineSource.document)),
      );
      const target = acknowledged.document.blocks.find(
        (block) => block.id === adjacent.id,
      );
      assert.equal(
        target.runs.map((run) => run.text).join(""),
        paragraphTarget,
      );
      assert.ok(target.runs.every((run) => run.style.italic));
      const expected = structuredClone(offlineSource.document);
      const expectedTarget = expected.blocks.find(
        (block) => block.id === adjacent.id,
      );
      expectedTarget.runs = [
        { ...expectedTarget.runs[0], text: paragraphTarget },
      ];
      assert.equal(
        acknowledged.projection.text,
        projectDocument(expected).text,
      );
      assert.equal(
        (await call(scenePath)).scene.prose,
        acknowledged.projection.text,
      );
      assert.equal(acknowledged.contentHash, digest(acknowledged.document));
      assert.equal(
        (await call(`/api/books/${bookId}/document-scopes/layout`)).contentHash,
        offlineLayout.contentHash,
      );
      assert.equal(
        await retainedDraft(),
        null,
        "Durable acknowledgement removes this exact retained draft",
      );
      assert.equal(mutations.length, writesBeforeOffline + 1);
      report.r2Offline = {
        loadedDocumentOnlineTransitions: [false, true],
        sourceSceneRevisionId: offlineSource.revisionId,
        sourceContentHash: offlineSource.contentHash,
        retainedDraftDigest: digest(draft.document),
        operationId: draft.prepared.operationId,
        mutationCount: offlineRequests.length,
        acknowledgedSceneRevisionId: acknowledged.revisionId,
        acknowledgedContentHash: acknowledged.contentHash,
        retainedDraftRemoved: true,
        offlineSessionRetiredBeforeReconnect: true,
        inputScope:
          "Playwright semantic textarea keyboard typing with real browser offline emulation; no navigator getter override",
      };
      report.checks.push(
        "R2 authenticated loaded-document offline Unicode typing retains its identity-scoped IndexedDB draft without a request, reopening restores the exact draft once, and durable acknowledgement preserves complete scene/prose/style/table/review/layout content",
      );
    } finally {
      await context.setOffline(false);
      context.off("request", observeOffline);
    }
    setReading(true);
    const beforeReading = await document();
    const readingWrites = mutations.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      new URL(`/m/read?bookId=${bookId}&sceneId=${sceneId}`, base).href,
    );
    await page
      .getByRole("heading", { level: 2, name: paragraphTarget, exact: true })
      .waitFor();
    await page
      .getByRole("cell", { name: "R2 cell source revised", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("textbox").count(), 0);
    const font = page.getByRole("combobox", { name: "Reading font" });
    await font.selectOption("Arial");
    const size = page.getByRole("slider", { name: "Reading size" });
    await size.focus();
    await page.keyboard.press("ArrowRight");
    const preferredSize = await size.inputValue();
    const session = await (
      await page.request.get(new URL("/api/auth/session", base).href)
    ).json();
    const preferenceKey = JSON.stringify([
      "proser-reader-preferences-v1",
      session.user.id,
    ]);
    const ownedPreference = await page.evaluate(
      (key) => localStorage.getItem(key),
      preferenceKey,
    );
    assert.equal(JSON.parse(ownedPreference).userId, session.user.id);
    await page.reload();
    await page
      .getByRole("heading", { level: 2, name: paragraphTarget, exact: true })
      .waitFor();
    assert.equal(await font.inputValue(), "Arial");
    assert.equal(await size.inputValue(), preferredSize);
    await page.evaluate(
      ({ key, record }) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            ...JSON.parse(record),
            userId: "different-authenticated-owner",
          }),
        ),
      { key: preferenceKey, record: ownedPreference },
    );
    await page.reload();
    await page
      .getByRole("heading", { level: 2, name: paragraphTarget, exact: true })
      .waitFor();
    assert.equal(await font.inputValue(), "Georgia");
    assert.equal(await size.inputValue(), "18");
    await page.evaluate(
      ({ key, record }) => localStorage.setItem(key, record),
      { key: preferenceKey, record: ownedPreference },
    );
    assert.equal((await document()).contentHash, beforeReading.contentHash);
    assert.equal(mutations.length, readingWrites);
    report.checks.push(
      "R2 authenticated mobile reader resolves named saved heading styles and tables, retains same-user typography, rejects foreign-owner preferences, and makes zero document mutations",
    );
    report.r2 = {
      nativeNavigationWrites: 0,
      readerWrites: 0,
      finalSceneRevisionId: beforeReading.revisionId,
      finalContentHash: beforeReading.contentHash,
      beforeinputContract:
        "synthetic input events through the actual authenticated application",
      hardwareCertification: "pending physical iPhone and VoiceOver",
    };
  } finally {
    setReading(false);
    context.off("request", observe);
  }
}
