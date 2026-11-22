import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { ExportArtifactService } from "@/services/exportArtifactService";
import request from "supertest";
import app from "@/index";
import { databaseService } from "@/lib/database";
import { documentService } from "@/documents/service";
import {
  mintReleaseCanary,
  configuredReleaseCanary,
  releaseCanaryPath,
  type ReleaseCanaryGrant,
} from "@/operations/releaseCanary";
import {
  assertReleaseMutation,
  withReleaseCanaryAdmission,
  runAdmittedBackground,
  admitReleaseMutation,
} from "@/operations/releaseAdmission";
import {
  transitionRelease,
  databaseReleaseIdentity,
  type ReleaseTransition,
} from "@/operations/releaseTransition";
import {
  createPublicationJob,
  runPublicationJob,
  readPublicationArtifact,
} from "@/documents/publication";
import { withDocumentMutationContext } from "@/services/documentMutationContext";
const db = () => databaseService.client;
describe("private reviewed disposable canary while ordinary admissions stay closed", () => {
  let userId: number,
    otherId: number,
    bookId: number,
    sceneId: number,
    githubId: string,
    grant: ReleaseCanaryGrant,
    close: ReleaseTransition,
    directory: string,
    filename: string;
  const authority = process.env.DOCUMENT_AUTHORITY_ENABLED,
    config = process.env.PROSER_RELEASE_CANARY_FILE;
  const input = async (
    action: "close" | "reopen",
  ): Promise<ReleaseTransition> => ({
    operationId: randomUUID(),
    releaseId: close?.releaseId ?? randomUUID(),
    action,
    expectedGeneration: (
      await db().releaseAdmissionFence.findUniqueOrThrow({ where: { id: 1 } })
    ).generation,
    candidateSha: "a".repeat(40),
    proofSha: "b".repeat(64),
    operator: "isolated-canary-operator",
    proof: {
      schemaVersion: 1,
      releaseId: close?.releaseId ?? randomUUID(),
      candidateSha: "a".repeat(40),
      approvedBy: "Synthetic fixture only",
      reviewed: true,
      actions: ["close", "reopen"],
      targetDatabase: databaseReleaseIdentity(),
      enforcementSqlSha: "c".repeat(64),
      compatibilityRevision: "d".repeat(40),
      backupEvidenceSha: "e".repeat(64),
      restoreEvidenceSha: "f".repeat(64),
      admissionFenceSupport: true,
      environment: "isolated-rehearsal",
    },
  });
  const auth = (test: request.Test, id = userId, identity = githubId) =>
    test.set("x-user-id", String(id)).set("x-github-id", identity);
  const controlled = <T>(action: () => T) =>
    withReleaseCanaryAdmission(grant.admissionId, userId, () =>
      withDocumentMutationContext({ userId, signal: () => undefined }, action),
    );
  beforeEach(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "proser-canary-"));
    filename = path.join(directory, "grant.json");
    process.env.PROSER_RELEASE_CANARY_FILE = filename;
    githubId = `release-fixture:release-canary-${randomUUID()}`;
    userId = (
      await db().user.create({
        data: { githubId, username: "Disposable release fixture" },
      })
    ).id;
    otherId = (
      await db().user.create({
        data: {
          githubId: `foreign-canary-${randomUUID()}`,
          username: "Other fixture",
        },
      })
    ).id;
    const book = await db().book.create({
      data: {
        userId,
        title: "Disposable controlled canary",
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: {
                chapterNumber: 1,
                scenes: {
                  create: {
                    sceneNumber: 1,
                    prose: "Preserved canonical canary.",
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
    close = await input("close");
    close.proof.releaseId = close.releaseId;
    grant = await mintReleaseCanary({
      admissionId: randomUUID(),
      userId,
      bookId,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      proof: close.proof,
      proofSha: close.proofSha,
      operator: close.operator,
    });
    await fs.writeFile(filename, JSON.stringify(grant), { mode: 0o600 });
    await transitionRelease(close, []);
  });
  afterEach(async () => {
    if (
      (await db().releaseAdmissionFence.findUniqueOrThrow({ where: { id: 1 } }))
        .phase === "fenced"
    )
      await transitionRelease(await input("reopen"), []);
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
    await db().documentPublicationArtifact.deleteMany({ where: { bookId } });
    await db().documentPublication.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().manuscriptRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentSearchIndex.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
    await db().user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await fs.rm(directory, { recursive: true, force: true });
  });
  afterAll(() => {
    if (authority === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED;
    else process.env.DOCUMENT_AUTHORITY_ENABLED = authority;
    if (config === undefined) delete process.env.PROSER_RELEASE_CANARY_FILE;
    else process.env.PROSER_RELEASE_CANARY_FILE = config;
  });
  test("only exact reviewed editing/local publication paths are eligible; arbitrary providers, account, workflow and cross-book paths are excluded", () => {
    expect(
      releaseCanaryPath(
        "POST",
        `/api/books/${bookId}/scenes/${sceneId}/document-passages/comments`,
        bookId,
      ),
    ).toBe(true);
    expect(
      releaseCanaryPath(
        "POST",
        `/api/books/${bookId}/document-publication-jobs/${randomUUID()}/resume`,
        bookId,
      ),
    ).toBe(true);
    expect(
      releaseCanaryPath(
        "POST",
        `/api/books/${bookId}/layout-stories/front:fixture/document-draft-commits`,
        bookId,
      ),
    ).toBe(true);
    expect(
      releaseCanaryPath(
        "POST",
        `/api/books/${bookId}/layout-stories/front:fixture/document-proposals`,
        bookId,
      ),
    ).toBe(false);
    for (const route of [
      "/api/books",
      "/api/generate/prose",
      "/api/images/generate",
      `/api/books/${bookId}/document-proposals`,
      `/api/books/${bookId}/document-story-proposals`,
      `/api/books/${bookId}/workflows`,
      `/api/books/${bookId + 1}/document-commits`,
      `/api/books/${bookId}0/document-commits`,
    ])
      expect(releaseCanaryPath("POST", route, bookId)).toBe(false);
  });
  test("ordinary authenticated save/CAS and exact receipt recovery work without reopening; foreign identity/book and body/header grants cannot authorize", async () => {
    const source = await documentService.read(userId, bookId, sceneId),
      p = source.document.blocks[0];
    if (p.type !== "paragraph") throw new Error("fixture");
    p.runs[0].text += " Saved.";
    p.runs[0].style = { bold: true };
    const payload = {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: source.bookRevisionId,
        scenes: [
          {
            sceneId,
            expectedRevisionId: source.revisionId,
            document: source.document,
          },
        ],
      },
      route = `/api/books/${bookId}/document-commits`;
    const saved = await auth(request(app).post(route)).send(payload);
    expect(saved.status).toBe(200);
    expect(
      (await auth(request(app).post(route)).send(payload)).body.data,
    ).toEqual(saved.body.data);
    expect(
      (
        await auth(request(app).post(route)).send({
          ...payload,
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await auth(
          request(app).post(route),
          otherId,
          `foreign-canary-${otherId}`,
        ).send(payload)
      ).status,
    ).toBe(503);
    expect(
      (
        await auth(
          request(app).post(`/api/books/${bookId + 1}/document-commits`),
        )
          .set("x-release-admission", grant.admissionId)
          .send({ ...payload, canaryGrant: grant })
      ).status,
    ).toBe(503);
    expect(
      (await db().releaseAdmissionFence.findUniqueOrThrow({ where: { id: 1 } }))
        .phase,
    ).toBe("fenced");
    expect(
      (await documentService.read(userId, bookId, sceneId)).document.blocks[0],
    ).toEqual(p);
  });
  test("the exact pre-admitted grant recovers after close and content edits without minting another authority", async () => {
    const receipt = await mintReleaseCanary({
      admissionId: grant.admissionId,
      userId,
      bookId,
      expiresAt: grant.expiresAt,
      proof: close.proof,
      proofSha: close.proofSha,
      operator: close.operator,
    });
    expect(receipt).toEqual(grant);
    await expect(
      mintReleaseCanary({
        admissionId: grant.admissionId,
        userId,
        bookId,
        expiresAt: new Date(Date.now() + 50000).toISOString(),
        proof: close.proof,
        proofSha: close.proofSha,
        operator: close.operator,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_CANARY_OPERATION_CONFLICT" });
    await expect(
      mintReleaseCanary({
        admissionId: randomUUID(),
        userId,
        bookId,
        expiresAt: grant.expiresAt,
        proof: close.proof,
        proofSha: close.proofSha,
        operator: close.operator,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
  });
  test("grant file forgery, symlink, permissive file/directory and authenticated identity mismatches fail closed", async () => {
    const route = `/api/books/${bookId}/document-commits`;
    expect(await configuredReleaseCanary("POST", route, userId)).toEqual(grant);
    expect(await configuredReleaseCanary("POST", route, otherId)).toBeNull();
    await fs.writeFile(
      filename,
      JSON.stringify({ ...grant, proofSha: "f".repeat(64) }),
    );
    expect(await configuredReleaseCanary("POST", route, userId)).toBeNull();
    await fs.writeFile(filename, JSON.stringify(grant));
    await fs.chmod(filename, 0o644);
    expect(await configuredReleaseCanary("POST", route, userId)).toBeNull();
    await fs.chmod(filename, 0o600);
    await fs.chmod(directory, 0o755);
    expect(await configuredReleaseCanary("POST", route, userId)).toBeNull();
    await fs.chmod(directory, 0o700);
    await fs.rename(filename, filename + ".actual");
    await fs.symlink(filename + ".actual", filename);
    expect(await configuredReleaseCanary("POST", route, userId)).toBeNull();
  });
  test("a grant cannot authorize another book/user, survives no reopen/reclose, and deadlines are enforced centrally", async () => {
    await expect(
      controlled(() =>
        db().$transaction((tx) =>
          assertReleaseMutation(tx, `book:${bookId + 1}`),
        ),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    await expect(
      withReleaseCanaryAdmission(grant.admissionId, otherId, () =>
        db().$transaction((tx) => assertReleaseMutation(tx, `book:${bookId}`)),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    jest.spyOn(Date, "now").mockReturnValue(Date.parse(grant.expiresAt) + 1);
    await expect(
      controlled(() =>
        db().$transaction((tx) => assertReleaseMutation(tx, `book:${bookId}`)),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    jest.restoreAllMocks();
    await transitionRelease(await input("reopen"), []);
    expect(
      await configuredReleaseCanary(
        "POST",
        `/api/books/${bookId}/document-commits`,
        userId,
      ),
    ).toBeNull();
    await expect(
      controlled(() =>
        db().$transaction((tx) => assertReleaseMutation(tx, `book:${bookId}`)),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    close = await input("close");
    await transitionRelease(close, []);
    expect(
      await configuredReleaseCanary(
        "POST",
        `/api/books/${bookId}/document-commits`,
        userId,
      ),
    ).toBeNull();
  });
  test("installed structured smoke runs genuine sparse review and DOCX HTTP download while fenced and retains all fixture evidence", async () => {
    const previous = process.env.FACTORY_AUTH_SECRET;
    process.env.FACTORY_AUTH_SECRET = "synthetic-canary-http-test-only";
    const token = jwt.sign(
      { sub: githubId, githubId, username: "Disposable release fixture" },
      process.env.FACTORY_AUTH_SECRET,
      {
        algorithm: "HS256",
        issuer: "proser-author",
        audience: "proser-factory",
        expiresIn: "2m",
      },
    );
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server address");
    const code = `import {runDocumentAuthoritySmoke} from './scripts/smoke-document-authority.mjs';
const headers={'Content-Type':'application/json',Authorization:'Bearer '+process.env.SMOKE_TEST_TOKEN};
async function request(method,route,body,headers){const response=await fetch(process.env.SMOKE_TEST_URL+route,{method,headers,body:body?JSON.stringify(body):undefined});const bytes=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(bytes.toString())}catch{}return {status:response.status,json,bytes};}
const evidence=await runDocumentAuthoritySmoke({request,headers,userId:Number(process.env.SMOKE_TEST_USER),bookId:Number(process.env.SMOKE_TEST_BOOK),retainBook:true});console.log(JSON.stringify({bookId:evidence.bookId,operationCount:evidence.operationIds.length,artifactId:evidence.artifactId,artifactChecksum:evidence.artifactChecksum}));`;
    try {
      const output = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", code],
        {
          cwd: path.resolve(__dirname, "../.."),
          env: {
            ...process.env,
            SMOKE_TEST_TOKEN: token,
            SMOKE_TEST_URL: `http://127.0.0.1:${address.port}`,
            SMOKE_TEST_USER: String(userId),
            SMOKE_TEST_BOOK: String(bookId),
          },
          timeout: 60000,
        },
      );
      const result = JSON.parse(output.stdout.trim());
      expect(result).toMatchObject({
        bookId,
        operationCount: 4,
        artifactChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(
        (
          await db().releaseAdmissionFence.findUniqueOrThrow({
            where: { id: 1 },
          })
        ).phase,
      ).toBe("fenced");
      expect(
        await db().book.findUnique({ where: { id: bookId } }),
      ).toMatchObject({ deletedAt: null });
      expect(
        await db().documentOperation.count({ where: { bookId } }),
      ).toBeGreaterThanOrEqual(3);
      const head = await documentService.manifest(userId, bookId);
      const compatibility = await controlled(() =>
        ExportArtifactService.create(userId, bookId, {
          operationId: randomUUID(),
          expectedRevisionId: head.revisionId,
          mode: "final",
          preset: "saved",
        }),
      );
      const bookResponse = await auth(request(app).get(`/api/books/${bookId}`));
      const artifactResponse = await auth(
        request(app).get(
          `/api/books/${bookId}/export-artifacts/${compatibility.artifactId}`,
        ),
      );
      expect(bookResponse.status).toBe(200);
      expect(artifactResponse.status).toBe(200);
      const record = "/tmp/proser-nova-candidate-compatibility";
      await fs.mkdir(record, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(record, "synthetic-http-responses.json"),
        JSON.stringify({
          book: bookResponse.body,
          artifact: artifactResponse.body,
          bookId,
          artifactId: compatibility.artifactId,
        }),
        { mode: 0o600 },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (previous === undefined) delete process.env.FACTORY_AUTH_SECRET;
      else process.env.FACTORY_AUTH_SECRET = previous;
    }
  });
  test("local publication consumes only its exact prior book/revision/hash binding; provider and unrelated background admission stays blocked", async () => {
    const head = await documentService.manifest(userId, bookId);
    const job = await controlled(() =>
      createPublicationJob(userId, bookId, {
        operationId: randomUUID(),
        expectedRevisionId: head.revisionId,
        options: { format: "html", mode: "final", preset: "saved" },
      }),
    );
    await expect(
      controlled(() => admitReleaseMutation("provider", "fresh-effect", {})),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    await expect(
      controlled(() =>
        runAdmittedBackground(
          "workflow-execution",
          randomUUID(),
          userId,
          async () => undefined,
          { bookId, revisionId: head.revisionId, hash: job.sourceHash },
        ),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    await expect(
      controlled(() =>
        runAdmittedBackground(
          "publication-render",
          job.id,
          userId,
          async () => undefined,
          { bookId, revisionId: head.revisionId, hash: "f".repeat(64) },
        ),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_ADMISSIONS_FENCED" });
    const completed = await controlled(() =>
      runPublicationJob(userId, bookId, job.id),
    );
    expect(completed.status).toBe("completed");
    const artifact = await readPublicationArtifact(
      userId,
      bookId,
      completed.artifactId!,
    );
    expect(Buffer.from(artifact.bytes).toString()).toContain(
      "Preserved canonical canary.",
    );
    expect(
      (await db().releaseAdmissionFence.findUniqueOrThrow({ where: { id: 1 } }))
        .phase,
    ).toBe("fenced");
  });
});
