import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Actual authenticated UI: create only a uniquely named disposable book.
 * Guard every browser mutation and retain/tombstone created identities even
 * when Studio navigation or a viewport assertion fails. No inference needed. */
export async function testR2QuickDraft({
  page,
  context,
  call,
  base,
  report,
  output,
  pointerActivation = "mouse",
}) {
  assert(
    ["mouse", "touch"].includes(pointerActivation),
    "Unknown Quick Draft pointer profile",
  );
  const activate = (locator) =>
    pointerActivation === "touch" ? locator.tap() : locator.click();
  const title = `Disposable R2 Quick Draft ${randomUUID()}`;
  const premise = "A fixture author opens a manuscript on a small phone.";
  const createdIds = new Set();
  const responses = [];
  const mutations = [];
  const forbidden = [];
  let typingTarget;
  const routePattern = "**/api/books**";
  const guard = async (route) => {
    const request = route.request();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method()))
      return route.continue();
    await Promise.all(responses);
    const pathname = new URL(request.url()).pathname;
    const data = request.postDataJSON();
    const creation =
      request.method() === "POST" &&
      pathname === "/api/books" &&
      data?.title === title;
    const quickDraft =
      request.method() === "POST" &&
      [...createdIds].some(
        (id) => pathname === `/api/books/${id}/document-quick-drafts`,
      );
    const ownedEdit =
      request.method() === "POST" &&
      typingTarget &&
      pathname ===
        `/api/books/${typingTarget.bookId}/scenes/${typingTarget.sceneId}/document-passages/operations`;
    mutations.push({
      method: request.method(),
      pathname,
      allowed: creation || quickDraft || ownedEdit,
    });
    if (!creation && !quickDraft && !ownedEdit) {
      forbidden.push(pathname);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  };
  const capture = (response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/books"
    )
      return;
    if (response.request().postDataJSON()?.title !== title) return;
    responses.push(
      response.json().then((body) => {
        if (body.success && body.data?.id) createdIds.add(String(body.data.id));
      }),
    );
  };
  const viewports = [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 390, height: 390 },
  ];
  report.quickDraft = {
    title,
    pointerActivation,
    viewports: [],
    fields: [],
    mutations,
    createdBookIds: [],
    tombstonedBookIds: [],
    physicalCertification:
      "emulated viewport only; physical Safari acceptance separate",
  };
  context.on("response", capture);
  await context.route(routePattern, guard);
  let failure;
  try {
    await page.setViewportSize(viewports[0]);
    await page.goto(new URL("/m", base).href);
    await activate(
      page.getByRole("button", { name: "Quick Draft", exact: true }),
    );
    const dialog = page.getByRole("dialog", {
      name: "Quick Draft",
      exact: true,
    });
    const newBook = dialog.getByRole("button", {
      name: "New Book",
      exact: true,
    });
    await newBook.scrollIntoViewIfNeeded();
    report.quickDraft.newBookHitTest = await newBook.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y);
      const events = [];
      button.addEventListener(
        "pointerdown",
        (event) =>
          events.push({
            type: "pointerdown",
            pointerType: event.pointerType,
            targetMatches:
              event.target === button || button.contains(event.target),
          }),
        { once: true },
      );
      button.addEventListener(
        "click",
        (event) =>
          events.push({
            type: "click",
            targetMatches:
              event.target === button || button.contains(event.target),
          }),
        { once: true },
      );
      button.__proserAcceptanceEvents = events;
      return {
        x,
        y,
        targetTag: target?.tagName,
        targetText: target?.closest("button")?.textContent.trim(),
        targetMatches: target === button || button.contains(target),
        insideDialog: !!target?.closest('[role="dialog"]'),
      };
    });
    assert(
      report.quickDraft.newBookHitTest.targetMatches &&
        report.quickDraft.newBookHitTest.insideDialog,
      "New Book center hit testing reached content behind the dialog",
    );
    await activate(newBook);
    const activation = await newBook.evaluate((button) => ({
      events: button.__proserAcceptanceEvents,
      focused: document.activeElement === button,
      focusInsideDialog: !!document.activeElement?.closest('[role="dialog"]'),
    }));
    report.quickDraft.newBookActivation = activation;
    assert(
      activation.events.some(
        (event) =>
          event.type === "pointerdown" &&
          event.pointerType === pointerActivation &&
          event.targetMatches,
      ),
      "New Book pointer event did not reach the owned dialog button",
    );
    assert(
      activation.events.some(
        (event) => event.type === "click" && event.targetMatches,
      ),
      "New Book activation did not reach its dialog button",
    );
    assert(
      activation.focused && activation.focusInsideDialog,
      "New Book activation focus escaped its dialog",
    );
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await dialog.evaluate((element) => {
        element.scrollTop = 0;
      });
      const bounds = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          height: rect.height,
          scrollHeight: element.scrollHeight,
          innerWidth,
          innerHeight,
        };
      });
      assert(
        bounds.x >= -1 &&
          bounds.y >= -1 &&
          bounds.right <= viewport.width + 1 &&
          bounds.bottom <= viewport.height + 1,
        `Quick Draft outside ${viewport.width}x${viewport.height}: ${JSON.stringify(bounds)}`,
      );
      await dialog
        .getByRole("heading", { name: "Quick Draft", exact: true })
        .waitFor();
      for (const label of ["Book Title", "One-sentence premise", "Tone"]) {
        const input = dialog.getByLabel(label, { exact: true });
        await input.scrollIntoViewIfNeeded();
        const field = await input.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            y: rect.y,
            bottom: rect.bottom,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
            labels: [...element.labels].map((item) => item.textContent.trim()),
          };
        });
        report.quickDraft.fields.push({ viewport, label, ...field });
        assert(
          field.y >= -1 && field.bottom <= viewport.height + 1,
          `${label} cannot be reached in ${viewport.width}x${viewport.height}`,
        );
        assert(
          field.labels.includes(label),
          `${label} lacks its semantic label association`,
        );
        assert(
          field.fontSize >= 16,
          `${label} font is below iOS zoom threshold in ${viewport.width}x${viewport.height}`,
        );
      }
      const submit = dialog.getByRole("button", {
        name: "Create And Open Studio",
        exact: true,
      });
      await submit.scrollIntoViewIfNeeded();
      const button = await submit.boundingBox();
      assert(
        button &&
          button.y >= -1 &&
          button.y + button.height <= viewport.height + 1,
        `Submit unreachable in ${viewport.width}x${viewport.height}`,
      );
      report.quickDraft.viewports.push({ ...viewport, bounds, submit: button });
      if (output)
        await page.screenshot({
          path: path.join(
            output,
            `quick-draft-${viewport.width}x${viewport.height}.png`,
          ),
        });
    }
    report.checks.push(
      "R2 Quick Draft portrait, landscape and short viewports keep the sheet in bounds, labels associated, phone inputs at least 16px and submit reachable by scrolling",
    );
    await page.setViewportSize(viewports[0]);
    await dialog.getByLabel("Book Title", { exact: true }).fill(title);
    await dialog
      .getByLabel("One-sentence premise", { exact: true })
      .fill(premise);
    await dialog.getByLabel("Tone", { exact: true }).fill("Fixture only");
    await activate(
      dialog.getByRole("button", {
        name: "Create And Open Studio",
        exact: true,
      }),
    );
    await page.waitForURL(
      (url) =>
        url.pathname === "/m/studio" &&
        !!url.searchParams.get("bookId") &&
        !!url.searchParams.get("sceneId"),
      { timeout: 30000 },
    );
    await Promise.all(responses);
    const destination = new URL(page.url());
    const bookId = destination.searchParams.get("bookId");
    const sceneId = destination.searchParams.get("sceneId");
    assert(
      createdIds.size === 1 && createdIds.has(bookId),
      "Studio must open the exact newly created fixture book",
    );
    assert.equal(
      forbidden.length,
      0,
      `Unexpected existing-book mutation: ${forbidden.join(", ")}`,
    );
    const manifest = await call(`/api/books/${bookId}/document-manifest`);
    assert(
      manifest.scenes.some(
        (scene) => String(scene.sceneId) === sceneId && !scene.deletedAt,
      ),
      "Quick Draft scene missing from structured manifest",
    );
    await page
      .getByRole("textbox", { name: "Canvas writing input", exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(
      mutations.filter((item) => item.pathname === "/api/books").length,
      1,
      "Quick Draft duplicated book creation",
    );
    assert.equal(
      mutations.filter((item) =>
        item.pathname.endsWith("/document-quick-drafts"),
      ).length,
      1,
      "Quick Draft duplicated structured operation",
    );
    typingTarget = { bookId, sceneId };
    const native = page.getByRole("textbox", {
      name: "Canvas writing input",
      exact: true,
    });
    const marker = "R2 quick draft first typing.";
    const acknowledgement = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/books/${bookId}/scenes/${sceneId}/document-passages/operations`,
      { timeout: 30000 },
    );
    await page
      .getByRole("region", { name: "Page editing surface", exact: true })
      .focus();
    await native.pressSequentially(marker);
    const savedResponse = await acknowledgement;
    assert.equal(
      savedResponse.status(),
      200,
      "First Quick Draft typing was not durably acknowledged",
    );
    await page
      .getByText("Saved", { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    const saved = await call(`/api/books/${bookId}/scenes/${sceneId}/document`);
    const text = saved.document.blocks
      .filter((block) => block.type === "paragraph")
      .flatMap((block) => block.runs.map((run) => run.text ?? ""))
      .join("");
    assert.equal(
      text.split(marker).length - 1,
      1,
      "First Quick Draft native typing must be saved exactly once",
    );
    assert.equal(
      forbidden.length,
      0,
      "First typing attempted an unrelated mutation",
    );
    report.quickDraft.firstTyping = {
      sceneRevisionId: saved.revisionId,
      contentHash: saved.contentHash,
      marker,
    };
    report.quickDraft.target = {
      bookId,
      sceneId,
      manifestRevisionId: manifest.revisionId,
    };
    report.checks.push(
      "R2 Quick Draft creates exactly one new fixture book and structured scene, enters authenticated Canvas Studio, saves first native typing exactly once, and performs no existing-book writes or inference",
    );
  } catch (error) {
    failure = error;
    report.quickDraft.failure = error.message;
    if (output)
      await page
        .screenshot({
          path: path.join(output, "quick-draft-failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
  } finally {
    await Promise.allSettled(responses);
    context.off("response", capture);
    await context.unroute(routePattern, guard);
    // Recover the exact uniquely named creation if its browser acknowledgement
    // was lost. Never classify an existing title or unrelated identity as ours.
    const listed = await call("/api/books");
    const books = Array.isArray(listed) ? listed : listed.books;
    assert(Array.isArray(books), "Book list response lacks owned books");
    for (const book of books)
      if (book.title === title) createdIds.add(String(book.id));
    report.quickDraft.createdBookIds = [...createdIds];
    for (const bookId of createdIds) {
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
      report.quickDraft.tombstonedBookIds.push(bookId);
    }
  }
  if (failure) throw failure;
}
