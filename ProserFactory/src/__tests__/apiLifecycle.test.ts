/// <reference types="jest" />
import request from "supertest";
import app from "../index";
import { databaseService } from "../lib/database";

const internalSecret =
  process.env.INTERNAL_API_SECRET || "jest-internal-secret";
const prefix = `jest-api-lifecycle-${Date.now()}`;

function internalAuth(r: request.Test) {
  return r.set("X-Internal-Secret", internalSecret);
}

function authFor(userId: number, githubId: string) {
  return (r: request.Test) =>
    r
      .set("x-user-id", String(userId))
      .set("x-github-id", githubId)
      .set("x-username", githubId)
      .set("idempotency-key", crypto.randomUUID());
}

async function syncUser(githubId: string) {
  const res = await internalAuth(request(app).post("/api/auth/sync-user")).send(
    {
      githubId,
      username: githubId,
      email: `${githubId}@example.test`,
    },
  );

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data.githubId).toBe(githubId);
  return res.body.data as { id: number; githubId: string; username: string };
}

async function cleanupUser(githubId: string) {
  return internalAuth(
    request(app).delete(`/api/auth/test-users/${encodeURIComponent(githubId)}`),
  );
}

describe("API lifecycle coverage", () => {
  beforeAll(() => {
    process.env.INTERNAL_API_SECRET = internalSecret;
  });

  afterAll(async () => {
    await databaseService.client.user.deleteMany({
      where: { githubId: { startsWith: prefix } },
    });
  });

  it("serves API discovery, docs, readiness, and auth envelopes", async () => {
    const root = await request(app).get("/api");
    expect(root.status).toBe(200);
    expect(root.body.success).toBe(true);
    expect(root.body.data.endpoints.books).toBe("/api/books");

    const docs = await request(app).get("/api/docs.json");
    expect(docs.status).toBe(200);
    expect(docs.body.openapi).toBeDefined();
    expect(docs.body.paths["/api/books"]).toBeDefined();
    expect(docs.body.paths["/api/books/{bookId}/structure"].post).toBeDefined();
    expect(
      docs.body.paths["/api/books/{bookId}/reorder-acts"].post,
    ).toBeDefined();
    expect(
      docs.body.paths["/api/books/{bookId}/acts/{actId}/reorder-chapters"].post,
    ).toBeDefined();
    expect(
      docs.body.paths["/api/books/{bookId}/chapters/{chapterId}/reorder-scenes"]
        .post,
    ).toBeDefined();

    const favicon = await request(app).get("/favicon.ico");
    expect(favicon.status).toBe(204);
    expect(favicon.text).toBe("");

    const readiness = await request(app).get("/api/readiness");
    expect(readiness.status).toBe(200);
    expect(readiness.headers['cache-control']).toBe('no-store');
    expect(readiness.body.success).toBe(true);
    expect(readiness.body.data.ready).toBe(true);
    expect(readiness.body.data.components).toEqual({
      database: 'ready', redis: expect.stringMatching(/^(?:ready|healthy|disabled)$/),
      editorialRegistry: 'ready', editorialCorpus: 'ready',
      workers: 'disabled', redisPersistence: expect.stringMatching(/^(?:ready|disabled)$/),
      documentSchema: 'disabled', documentEnforcement: 'disabled', documentSearchIndex: 'disabled', documentSelectedAssets: 'disabled', assetStorage: 'disabled',
      artifactStorage: 'disabled', publicationRenderer: 'disabled', publicationFonts: 'disabled',
    });
    expect(readiness.body.data).not.toHaveProperty('runtime');
    expect(JSON.stringify(readiness.body)).not.toContain('INFERENCE');

    const unauthorized = await request(app).get("/api/books");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toEqual({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      },
    });
  });

  it("cleans internally synced test users and rejects unsafe cleanup targets", async () => {
    const githubId = `${prefix}-cleanup`;
    const user = await syncUser(githubId);
    const book = await databaseService.client.book.create({
      data: {
        userId: user.id,
        title: "Cleanup Fixture",
        genre: "test",
      },
    });
    await databaseService.client.ragChunk.create({
      data: {
        bookId: book.id,
        sourceType: "test",
        sourceId: `cleanup-${book.id}`,
        chunkText: "Cleanup fixture chunk.",
      },
    });
    await databaseService.client.ragEvalResult.create({
      data: {
        bookId: book.id,
        evalType: "cleanup",
        metrics: { ok: true },
        orchestrator: "jest",
      },
    });
    await databaseService.client.book.delete({ where: { id: book.id } });

    const missingSecret = await request(app).delete(
      `/api/auth/test-users/${encodeURIComponent(githubId)}`,
    );
    expect(missingSecret.status).toBe(401);
    expect(missingSecret.body.error.code).toBe("UNAUTHORIZED");

    const unsafe = await internalAuth(
      request(app).delete("/api/auth/test-users/real-user"),
    );
    expect(unsafe.status).toBe(403);
    expect(unsafe.body.error.code).toBe("FORBIDDEN");

    const releaseGithubId = `iam:proser-release-${Date.now()}`;
    await syncUser(releaseGithubId);
    const releaseCleanup = await cleanupUser(releaseGithubId);
    expect(releaseCleanup.status).toBe(200);
    expect(releaseCleanup.body.data.deleted).toBe(1);

    const cleanup = await cleanupUser(githubId);
    expect(cleanup.status).toBe(200);
    expect(cleanup.body.data.deleted).toBe(1);

    const deleted = await databaseService.client.user.findUnique({
      where: { id: user.id },
    });
    expect(deleted).toBeNull();
    const leftovers = await Promise.all([
      databaseService.client.book.findFirst({
        where: { id: book.id, deletedAt: { not: null } },
      }),
      databaseService.client.ragChunk.count({ where: { bookId: book.id } }),
      databaseService.client.ragEvalResult.count({
        where: { bookId: book.id },
      }),
    ]);
    expect(leftovers).toEqual([null, 0, 0]);
  });

  it("runs a book authoring lifecycle and leaves no test rows behind", async () => {
    const githubId = `${prefix}-author`;
    const user = await syncUser(githubId);
    const auth = authFor(user.id, githubId);

    const createdBook = await auth(request(app).post("/api/books")).send({
      title: "API Lifecycle Book",
      genre: "fantasy",
      targetAudience: "adult",
      summary: "A compact fixture for API lifecycle testing.",
    });
    expect(createdBook.status).toBe(201);
    const bookId = createdBook.body.data.id as number;

    const savedStructure = await auth(
      request(app).post(`/api/books/${bookId}/structure`),
    ).send({
      acts: [
        {
          title: "Act One",
          summary: "Opening movement",
          chapters: [{ title: "Chapter One", summary: "Arrival" }],
        },
      ],
    });
    expect(savedStructure.status).toBe(201);
    const actId = savedStructure.body.data.acts[0].id as number;
    const chapterId = savedStructure.body.data.acts[0].chapters[0].id as number;

    const scene = await auth(
      request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes`),
    ).send({
      outline: "The door opens.",
      prose: "The door opened with a hush, and the room remembered everyone.",
      summary: "A threshold scene.",
    });
    expect(scene.status).toBe(201);
    expect(scene.body.data.scene.wordCount).toBeGreaterThan(0);
    const sceneId = scene.body.data.scene.id as number;

    const fetchedScene = await auth(
      request(app).get(`/api/books/${bookId}/scenes/${sceneId}`),
    );
    expect(fetchedScene.status).toBe(200);
    expect(fetchedScene.body.data.scene).toMatchObject({
      id: sceneId,
      chapterId,
      actId,
      chapterTitle: "Chapter One",
      actTitle: "Act One",
    });

    const batchProse = await auth(
      request(app).post("/api/generate/prose/batch"),
    ).send({
      bookId,
      items: [
        {
          sceneId,
          instructions: "Draft one concise sentence for this threshold scene.",
          targetWords: 80,
        },
      ],
      maxConcurrency: 2,
      saveToScene: true,
      selectedModel: "test",
    });
    expect(batchProse.status).toBe(200);
    expect(batchProse.body.data).toMatchObject({
      requested: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      maxConcurrency: 1,
      saveToScene: true,
    });
    expect(batchProse.body.data.results[0]).toMatchObject({
      index: 0,
      status: "completed",
      sceneId,
      saved: true,
      prose: expect.any(String),
    });

    const codex = await auth(
      request(app).post(`/api/books/${bookId}/codex`),
    ).send({
      entryType: "lore",
      entryName: "Threshold Rooms",
      entryDescription: "Rooms that remember arrivals.",
      attributes: JSON.stringify({ source: "apiLifecycle" }),
    });
    expect(codex.status).toBe(201);

    const note = await auth(
      request(app).post(`/api/books/${bookId}/notes`),
    ).send({
      content: "Keep the room memory motif threaded through the chapter.",
    });
    expect(note.status).toBe(201);

    const review = await auth(request(app).post('/api/workflows/quality-review')).send({
      bookId,
      scope: { type: 'book' },
      model: 'test-review-model',
      rubricVersion: 'publishable-v1',
    });
    expect(review.status).toBe(202);
    expect(review.body.data).toMatchObject({ workflowType: 'quality_review', bookId, status: 'queued' });

    const workflowStatus = await auth(request(app).get(`/api/workflows/${review.body.data.runId}`));
    expect(workflowStatus.status).toBe(200);
    expect(workflowStatus.body.data.manuscript).toMatchObject({ scenes: 1 });

    const reset = await auth(request(app).post(`/api/books/${bookId}/reset`));
    expect(reset.status).toBe(200);

    const resetStructure = await auth(
      request(app).get(`/api/books/${bookId}/structure`),
    );
    expect(resetStructure.status).toBe(200);
    expect(resetStructure.body.data.acts).toEqual([]);

    const codexAfterReset = await auth(
      request(app).get(`/api/books/${bookId}/codex`),
    );
    expect(codexAfterReset.status).toBe(200);
    expect(codexAfterReset.body.data.entries).toHaveLength(1);

    const notesAfterReset = await auth(
      request(app).get(`/api/books/${bookId}/notes`),
    );
    expect(notesAfterReset.status).toBe(200);
    expect(notesAfterReset.body.data.notes).toHaveLength(1);

    const deletedBook = await auth(request(app).delete(`/api/books/${bookId}`));
    expect(deletedBook.status).toBe(200);

    const cleanup = await cleanupUser(githubId);
    expect(cleanup.status).toBe(200);
    expect(cleanup.body.data.deleted).toBe(1);

    const leftovers = await Promise.all([
      databaseService.client.user.count({ where: { githubId } }),
      databaseService.client.book.count({ where: { id: bookId } }),
      databaseService.client.act.count({ where: { id: actId } }),
      databaseService.client.chapter.count({ where: { id: chapterId } }),
    ]);
    expect(leftovers).toEqual([0, 0, 0, 0]);
  });
});
