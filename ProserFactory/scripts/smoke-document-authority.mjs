/** Application-controlled smoke over genuine revision-bound HTTP contracts.
 * Preserves every audit/operation/original. No inference or image-provider call. */
import { randomUUID, createHash } from "node:crypto";
const canonical = (value) =>
  JSON.stringify(
    (function normalize(item) {
      return Array.isArray(item)
        ? item.map(normalize)
        : item && typeof item === "object"
          ? Object.fromEntries(
              Object.entries(item)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, normalize(v)]),
            )
          : item;
    })(value),
  );
const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}
export async function runDocumentAuthoritySmoke({
  request,
  headers,
  userId,
  bookId,
  foreignHeaders,
  retainBook = false,
  ok = () => {},
}) {
  const operationIds = [],
    evidence = {
      schemaVersion: 1,
      kind: "structured-deployed-http-smoke",
      userId,
      bookId,
      providerDispatches: 0,
      operationIds,
    };
  const call = async (
    method,
    route,
    body,
    expected = [200],
    auth = headers,
  ) => {
    const result = await request(method, route, body, auth);
    requireValue(
      expected.includes(result.status),
      `${method} ${route}: status=${result.status}, code=${result.json?.error?.code ?? "none"}`,
    );
    return result.json?.data;
  };
  let created = false;
  try {
    const capability = await call("GET", "/api/books/document-capabilities");
    requireValue(
      capability.enabled &&
        capability.schemaVersion === 1 &&
        capability.passageOperations === "typed-operations-v1",
      "Installed document authority lacks required capabilities.",
    );
    requireValue(
      capability.actorId === userId,
      "Authenticated actor differs from the fixture.",
    );
    if (!bookId) {
      const operationId = randomUUID();
      operationIds.push(operationId);
      const book = await call(
        "POST",
        "/api/books",
        {
          operationId,
          title: "Disposable structured release smoke",
          genre: "fantasy",
          summary: "Synthetic release fixture.",
        },
        [201],
      );
      bookId = book.id;
      created = true;
      evidence.bookId = bookId;
    }
    const root = `/api/books/${bookId}`,
      manifest = await call("GET", root + "/document-manifest");
    let sceneId = manifest.scenes.find((scene) => !scene.deletedAt)?.sceneId;
    if (!sceneId) {
      requireValue(
        created,
        "Pre-admitted canary must already own a scene; this smoke never creates hierarchy while fenced.",
      );
      const operationId = randomUUID();
      operationIds.push(operationId);
      const draft = await call(
        "POST",
        root + "/document-quick-drafts",
        {
          schemaVersion: 1,
          operationId,
          expectedRevisionId: manifest.revisionId,
          expectedScopes: { structure: manifest.scopes.structure.revisionId },
          summary: "Synthetic release canary",
          outline: "No model/provider effect.",
        },
        [201],
      );
      sceneId = draft.result.sceneId;
    }
    evidence.sceneId = sceneId;
    const passageRoute = `${root}/scenes/${sceneId}/document-passages`,
      query = "?maxCharacters=512&maxParagraphs=4&maxRuns=32&projection=final";
    let passage = await call("GET", passageRoute + query);
    const payload = (operations, tracking = false) => ({
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: passage.bookRevisionId,
      expectedSceneRevisionId: passage.sceneRevisionId,
      sourceFrame: passage.sourceFrame,
      windowHash: passage.windowHash,
      cursor: passage.cursor,
      maxCharacters: 512,
      maxParagraphs: 4,
      maxRuns: 32,
      operations,
      tracking,
    });
    const target = (p, source, from = source.from, to = source.to) => ({
      blockId: p.paragraph.id,
      paragraphHash: p.paragraphHash,
      containerHash: p.containerHash,
      runId: source.runId,
      sourceHash: source.sourceHash,
      from,
      to,
    });
    let paragraph = passage.paragraphs[0];
    requireValue(
      paragraph && !paragraph.continuedBefore && !paragraph.continuedAfter,
      "Fixture must start with one complete bounded editable paragraph.",
    );
    let runSource = paragraph.runs[0];
    requireValue(
      runSource,
      "Fixture paragraph needs a qualified canonical run.",
    );
    const beforeHash = passage.contentHash,
      beforeRevision = passage.sceneRevisionId;
    const edit = payload([
      {
        id: randomUUID(),
        kind: "text",
        target: target(paragraph, runSource, runSource.to, runSource.to),
        expectedText: "",
        replacement: " Canvas release canary 😀.",
      },
    ]);
    operationIds.push(edit.operationId);
    const saved = await call("POST", passageRoute + "/operations", edit);
    requireValue(
      saved.status === "completed" &&
        !Object.hasOwn(saved, "scenes") &&
        saved.result.passage.contentHash !== beforeHash,
      "Save must acknowledge a changed immutable sparse revision.",
    );
    const recovered = await call(
      "GET",
      root + `/document-operations/${edit.operationId}`,
    );
    requireValue(
      hash(recovered) === hash(saved),
      "Lost acknowledgement must recover the same immutable operation.",
    );
    const stale = await request(
      "POST",
      passageRoute + "/operations",
      { ...edit, operationId: randomUUID() },
      headers,
    );
    requireValue(
      stale.status === 412,
      "A stale independent writer must receive 412.",
    );
    passage = await call("GET", passageRoute + query);
    requireValue(
      passage.contentHash === saved.result.passage.contentHash &&
        passage.sceneRevisionId === saved.result.passage.sceneRevisionId,
      "Save/reopen hash and revision must agree.",
    );
    ok(
      "Sparse save, durable receipt recovery, reload and stale-write rejection",
    );
    paragraph = passage.paragraphs[0];
    runSource = paragraph.runs.find((source) => source.to > source.from);
    requireValue(runSource, "Inserted fixture run must be editable.");
    const run = paragraph.paragraph.runs.find(
        (run) => run.id === runSource.runId,
      ),
      text = run.text;
    const format = payload(
      [
        {
          id: randomUUID(),
          kind: "run-format",
          target: target(paragraph, runSource),
          expectedText: text,
          patch: { set: { bold: true } },
        },
      ],
      true,
    );
    operationIds.push(format.operationId);
    const formatted = await call("POST", passageRoute + "/operations", format);
    passage = formatted.result.passage;
    const change = passage.changeSummaries.find(
      (change) => change.kind === "format" && change.status === "pending",
    );
    requireValue(
      change && change.authorId === userId,
      "Formatting must create an authenticated durable pending change.",
    );
    const resolve = payload([
      {
        id: randomUUID(),
        kind: "resolve-change",
        changeId: change.id,
        changeHash: change.recordHash,
        targetHash: change.targetHash,
        decision: "accepted",
      },
    ]);
    operationIds.push(resolve.operationId);
    const resolved = await call("POST", passageRoute + "/operations", resolve);
    passage = resolved.result.passage;
    const accepted = passage.changeSummaries.find(
      (row) => row.id === change.id,
    );
    requireValue(
      accepted?.status === "accepted" && accepted.resolutionCount === 1,
      "Acceptance must retain durable resolution provenance.",
    );
    ok("Tracked formatting and explicit authenticated resolution");
    if (foreignHeaders) {
      for (const route of [
        root + "/document-manifest",
        passageRoute + query,
        root + `/document-operations/${edit.operationId}`,
      ]) {
        const denied = await request("GET", route, null, foreignHeaders);
        requireValue(
          denied.status === 404,
          "Foreign identity must not access owned documents/receipts.",
        );
      }
      ok("Document and receipt ownership isolation");
    }
    const capabilityExport = await call(
      "GET",
      root + "/document-publication-capabilities",
    );
    requireValue(
      capabilityExport.formats?.some(
        (format) => format.format === "docx" && format.available,
      ),
      "Factory must advertise a genuine available DOCX codec.",
    );
    const current = await call("GET", root + "/document-manifest"),
      jobId = randomUUID();
    operationIds.push(jobId);
    let job = await call(
      "POST",
      root + "/document-publication-jobs",
      {
        operationId: jobId,
        expectedRevisionId: current.revisionId,
        options: {
          format: "docx",
          mode: "retain-review",
          preset: "submission-manuscript",
        },
      },
      [200, 202],
    );
    const deadline = Date.now() + 60000;
    while (
      ["pending", "running"].includes(job.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await call("GET", root + `/document-publication-jobs/${job.id}`);
    }
    requireValue(
      job.status === "completed" && job.artifactId,
      "Publication must complete with persisted immutable bytes. Recover the same job if interrupted; no effect replay.",
    );
    const artifact = await call(
        "GET",
        root + `/document-publication-artifacts/${job.artifactId}`,
      ),
      download = await request(
        "GET",
        root + `/document-publication-artifacts/${job.artifactId}/download`,
        null,
        headers,
      );
    requireValue(
      download.status === 200 &&
        download.bytes?.subarray(0, 2).toString() === "PK" &&
        createHash("sha256").update(download.bytes).digest("hex") ===
          artifact.sha256,
      "DOCX bytes, ZIP signature and persisted checksum must agree.",
    );
    if (foreignHeaders) {
      const denied = await request(
        "GET",
        root + `/document-publication-artifacts/${job.artifactId}/download`,
        null,
        foreignHeaders,
      );
      requireValue(
        denied.status === 404,
        "Foreign artifact download must be inaccessible.",
      );
    }
    ok("Revision-bound genuine DOCX artifact and owned immutable download");
    Object.assign(evidence, {
      initialSceneRevisionId: beforeRevision,
      initialSceneHash: beforeHash,
      finalSceneRevisionId: passage.sceneRevisionId,
      finalSceneHash: passage.contentHash,
      bookRevisionId: current.revisionId,
      changeId: change.id,
      publicationJobId: job.id,
      artifactId: job.artifactId,
      artifactChecksum: artifact.sha256,
      retainedReview: true,
    });
    return evidence;
  } finally {
    if (bookId && !retainBook) {
      const root = `/api/books/${bookId}`,
        head = await call("GET", root + "/document-manifest");
      const operationId = randomUUID();
      operationIds.push(operationId);
      await call("DELETE", root, {
        documentPreconditions: {
          operationId,
          expectedRevisionId: head.revisionId,
          expectedScopes: { structure: head.scopes.structure.revisionId },
        },
      });
      evidence.tombstoneOperationId = operationId;
      ok(
        "Disposable book tombstoned; users, originals, revisions and operation evidence preserved",
      );
    } else if (bookId)
      evidence.cleanup =
        "retained disposable owned book for authenticated browser canary; operator tombstones after all checks";
  }
}
