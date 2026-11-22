import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Reusable with isolated services or an explicitly guarded production operator.
 * Creates its own small disposable book; never edits an existing manuscript. */
export async function testManuscriptNavigation({
  page,
  base,
  call,
  report,
  verify = assert.ok,
  output,
}) {
  const title = `Disposable manuscript navigation ${randomUUID()}`;
  const sentinel = `NAV_TERMINAL_${randomUUID()}_Ω`;
  const longText = `NAV_BEGIN ${"bounded excerpt ".repeat(800)}${sentinel}`;
  const originalViewport = page.viewportSize();
  const context = page.context();
  const writes = [];
  const observe = (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/api/books")
    )
      writes.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
  };
  const evidence = (report.manuscriptNavigation = {
    title,
    creationOperationId: randomUUID(),
    createdBookIds: [],
    tombstonedBookIds: [],
    viewportChecks: [],
    uiWrites: writes,
    scope:
      "Authenticated locator navigation, keyboard scrolling and bounded semantic preview; no physical-device certification",
  });
  let bookId;
  let failure;
  try {
    const book = await call("/api/books", {
      title,
      operationId: evidence.creationOperationId,
    });
    bookId = book.id;
    verify(
      Number.isSafeInteger(Number(bookId)) && Number(bookId) > 0,
      "Fixture creation returned no owned book identity",
    );
    evidence.createdBookIds.push(String(bookId));
    const preconditions = async () => {
      const manifest = await call(`/api/books/${bookId}/document-manifest`);
      return {
        operationId: randomUUID(),
        expectedRevisionId: manifest.revisionId,
        expectedScopes: { structure: manifest.scopes.structure.revisionId },
      };
    };
    const { act } = await call(`/api/books/${bookId}/acts`, {
      title: "Navigation acceptance",
      documentPreconditions: await preconditions(),
    });
    const chapters = [];
    for (const chapterTitle of [
      "Alpha navigation",
      "Empty navigation",
      "Omega navigation",
    ]) {
      const { chapter } = await call(
        `/api/books/${bookId}/acts/${act.id}/chapters`,
        { title: chapterTitle, documentPreconditions: await preconditions() },
      );
      chapters.push(chapter);
    }
    await call(`/api/books/${bookId}/chapters/${chapters[0].id}/scenes/batch`, {
      scenes: [
        {
          prose: "NAV_DESTINATION remains unchanged.",
          summary: "Short destination",
        },
        { prose: longText, summary: "Bounded long source" },
      ],
      documentPreconditions: await preconditions(),
    });
    await call(`/api/books/${bookId}/chapters/${chapters[2].id}/scenes/batch`, {
      scenes: [
        {
          prose: "NAV_OMEGA remains unchanged.",
          summary: "Second populated chapter",
        },
      ],
      documentPreconditions: await preconditions(),
    });
    const initialManifest = await call(
      `/api/books/${bookId}/document-manifest`,
    );
    const alphaScenes = initialManifest.scenes
      .filter((scene) => scene.chapterId === chapters[0].id)
      .sort((a, b) => a.sceneNumber - b.sceneNumber);
    const omegaScene = initialManifest.scenes.find(
      (scene) => scene.chapterId === chapters[2].id,
    );
    verify(
      alphaScenes.length === 2 && omegaScene,
      "Navigation fixture did not retain its complete ordered identities",
    );
    evidence.chapterIds = chapters.map((chapter) => chapter.id);
    evidence.sceneIds = [
      ...alphaScenes.map((scene) => scene.sceneId),
      omegaScene.sceneId,
    ];
    evidence.sourceCharacterCount = longText.length;
    const route = (chapter, scene) =>
      new URL(
        `/manuscript?bookId=${bookId}&scope=chapter&chapterId=${chapter.id}${scene ? `&sceneId=${scene.sceneId}` : ""}`,
        base,
      ).href;
    const picker = page.getByRole("combobox", {
      name: "Navigate to chapter",
      exact: true,
    });
    const chapterReady = async (chapter, scene) => {
      await page.waitForURL(
        (url) =>
          url.searchParams.get("chapterId") === String(chapter.id) &&
          url.searchParams.get("scope") === "chapter",
      );
      await picker.waitFor();
      assert.equal(await picker.inputValue(), String(chapter.id));
      assert.equal(
        new URL(page.url()).searchParams.get("bookId"),
        String(bookId),
      );
      assert.equal(
        new URL(page.url()).searchParams.get("sceneId"),
        scene ? String(scene.sceneId) : null,
      );
      if (scene)
        await page
          .getByText("Saved", { exact: true })
          .first()
          .waitFor({ timeout: 30_000 });
      else {
        await page
          .getByText(
            "This chapter has no saved scenes. Add a scene in Structure to begin writing here.",
            { exact: true },
          )
          .waitFor();
        assert.equal(await page.locator("[data-document-window]").count(), 0);
        assert.equal(
          await page.locator('[aria-label="Canvas writing input"]').count(),
          0,
        );
      }
    };
    context.on("request", observe);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(
      new URL(
        `/manuscript?bookId=${bookId}&sceneId=${alphaScenes[0].sceneId}`,
        base,
      ).href,
    );
    await page
      .getByText("Saved", { exact: true })
      .first()
      .waitFor({ timeout: 30_000 });
    await page
      .getByRole("combobox", { name: "Manuscript editing scope", exact: true })
      .selectOption("chapter");
    await chapterReady(chapters[0], alphaScenes[0]);
    assert.deepEqual(
      await picker.locator("option").evaluateAll((options) =>
        options.map((option) => ({
          value: option.value,
          text: option.textContent.trim(),
          disabled: option.disabled,
        })),
      ),
      chapters.map((chapter, index) => ({
        value: String(chapter.id),
        text: `${chapter.title}${index === 1 ? " · No scenes" : ""}`,
        disabled: false,
      })),
    );
    await picker.selectOption(String(chapters[1].id));
    await chapterReady(chapters[1]);
    await page
      .getByRole("button", { name: "Previous chapter", exact: true })
      .click();
    await chapterReady(chapters[0], alphaScenes[0]);
    await page
      .getByRole("button", { name: "Next chapter", exact: true })
      .click();
    await chapterReady(chapters[1]);
    await page
      .getByRole("button", { name: "Next chapter", exact: true })
      .click();
    await chapterReady(chapters[2], omegaScene);
    await picker.selectOption(String(chapters[0].id));
    await chapterReady(chapters[0], alphaScenes[0]);
    await page.reload();
    await chapterReady(chapters[0], alphaScenes[0]);
    await page.screenshot({
      path: path.join(output, "manuscript-chapter-picker.png"),
    });
    await page.goto(route(chapters[2], omegaScene));
    await chapterReady(chapters[2], omegaScene);
    await page.goBack();
    await chapterReady(chapters[0], alphaScenes[0]);
    report.checks.push(
      "Chapter scope lists stable chapter identities including an empty chapter; previous/next, direct URLs, reload and browser Back retain the requested chapter and readable empty state",
    );

    const transfers = page.getByRole("region", {
      name: "Atomic scene transfers",
      exact: true,
    });
    await transfers
      .getByRole("combobox", { name: "Transfer source scene", exact: true })
      .selectOption(String(alphaScenes[1].sceneId));
    await transfers
      .getByRole("combobox", {
        name: "Transfer destination scene",
        exact: true,
      })
      .selectOption(String(alphaScenes[0].sceneId));
    const preview = page.getByRole("region", {
      name: "Adjacent saved scene excerpts",
      exact: true,
    });
    const source = preview.locator('[data-excerpt-role="source"]');
    const sourceText = async () =>
      (await source.locator("[data-run-id]").allTextContents()).join("");
    await transfers
      .getByText("Source scene continues in the next excerpt.", { exact: true })
      .waitFor();
    const initialExcerpt = await sourceText();
    verify(
      initialExcerpt.startsWith("NAV_BEGIN ") &&
        initialExcerpt.length <= 8000 &&
        !initialExcerpt.includes(sentinel),
      "The initial source preview must disclose a bounded fragment, not silently display a full scene",
    );
    const next = transfers.getByRole("button", {
      name: "Next source excerpt",
      exact: true,
    });
    await next.click();
    await transfers
      .getByText("End of source scene.", { exact: true })
      .waitFor();
    verify(
      (await sourceText()).endsWith(sentinel),
      "The next source excerpt did not reach the exact final Unicode glyph",
    );
    verify(
      await next.isDisabled(),
      "The last source excerpt must have no further continuation",
    );
    const sourceEndResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname ===
          `/api/books/${bookId}/scenes/${alphaScenes[1].sceneId}/document-passages` &&
        url.searchParams.get("edge") === "last"
      );
    });
    await transfers
      .getByRole("button", { name: "Load source scene end", exact: true })
      .click();
    verify(
      (await sourceEndResponse).ok(),
      "The source-end request did not load its pinned bounded passage",
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent.trim() === "Load source scene end" &&
          !button.disabled,
      ),
    );
    await transfers
      .getByText("End of source scene.", { exact: true })
      .waitFor();
    verify(
      (await sourceText()).endsWith(sentinel),
      "The source-end control did not retain the terminal boundary",
    );
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 2048, height: 744 },
    ]) {
      await page.setViewportSize(viewport);
      await preview.scrollIntoViewIfNeeded();
      await preview.evaluate((element) => {
        element.scrollTop = 0;
      });
      await preview.focus();
      verify(
        await preview.evaluate((element) => element === document.activeElement),
        "The excerpt box must accept keyboard focus",
      );
      await page.keyboard.press("PageDown");
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Adjacent saved scene excerpts"]')
            .scrollTop > 0,
      );
      await page.keyboard.press("End");
      await page.waitForFunction(() => {
        const element = document.querySelector(
          '[aria-label="Adjacent saved scene excerpts"]',
        );
        return (
          element.scrollTop >= element.scrollHeight - element.clientHeight - 2
        );
      });
      const bounds = await preview.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const runs = element.querySelectorAll(
          '[data-excerpt-role="source"] [data-run-id]',
        );
        const terminal = runs[runs.length - 1].firstChild;
        const range = document.createRange();
        range.setStart(terminal, terminal.textContent.length - 1);
        range.setEnd(terminal, terminal.textContent.length);
        const glyph = range.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          height: rect.height,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          overflowY: getComputedStyle(element).overflowY,
          tabIndex: element.tabIndex,
          glyph: {
            top: glyph.top,
            bottom: glyph.bottom,
            left: glyph.left,
            right: glyph.right,
          },
        };
      });
      verify(
        bounds.scrollHeight > bounds.clientHeight &&
          bounds.height <= 322 &&
          bounds.tabIndex === 0 &&
          bounds.overflowY === "auto",
        "Long excerpts must remain in a bounded keyboard-scrollable box",
      );
      verify(
        bounds.x >= 0 &&
          bounds.right <= viewport.width + 1 &&
          bounds.y >= 0 &&
          bounds.bottom <= viewport.height + 1,
        "Excerpt box escaped the visible viewport",
      );
      verify(
        bounds.glyph.top >= bounds.y &&
          bounds.glyph.bottom <= bounds.bottom &&
          bounds.glyph.left >= bounds.x &&
          bounds.glyph.right <= bounds.right,
        "The exact final source glyph is clipped after keyboard scrolling to the terminal boundary",
      );
      const screenshot = `manuscript-navigation-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: path.join(output, screenshot) });
      evidence.viewportChecks.push({ viewport, bounds, screenshot });
    }
    assert.equal(
      writes.length,
      0,
      "Navigation and excerpt controls must not mutate the manuscript",
    );
    assert.equal(
      (await call(`/api/books/${bookId}/document-manifest`)).revisionId,
      initialManifest.revisionId,
    );
    assert.equal(
      (await call(`/api/books/${bookId}/scenes/${alphaScenes[1].sceneId}`))
        .scene.prose,
      longText,
    );
    evidence.terminalSentinel = sentinel;
    report.checks.push(
      "Bounded adjacent excerpts disclose continuation, next/end reach the exact terminal glyph, and keyboard scrolling stays visible at 1440×1000 and 2048×744 without content writes or full-scene UI loading",
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    context.off("request", observe);
    if (originalViewport) await page.setViewportSize(originalViewport);
    if (bookId) {
      try {
        const structure = await call(
          `/api/books/${bookId}/document-scopes/structure`,
        );
        const ownedBook = await call(`/api/books/${bookId}`);
        const manifest = await call(`/api/books/${bookId}/document-manifest`);
        verify(
          evidence.createdBookIds.includes(String(bookId)) &&
            ownedBook.id === Number(bookId) &&
            structure.content.book.title === title,
          "Refusing cleanup of a book outside the exact owned navigation fixture",
        );
        await call(
          `/api/books/${bookId}`,
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
        evidence.tombstonedBookIds.push(String(bookId));
      } catch (error) {
        evidence.cleanupError =
          error instanceof Error ? error.message : String(error);
        if (!failure) throw error;
      }
    }
  }
}
