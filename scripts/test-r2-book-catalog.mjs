import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Exercise ordinary Dashboard CRUD against the owned Factory authority. Only
 * this uniquely named disposable book may be mutated, including on failure. */
export async function testR2BookCatalog({
  page,
  context,
  call,
  base,
  report,
  output,
}) {
  const title = `Disposable R2 project ${randomUUID()}`;
  const ids = new Set();
  const writes = [];
  const forbidden = [];
  let creationId;
  let deletionId;
  let sceneTarget;
  let deleted = false;
  let failure;
  let guardFailure;
  const pattern = "**/api/**";
  report.bookCatalog = {
    title,
    writes,
    forbidden,
    createdBookIds: [],
    tombstonedBookIds: [],
  };
  const guard = async (route) => {
    try {
      const request = route.request();
      if (["GET", "HEAD", "OPTIONS"].includes(request.method()))
        return route.continue();
      const pathname = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      const creation =
        request.method() === "POST" &&
        pathname === "/api/books" &&
        body?.title === title;
      const owned =
        [...ids].some((id) => pathname === `/api/books/${id}`) &&
        ["PUT", "DELETE"].includes(request.method());
      const firstScene =
        request.method() === "POST" &&
        [...ids].some(
          (id) => pathname === `/api/books/${id}/document-quick-drafts`,
        );
      const bodyEdit =
        request.method() === "POST" &&
        sceneTarget &&
        pathname ===
          `/api/books/${sceneTarget.bookId}/scenes/${sceneTarget.sceneId}/document-passages/operations`;
      writes.push({
        method: request.method(),
        pathname,
        operationId:
          body?.operationId ?? body?.documentPreconditions?.operationId,
        allowed: creation || owned || firstScene || !!bodyEdit,
      });
      if (!creation && !owned && !firstScene && !bodyEdit) {
        forbidden.push(pathname);
        return route.abort("blockedbyclient");
      }
      if (creation) {
        assert(!creationId, "Dashboard replayed an uncertain book creation");
        assert.match(
          body.operationId,
          /^[0-9a-f-]{36}$/i,
          "Dashboard omitted creation operation ID",
        );
        creationId = body.operationId;
        // Factory commits before we lose the original acknowledgement. Retain
        // its exact identity independently so failure cleanup cannot repeat it.
        const response = await route.fetch();
        const envelope = await response.json();
        assert.equal(response.status(), 201);
        assert(
          envelope.success && envelope.data?.id,
          "Creation did not return an owned identity",
        );
        ids.add(String(envelope.data.id));
        return route.abort("failed");
      }
      if (firstScene || bodyEdit) {
        assert(
          body?.operationId && body.expectedRevisionId,
          "Scene creation/edit omitted revision preconditions",
        );
        const response = await route.fetch();
        if (firstScene) {
          const envelope = await response.json();
          assert(
            response.ok() && envelope.data?.result?.sceneId,
            "First scene creation returned no owned identity",
          );
          sceneTarget = {
            bookId: pathname.split("/")[3],
            sceneId: String(envelope.data.result.sceneId),
          };
        }
        return route.fulfill({ response });
      }
      const preconditions = body?.documentPreconditions;
      assert(
        preconditions?.operationId &&
          preconditions.expectedRevisionId &&
          preconditions.expectedScopes?.structure,
        "Dashboard metadata/delete omitted captured revision preconditions",
      );
      const response = await route.fetch();
      if (request.method() === "DELETE" && response.ok()) {
        deleted = true;
        deletionId = preconditions.operationId;
        return route.abort("failed");
      }
      return route.fulfill({ response });
    } catch (error) {
      guardFailure ??= error;
      await route.abort("failed").catch(() => undefined);
    }
  };
  await context.route(pattern, guard);
  const recoverReads = [];
  const observe = (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      pathname.startsWith("/api/books/document-creation-operations/")
    )
      recoverReads.push(pathname);
  };
  context.on("request", observe);
  const projectOptions = () =>
    page.getByRole("button", {
      name: `Project options for ${title}`,
      exact: true,
    });
  const openEdit = async () => {
    await projectOptions().click();
    await page
      .getByRole("menuitem", { name: "Edit Details", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit Project",
      exact: true,
    });
    await dialog.getByLabel("Title", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="dialog"] button')].some(
        (button) =>
          button.textContent.trim() === "Save Changes" && !button.disabled,
      ),
    );
    return dialog;
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await context.addCookies([
      { name: "proser-view", value: "desktop", url: new URL("/", base).href },
    ]);
    await page.goto(new URL("/", base).href);
    await page
      .getByRole("button", { name: "New Project", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "Create New Project",
      exact: true,
    });
    await create.getByLabel("Title", { exact: true }).fill(title);
    await create
      .getByLabel("Summary", { exact: true })
      .fill("Disposable acceptance. No generation.");
    await create
      .getByRole("button", { name: "Create & Begin", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Recover.*creat|Recover.*project/i })
      .first()
      .waitFor({ timeout: 30000 });
    await page.reload();
    await page
      .getByRole("button", { name: /Recover.*creat|Recover.*project/i })
      .first()
      .click();
    await page
      .getByRole("complementary", {
        name: "Project creation recovery",
        exact: true,
      })
      .waitFor({ state: "hidden", timeout: 30000 });
    await projectOptions().waitFor({ timeout: 30000 });
    assert.equal(
      writes.filter((entry) => entry.method === "POST").length,
      1,
      "Recovery sent another creation POST",
    );
    assert(
      recoverReads.some((url) => url.endsWith(`/${creationId}`)),
      "Reload recovery did not inspect the original receipt",
    );
    assert.equal(ids.size, 1);
    const bookId = [...ids][0];
    report.bookCatalog.createdBookIds = [...ids];
    report.checks.push(
      "ordinary New Project persists an operation ID and recovers lost creation acknowledgement after reload without another POST",
    );

    await page.goto(new URL(`/manuscript?bookId=${bookId}`, base).href);
    await page
      .getByLabel("Scene title", { exact: true })
      .fill("Opening fixture scene");
    await page
      .getByLabel("Scene brief (optional)", { exact: true })
      .fill("A fixture scene created without inference.");
    // Native Enter uses the inline form; no hidden structure route or modal.
    await page.getByLabel("Scene title", { exact: true }).press("Enter");
    const native = page.getByRole("textbox", {
      name: "Canvas writing input",
      exact: true,
    });
    await native.waitFor({ timeout: 30000 });
    assert(sceneTarget && sceneTarget.bookId === bookId);
    const marker = "R2 first scene begins here.";
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/books/${bookId}/scenes/${sceneTarget.sceneId}/document-passages/operations`,
      { timeout: 30000 },
    );
    await page
      .getByRole("region", { name: "Page editing surface", exact: true })
      .focus();
    await native.pressSequentially(marker);
    assert.equal((await save).status(), 200);
    await page.getByText("Saved", { exact: true }).first().waitFor();
    const scene = await call(
      `/api/books/${bookId}/scenes/${sceneTarget.sceneId}/document`,
    );
    assert.equal(scene.projection.text.trim(), marker);
    report.bookCatalog.firstScene = {
      ...sceneTarget,
      revisionId: scene.revisionId,
      contentHash: scene.contentHash,
    };
    report.checks.push(
      "a new empty book creates its first scene through a captured structured operation using native Enter, then saves native Canvas typing without generation",
    );
    await page.goto(new URL("/", base).href);

    let dialog = await openEdit();
    await dialog
      .getByLabel("Summary", { exact: true })
      .fill("An obsolete edit must not overwrite a newer revision.");
    const head = await call(`/api/books/${bookId}/document-manifest`);
    await call(
      `/api/books/${bookId}`,
      {
        summary: "Newer owned fixture metadata.",
        documentPreconditions: {
          operationId: randomUUID(),
          expectedRevisionId: head.revisionId,
          expectedScopes: { structure: head.scopes.structure.revisionId },
        },
      },
      "PUT",
    );
    const staleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/books/${bookId}`,
    );
    await dialog
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    assert.equal(
      (await staleResponse).status(),
      412,
      "Stale Dashboard details did not reject the captured old revision",
    );
    const scope = await call(`/api/books/${bookId}/document-scopes/structure`);
    assert.equal(scope.content.book.summary, "Newer owned fixture metadata.");
    await page
      .getByRole("button", { name: /Discard.*reject|Dismiss.*reject/i })
      .first()
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 30000 });
    report.checks.push(
      "ordinary project details preserve the dialog's exact source revision and reject a stale metadata edit without overwriting newer content",
    );

    dialog = await openEdit();
    await dialog
      .getByLabel("Summary", { exact: true })
      .fill("Reviewed current fixture metadata.");
    await dialog
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 30000 });
    const updated = await call(
      `/api/books/${bookId}/document-scopes/structure`,
    );
    assert.equal(
      updated.content.book.summary,
      "Reviewed current fixture metadata.",
    );
    await projectOptions().click();
    await page
      .getByRole("menuitem", { name: "Delete Project", exact: true })
      .click();
    const removal = page.getByRole("dialog", {
      name: "Delete Project",
      exact: true,
    });
    const remove = removal.getByRole("button", {
      name: "Delete Project",
      exact: true,
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="dialog"] button')].some(
        (button) =>
          button.textContent.trim() === "Delete Project" && !button.disabled,
      ),
    );
    await remove.click();
    await page
      .getByRole("button", {
        name: "Recover original project change",
        exact: true,
      })
      .waitFor({ timeout: 30000 });
    await page.reload();
    const recoveredDelete = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/books/${bookId}/document-operations/${deletionId}`,
    );
    await page
      .getByRole("button", {
        name: "Recover original project change",
        exact: true,
      })
      .click();
    assert.equal(
      (await recoveredDelete).status(),
      200,
      "A tombstoned owned book could not recover its original deletion receipt",
    );
    await page
      .getByRole("complementary", {
        name: "Project change recovery",
        exact: true,
      })
      .waitFor({ state: "hidden", timeout: 30000 });
    assert(
      deleted,
      "Normal UI did not acknowledge its revision-guarded tombstone",
    );
    assert.equal(writes.filter((entry) => entry.method === "DELETE").length, 1);
    assert.deepEqual(forbidden, []);
    report.bookCatalog.tombstonedBookIds = [...ids];
    report.checks.push(
      "ordinary project details commit captured revisions and a lost deletion acknowledgement recovers its original owned tombstone receipt after reload without a second DELETE",
    );
    await page.screenshot({
      path: path.join(output, "dashboard-catalog-acceptance.png"),
    });
  } catch (error) {
    failure = error;
  } finally {
    context.off("request", observe);
    await context.unroute(pattern, guard);
    // A failed transport may conceal a committed creation identity. Discover
    // only our exact unique title; never replay its original request.
    if (!ids.size && creationId) {
      try {
        const owned = await call("/api/books?pageSize=100");
        for (const book of owned.books ?? [])
          if (book.title === title) ids.add(String(book.id));
      } catch (error) {
        failure ??= error;
      }
    }
    if (!deleted) {
      for (const bookId of ids) {
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
          report.bookCatalog.tombstonedBookIds.push(bookId);
        } catch (error) {
          failure ??= error;
        }
      }
    }
  }
  if (guardFailure) throw guardFailure;
  if (failure) throw failure;
}
