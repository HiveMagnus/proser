import { randomUUID } from "node:crypto";
import request from "supertest";
import app from "@/index";
import { databaseService } from "@/lib/database";
import { documentService } from "@/documents/service";
import { documentFromText, projectDocument } from "@/documents/model";
import {
  passageOperationRunSource,
  passageOperationParagraphSource,
} from "@/documents/passageOperationSources";
import { SceneProseService } from "@/services/sceneProseService";
import {
  createStoryDiscussion,
  readStoryDiscussion,
  requestStoryProposal,
  readStoryProposal,
  revalidateStoryProposal,
  applyStoryProposal,
  cancelStoryProposal,
  commitStoryDraft,
} from "@/documents/storyProposals";
import {
  ownedStorySource,
  storyDigest,
} from "@/documents/storyProposalSources";
import type {
  DocumentStoryDiscussionInput,
  DocumentStoryDiscussionSnapshot,
} from "@/documents/story-proposal-model";
describe("explicit owned ancillary-story discussions and tracked proposals", () => {
  const db = () => databaseService.client;
  let userId: number,
    otherUserId: number,
    bookId: number,
    sceneId: number,
    storyId: string,
    githubId: string;
  const previous = process.env.DOCUMENT_AUTHORITY_ENABLED,
    capacity = process.env.DOCUMENT_AI_CONTEXT_TOKENS;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
    process.env.DOCUMENT_AI_CONTEXT_TOKENS = "32768";
    githubId = `story-ai-${randomUUID()}`;
    userId = (
      await db().user.create({ data: { githubId, username: "Story author" } })
    ).id;
    otherUserId = (
      await db().user.create({
        data: {
          githubId: `other-story-ai-${randomUUID()}`,
          username: "Other author",
        },
      })
    ).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({
      data: {
        userId,
        title: "Disposable story AI book",
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: {
                chapterNumber: 1,
                scenes: {
                  create: {
                    sceneNumber: 1,
                    prose: "Scene prose must remain untouched.",
                  },
                },
              },
            },
          },
        },
      },
      include: {
        acts: { include: { chapters: { include: { scenes: true } } } },
      },
    });
    bookId = book.id;
    sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
    const layout = await documentService.scope(userId, bookId, "layout");
    storyId = randomUUID();
    const document = documentFromText(
      "Repeated story phrase.\n\nRepeated story phrase.",
      randomUUID,
    );
    document.layout.font = "Liberation Serif";
    for (const paragraph of document.blocks)
      if (paragraph.type === "paragraph")
        paragraph.runs[0].style = { bold: true, italic: true };
    layout.content.headerFooterStories = [
      { id: storyId, owner: "book", kind: "header", document },
    ];
    const cell = documentFromText("Protected table 😀 é.", randomUUID)
      .blocks[0];
    if (cell.type !== "paragraph") throw new Error("fixture");
    document.blocks.push({
      type: "table",
      id: randomUUID(),
      widths: [180],
      rows: [
        { id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [cell] }] },
      ],
    });
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: layout.bookRevisionId,
        expectedScopes: { layout: layout.revisionId },
        payload: { fixture: "owned-story" },
      },
      async () => ({ result: null, layout: layout.content }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db().documentStoryProposalValidation.deleteMany({
      where: { bookId },
    });
    await db().documentStoryProposal.deleteMany({ where: { bookId } });
    await db().documentStoryDiscussion.deleteMany({ where: { bookId } });
    const bindings = await db().releaseAdmissionBinding.findMany({
      where: { sourceBookId: bookId },
      select: { admissionId: true },
    });
    await db().releaseAdmissionBinding.deleteMany({
      where: { sourceBookId: bookId },
    });
    await db().releaseMutationAdmission.deleteMany({
      where: { id: { in: bindings.map((row) => row.admissionId) } },
    });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED;
    else process.env.DOCUMENT_AUTHORITY_ENABLED = previous;
    if (capacity === undefined) delete process.env.DOCUMENT_AI_CONTEXT_TOKENS;
    else process.env.DOCUMENT_AI_CONTEXT_TOKENS = capacity;
    await db().user.deleteMany({
      where: { id: { in: [userId, otherUserId] } },
    });
  });
  const context = async (): Promise<DocumentStoryDiscussionInput> => {
    const source = await ownedStorySource(db(), userId, bookId, storyId),
      paragraph = source.document.blocks[1];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    const text = paragraph.runs.map((run) => run.text).join("");
    return {
      schemaVersion: 1,
      operationId: randomUUID(),
      sessionId: randomUUID(),
      storyId,
      expectedRevisionId: source.bookRevisionId,
      expectedLayoutRevisionId: source.layoutRevisionId,
      expectedContentHash: source.contentHash,
      projection: "final",
      targets: [
        { blockId: paragraph.id, from: 0, to: text.length, sourceText: text },
      ],
    };
  };
  const model = () =>
    jest
      .spyOn(SceneProseService.prototype, "proposeDocumentEdits")
      .mockImplementation(async (snapshot) => ({
        raw: JSON.stringify({
          reply: "Owned story reply.",
          edits: [
            {
              targetId: snapshot.targets[0].targetId,
              sourceText: snapshot.targets[0].sourceText,
              replacement: "Revised story wording.",
            },
          ],
        }),
        provenance: {
          providerId: "fixture",
          params: {},
          recipe: "document-proposal",
          recipeVersion: snapshot.templateVersion,
        },
      }));
  const validate = async (id: string) => {
    const source = await ownedStorySource(db(), userId, bookId, storyId);
    return revalidateStoryProposal(userId, bookId, id, {
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      expectedLayoutRevisionId: source.layoutRevisionId,
    });
  };
  test("saved story context contains no invented scene identity and tracked application preserves the actual scene and table", async () => {
    const inference = model(),
      before = await ownedStorySource(db(), userId, bookId, storyId),
      scene = await documentService.read(userId, bookId, sceneId);
    const input = await context(),
      discussion = await createStoryDiscussion(userId, bookId, input),
      snapshot =
        discussion.snapshot as unknown as DocumentStoryDiscussionSnapshot;
    expect(snapshot).toMatchObject({
      sourceKind: "layout-story",
      storyId,
      sourceLayoutRevisionId: before.layoutRevisionId,
      unsaved: false,
    });
    expect(Object.hasOwn(snapshot, "sceneId")).toBe(false);
    expect(Object.hasOwn(snapshot, "sourceSceneRevisionId")).toBe(false);
    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.omitted.blockIds).toContain(before.document.blocks[0].id);
    const operation = {
        operationId: randomUUID(),
        instruction: "Revise the selected header paragraph.",
      },
      proposal = await requestStoryProposal(
        userId,
        bookId,
        discussion.id,
        operation,
      );
    expect(proposal.status).toBe("ready");
    expect(
      await requestStoryProposal(userId, bookId, discussion.id, operation),
    ).toEqual(proposal);
    expect(inference).toHaveBeenCalledTimes(1);
    const verified = await validate(proposal.id),
      apply = {
        operationId: randomUUID(),
        expectedRevisionId: verified.bookRevisionId,
        expectedLayoutRevisionId: verified.layoutRevisionId,
        validationId: verified.id,
        targetIds: [snapshot.targets[0].targetId],
      };
    const receipt = await applyStoryProposal(
      userId,
      bookId,
      proposal.id,
      apply,
    );
    expect(
      await applyStoryProposal(userId, bookId, proposal.id, apply),
    ).toEqual(receipt);
    expect(Object.hasOwn(receipt, "scenes")).toBe(false);
    const after = await ownedStorySource(db(), userId, bookId, storyId);
    expect(projectDocument(after.document).text).toContain(
      "Revised story wording.",
    );
    expect(projectDocument(after.document, "original").text).toBe(
      projectDocument(before.document).text,
    );
    expect(after.document.blocks[0]).toEqual(before.document.blocks[0]);
    expect(after.document.blocks[2]).toEqual(before.document.blocks[2]);
    expect(
      after.document.changes.every(
        (change) =>
          change.origin === "ai" &&
          change.status === "pending" &&
          change.authorId === userId &&
          change.authorName === "Story author",
      ),
    ).toBe(true);
    expect(
      (await documentService.read(userId, bookId, sceneId)).document,
    ).toEqual(scene.document);
  });
  test("bounded unsaved story text intents flush the same deterministic IDs before explicit revalidation", async () => {
    model();
    const input = await context(),
      source = await ownedStorySource(db(), userId, bookId, storyId),
      paragraph = source.document.blocks[1];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    const operationId = randomUUID();
    input.localOperations = {
      operationId,
      operations: [
        {
          id: randomUUID(),
          kind: "text",
          target: passageOperationRunSource(
            source.document,
            paragraph.id,
            paragraph.runs[0].id,
          ),
          expectedText: "Repeated story phrase.",
          replacement: "Local header draft.",
        },
      ],
    };
    input.targets = [
      {
        blockId: paragraph.id,
        from: 0,
        to: 19,
        sourceText: "Local header draft.",
      },
    ];
    const discussion = await createStoryDiscussion(userId, bookId, input);
    expect(
      (discussion.snapshot as unknown as DocumentStoryDiscussionSnapshot)
        .unsaved,
    ).toBe(true);
    expect(
      (await readStoryDiscussion(userId, bookId, discussion.id))
        .draftOperations,
    ).toEqual(input.localOperations);
    expect(JSON.stringify(discussion.request).length).toBeLessThan(2048);
    const proposal = await requestStoryProposal(userId, bookId, discussion.id, {
      operationId: randomUUID(),
      instruction: "Review local draft.",
    });
    expect(proposal.status).toBe("ready");
    await expect(validate(proposal.id)).rejects.toMatchObject({
      code: "DOCUMENT_TARGET_STALE",
    });
    const commit = {
      schemaVersion: 1,
      operationId,
      expectedRevisionId: source.bookRevisionId,
      expectedLayoutRevisionId: source.layoutRevisionId,
      expectedContentHash: source.contentHash,
      operations: input.localOperations.operations,
    };
    const receipt = await commitStoryDraft(userId, bookId, storyId, commit);
    expect(await commitStoryDraft(userId, bookId, storyId, commit)).toEqual(
      receipt,
    );
    const flushed = await ownedStorySource(db(), userId, bookId, storyId);
    expect(receipt.result).toMatchObject({
      sourceKind: "layout-story",
      storyId,
      contentHash: flushed.contentHash,
      layoutRevisionId: flushed.layoutRevisionId,
    });
    expect(Object.hasOwn(receipt.result, "document")).toBe(false);
    expect((await validate(proposal.id)).layoutRevisionId).toBe(
      flushed.layoutRevisionId,
    );
  });
  test("stale owner context, changed formatting and cross-user access reject without inference replay", async () => {
    const inference = model(),
      discussion = await createStoryDiscussion(userId, bookId, await context()),
      proposal = await requestStoryProposal(userId, bookId, discussion.id, {
        operationId: randomUUID(),
        instruction: "Review.",
      });
    await expect(
      readStoryProposal(otherUserId, bookId, proposal.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createStoryDiscussion(otherUserId, bookId, await context()),
    ).rejects.toMatchObject({ status: 404 });
    const layout = await documentService.scope(userId, bookId, "layout");
    layout.content.book.fontSize += 2;
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: layout.bookRevisionId,
        expectedScopes: { layout: layout.revisionId },
        payload: { fixture: "layout-changed" },
      },
      async () => ({ result: null, layout: layout.content }),
    );
    await expect(validate(proposal.id)).rejects.toMatchObject({
      code: "DOCUMENT_TARGET_STALE",
    });
    expect(inference).toHaveBeenCalledTimes(1);
  });
  test("exact unknown provider effects never replay; cancellation suppresses late application while retaining response", async () => {
    const discussion = await createStoryDiscussion(
        userId,
        bookId,
        await context(),
      ),
      inference = jest
        .spyOn(SceneProseService.prototype, "proposeDocumentEdits")
        .mockRejectedValue(new Error("Lost provider acknowledgement")),
      input = { operationId: randomUUID(), instruction: "Discuss." };
    expect(
      (await requestStoryProposal(userId, bookId, discussion.id, input)).status,
    ).toBe("unknown");
    expect(
      (await requestStoryProposal(userId, bookId, discussion.id, input)).status,
    ).toBe("unknown");
    expect(inference).toHaveBeenCalledTimes(1);
    const cancelled = { operationId: randomUUID(), instruction: "Cancel." };
    inference.mockImplementation(async (_snapshot, _instruction, options) => {
      await cancelStoryProposal(userId, bookId, cancelled.operationId);
      expect(options?.signal?.aborted).toBe(true);
      return {
        raw: JSON.stringify({ reply: "Late reply.", edits: [] }),
        provenance: {
          providerId: "fixture",
          params: {},
          recipe: "document-proposal",
          recipeVersion: "1.0.0",
        },
      };
    });
    const result = await requestStoryProposal(
      userId,
      bookId,
      discussion.id,
      cancelled,
    );
    expect(result.status).toBe("cancelled");
    expect(result.result).toMatchObject({ output: { reply: "Late reply." } });
    await expect(validate(result.id)).rejects.toMatchObject({ status: 409 });
  });
  test("full giant target blocks reject before provider dispatch and invalid typed identity proof is rejected", async () => {
    const inference = model(),
      input = await context(),
      source = await ownedStorySource(db(), userId, bookId, storyId),
      paragraph = source.document.blocks[1];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    input.localOperations = {
      operationId: randomUUID(),
      operations: [
        {
          id: randomUUID(),
          kind: "text",
          target: {
            ...passageOperationRunSource(
              source.document,
              paragraph.id,
              paragraph.runs[0].id,
            ),
            sourceHash: "f".repeat(64),
          },
          expectedText: "Repeated story phrase.",
          replacement: "Forged.",
        },
      ],
    };
    await expect(
      createStoryDiscussion(userId, bookId, input),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_STALE" });
    const layout = await documentService.scope(userId, bookId, "layout");
    const story = layout.content.headerFooterStories!.find(
      (item) => item.id === storyId,
    )!;
    story.document = documentFromText("word ".repeat(20000), randomUUID);
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: layout.bookRevisionId,
        expectedScopes: { layout: layout.revisionId },
        payload: { fixture: "giant-story" },
      },
      async () => ({ result: null, layout: layout.content }),
    );
    const giant = await ownedStorySource(db(), userId, bookId, storyId),
      block = giant.document.blocks[0];
    const raw = {
      schemaVersion: 1,
      operationId: randomUUID(),
      sessionId: randomUUID(),
      storyId,
      expectedRevisionId: giant.bookRevisionId,
      expectedLayoutRevisionId: giant.layoutRevisionId,
      expectedContentHash: giant.contentHash,
      projection: "final",
      targets: [{ blockId: block.id, from: 0, to: 4, sourceText: "word" }],
    };
    await expect(
      createStoryDiscussion(userId, bookId, raw),
    ).rejects.toMatchObject({
      code: "DOCUMENT_CONTEXT_TOO_LARGE",
      status: 413,
    });
    expect(inference).not.toHaveBeenCalled();
    expect(
      await db().documentStoryDiscussion.findUnique({
        where: { id: raw.operationId },
      }),
    ).toBeNull();
  });

  test("saved story history and exact pinned source remain recoverable after story removal", async () => {
    const source = await ownedStorySource(db(), userId, bookId, storyId),
      input = await context(),
      discussion = await createStoryDiscussion(userId, bookId, input);
    const layout = await documentService.scope(userId, bookId, "layout");
    layout.content.headerFooterStories = [];
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: layout.bookRevisionId,
        expectedScopes: { layout: layout.revisionId },
        payload: { fixture: "removed-story" },
      },
      async () => ({ result: null, layout: layout.content }),
    );
    await expect(
      ownedStorySource(db(), userId, bookId, storyId),
    ).rejects.toMatchObject({ status: 404 });
    expect((await readStoryDiscussion(userId, bookId, discussion.id)).id).toBe(
      discussion.id,
    );
    const auth = (value: request.Test) =>
      value
        .set("x-user-id", String(userId))
        .set("x-github-id", githubId)
        .set("x-username", "Story author");
    const pinned = await auth(
      request(app).get(
        `/api/books/${bookId}/layout-stories/${storyId}/document?bookRevisionId=${source.bookRevisionId}`,
      ),
    );
    expect(pinned.status).toBe(200);
    expect(pinned.body.data).toMatchObject({
      bookRevisionId: source.bookRevisionId,
      layoutRevisionId: source.layoutRevisionId,
      contentHash: source.contentHash,
    });
    const history = await auth(
      request(app).get(
        `/api/books/${bookId}/document-story-discussions?storyId=${storyId}`,
      ),
    );
    expect(history.status).toBe(200);
    expect(history.body.data.map((row: { id: string }) => row.id)).toContain(
      discussion.id,
    );
  });
  test("bounded unsaved story formatting uses exact saved ownership and flushes without flattening styles", async () => {
    model();
    const source = await ownedStorySource(db(), userId, bookId, storyId),
      input = await context(),
      paragraph = source.document.blocks[1];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    const operationId = randomUUID();
    input.localOperations = {
      operationId,
      operations: [
        {
          id: randomUUID(),
          kind: "run-format",
          target: passageOperationRunSource(
            source.document,
            paragraph.id,
            paragraph.runs[0].id,
          ),
          expectedText: paragraph.runs[0].text,
          patch: { set: { underline: true } },
        },
        {
          id: randomUUID(),
          kind: "paragraph-format",
          target: passageOperationParagraphSource(
            source.document,
            paragraph.id,
          ),
          patch: { set: { alignment: "center" } },
        },
      ],
    };
    const discussion = await createStoryDiscussion(userId, bookId, input),
      proposal = await requestStoryProposal(userId, bookId, discussion.id, {
        operationId: randomUUID(),
        instruction: "Keep supported styles.",
      });
    await commitStoryDraft(userId, bookId, storyId, {
      schemaVersion: 1,
      operationId,
      expectedRevisionId: source.bookRevisionId,
      expectedLayoutRevisionId: source.layoutRevisionId,
      expectedContentHash: source.contentHash,
      operations: input.localOperations.operations,
    });
    const current = await ownedStorySource(db(), userId, bookId, storyId),
      block = current.document.blocks[1];
    if (block.type !== "paragraph") throw new Error("fixture");
    expect(block.runs[0].style).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
    });
    expect(block.style.alignment).toBe("center");
    expect((await validate(proposal.id)).layoutRevisionId).toBe(
      current.layoutRevisionId,
    );
    expect(current.document.blocks[2]).toEqual(source.document.blocks[2]);
  });
  test("authenticated relative API requires scope preconditions, preserves source ETag and never accepts a scene substitute", async () => {
    const auth = (value: request.Test) =>
      value
        .set("x-user-id", String(userId))
        .set("x-github-id", githubId)
        .set("x-username", "Story author");
    const source = await ownedStorySource(db(), userId, bookId, storyId),
      get = await auth(
        request(app).get(
          `/api/books/${bookId}/layout-stories/${storyId}/document`,
        ),
      );
    expect(get.status).toBe(200);
    expect(get.headers.etag).toContain(source.layoutRevisionId);
    expect(get.body.data).toMatchObject({
      sourceKind: "layout-story",
      storyId,
      contentHash: source.contentHash,
    });
    expect(get.body.data.sceneId).toBeUndefined();
    const missing = await auth(
      request(app).post(`/api/books/${bookId}/document-story-discussions`),
    ).send({});
    expect(missing.status).toBe(428);
    const forbidden = await auth(
      request(app).post(`/api/books/${bookId}/document-story-discussions`),
    ).send({ ...(await context()), sceneId });
    expect(forbidden.status).toBe(422);
    expect(storyDigest(source.document)).toBe(source.contentHash);
  });
});
