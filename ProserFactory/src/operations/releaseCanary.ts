/** A local operator may pre-admit one disposable book for controlled release
 * checks. No request header/body supplies this authority; authentication stays normal. */
import { open, constants, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type {
  Prisma,
  ReleaseMutationAdmission,
  ReleaseAdmissionFence,
} from "@prisma/client";
import { databaseService } from "@/lib/database";
import { canonicalDocument } from "@/documents/model";
import { DocumentError } from "@/documents/errors";
import { currentDocumentMutationContext } from "@/services/documentMutationContext";
import { currentWorkflowExecution } from "@/services/workflowExecutionContext";
import { validateReleaseProof, type ReleaseProof } from "./releaseTransition";
const sha = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.string().regex(/^[a-f0-9]{40}$/);
export const releaseCanaryGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    admissionId: z.string().uuid(),
    userId: z.number().int().positive(),
    bookId: z.number().int().positive(),
    fixtureIdentity: z
      .string()
      .regex(
        /^release-fixture:release-canary-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
      ),
    releaseId: z.string().uuid(),
    candidateSha: revision,
    proofSha: hash,
    priorGeneration: z.number().int().nonnegative(),
    expiresAt: z.string().datetime(),
    initialBookRevisionId: z.string().uuid(),
    initialBookContentHash: hash,
  })
  .strict();
export type ReleaseCanaryGrant = z.infer<typeof releaseCanaryGrantSchema>;
export const RELEASE_CANARY_KIND = "release-canary-v1";
export function releaseCanaryPath(
  method: string,
  url: string,
  bookId: number,
): boolean {
  method = method.toUpperCase();
  const route = url
    .split("?")[0]
    .replace(/^\/api(?=\/|$)/, "")
    .replace(/\/+$/, "");
  if (method === "DELETE") return route === `/books/${bookId}`;
  if (method === "GET") return route === `/books/${bookId}/export`;
  if (method !== "POST") return false;
  const root = `/books/${bookId}`;
  if (!route.startsWith(root + "/")) return false;
  const suffix = route.slice(root.length),
    uuid = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
  return (
    [
      "/document-commits",
      "/document-layout-commits",
      "/document-passage-commits",
      "/document-passage-transfers",
      "/document-passage-scope-restores",
      "/document-publication-jobs",
    ].includes(suffix) ||
    /^\/scenes\/\d+\/document-passages(?:\/(?:operations|restore|comments))?$/.test(
      suffix,
    ) ||
    new RegExp(`^/document-revisions/${uuid}/restore$`, "i").test(suffix) ||
    new RegExp(`^/document-publication-jobs/${uuid}/resume$`, "i").test(
      suffix,
    ) ||
    /^\/scenes\/\d+\/document-comments(?:\/[^/]{1,128}\/(?:revalidate|resolve))?$/.test(
      suffix,
    ) ||
    /^\/layout-stories\/[A-Za-z0-9_.:-]{1,128}\/document-draft-commits$/.test(
      suffix,
    ) ||
    /^\/layout-stories\/[A-Za-z0-9_.:-]{1,128}\/document-comments(?:\/[^/]{1,128}\/(?:revalidate|resolve))?$/.test(
      suffix,
    )
  );
}
export async function validateReleaseCanaryAdmission(
  tx: Prisma.TransactionClient,
  admitted: ReleaseMutationAdmission,
  fence: ReleaseAdmissionFence,
  scope: string,
  userId?: number,
): Promise<ReleaseCanaryGrant | null> {
  if (admitted.kind !== RELEASE_CANARY_KIND) return null;
  let grant: ReleaseCanaryGrant;
  try {
    grant = releaseCanaryGrantSchema.parse(JSON.parse(admitted.scope));
  } catch {
    return null;
  }
  if (
    grant.admissionId !== admitted.id ||
    grant.userId !== admitted.userId ||
    (userId !== undefined && grant.userId !== userId) ||
    scope !== `book:${grant.bookId}` ||
    admitted.requestHash !== sha(grant) ||
    admitted.generation !== grant.priorGeneration ||
    fence.phase !== "fenced" ||
    fence.generation !== grant.priorGeneration + 1 ||
    fence.releaseId !== grant.releaseId ||
    fence.candidateSha !== grant.candidateSha ||
    fence.proofSha !== grant.proofSha ||
    !fence.cutoff ||
    admitted.acceptedAt > fence.cutoff ||
    Date.now() >= Date.parse(grant.expiresAt) ||
    Date.parse(grant.expiresAt) > admitted.acceptedAt.getTime() + 30 * 60000
  )
    return null;
  const user = await tx.user.findFirst({
      where: { id: grant.userId, githubId: grant.fixtureIdentity },
      select: { id: true },
    }),
    book = await tx.book.findFirst({
      where: { id: grant.bookId, userId: grant.userId, deletedAt: null },
      select: { id: true },
    });
  if (!user || !book) return null;
  return grant;
}
export async function configuredReleaseCanary(
  method: string,
  url: string,
  userId?: number,
): Promise<ReleaseCanaryGrant | null> {
  const filename = process.env.PROSER_RELEASE_CANARY_FILE;
  if (!filename || !path.isAbsolute(filename)) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat(),
      parent = await stat(path.dirname(filename));
    if (
      !info.isFile() ||
      info.size > 16384 ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      parent.mode & 0o077 ||
      parent.uid !== info.uid
    )
      return null;
    const file = releaseCanaryGrantSchema.parse(
      JSON.parse(await handle.readFile("utf8")),
    );
    if (!releaseCanaryPath(method, url, file.bookId)) return null;
    return await databaseService.client.$transaction(async (tx) => {
      const fence = await tx.releaseAdmissionFence.findUnique({
          where: { id: 1 },
        }),
        admitted = await tx.releaseMutationAdmission.findUnique({
          where: { id: file.admissionId },
        });
      if (!fence || !admitted || canonicalDocument(file) !== admitted.scope)
        return null;
      return validateReleaseCanaryAdmission(
        tx,
        admitted,
        fence,
        `book:${file.bookId}`,
        userId,
      );
    });
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
/** Operator-only, while admissions are open. Seed the exact owned fixture first.
 * The proof is the same reviewed close/reopen proof used for this release. */
export async function mintReleaseCanary(input: {
  admissionId: string;
  userId: number;
  bookId: number;
  expiresAt: string;
  proof: ReleaseProof;
  proofSha: string;
  operator: string;
}): Promise<ReleaseCanaryGrant> {
  if (
    currentDocumentMutationContext() ||
    currentWorkflowExecution() ||
    !input.operator.trim()
  )
    throw new DocumentError(
      "RELEASE_CANARY_OPERATOR_REQUIRED",
      "Controlled canaries require a local reviewed operator.",
      403,
    );
  validateReleaseProof(input.proof, {
    operationId: input.admissionId,
    releaseId: input.proof.releaseId,
    action: "close",
    expectedGeneration: 0,
    candidateSha: input.proof.candidateSha,
    proofSha: input.proofSha,
  });
  return databaseService.client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM release_admission_fence WHERE id = 1 FOR SHARE`;
    const prior = await tx.releaseMutationAdmission.findUnique({
      where: { id: input.admissionId },
    });
    if (prior) {
      const grant = releaseCanaryGrantSchema.parse(JSON.parse(prior.scope));
      if (
        prior.kind !== RELEASE_CANARY_KIND ||
        prior.requestHash !== sha(grant) ||
        grant.userId !== input.userId ||
        grant.bookId !== input.bookId ||
        grant.expiresAt !== input.expiresAt ||
        grant.releaseId !== input.proof.releaseId ||
        grant.candidateSha !== input.proof.candidateSha ||
        grant.proofSha !== input.proofSha ||
        prior.instanceId !== `operator:${input.operator}`
      )
        throw new DocumentError(
          "RELEASE_CANARY_OPERATION_CONFLICT",
          "Recover the same canary admission and exact scope.",
          409,
        );
      return grant;
    }
    const fence = await tx.releaseAdmissionFence.findUniqueOrThrow({
      where: { id: 1 },
    });
    if (fence.phase !== "open")
      throw new DocumentError(
        "DOCUMENT_ADMISSIONS_FENCED",
        "Mint the scoped canary before closing admissions.",
        503,
      );
    const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: { githubId: true },
      }),
      book = await tx.book.findFirst({
        where: { id: input.bookId, userId: input.userId, deletedAt: null },
        select: { id: true },
      }),
      head = await tx.bookDocumentHead.findUnique({
        where: { bookId: input.bookId },
      });
    if (!user || !book || !head)
      throw new DocumentError(
        "RELEASE_CANARY_SCOPE_INVALID",
        "Seed one owned disposable book and identity before canary admission.",
        409,
      );
    const grant = releaseCanaryGrantSchema.parse({
      schemaVersion: 1,
      admissionId: input.admissionId,
      userId: input.userId,
      bookId: input.bookId,
      fixtureIdentity: user.githubId,
      releaseId: input.proof.releaseId,
      candidateSha: input.proof.candidateSha,
      proofSha: input.proofSha,
      priorGeneration: fence.generation,
      expiresAt: input.expiresAt,
      initialBookRevisionId: head.revisionId,
      initialBookContentHash: sha(head.manifest),
    });
    if (
      Date.parse(grant.expiresAt) <= Date.now() + 1000 ||
      Date.parse(grant.expiresAt) > Date.now() + 20 * 60000
    )
      throw new DocumentError(
        "RELEASE_CANARY_DEADLINE_INVALID",
        "Controlled canary lifetime is bounded to twenty minutes.",
        422,
      );
    await tx.releaseMutationAdmission.create({
      data: {
        id: grant.admissionId,
        instanceId: `operator:${input.operator}`,
        kind: RELEASE_CANARY_KIND,
        scope: canonicalDocument(grant),
        requestHash: sha(grant),
        userId: grant.userId,
        generation: grant.priorGeneration,
      },
    });
    await tx.releaseAdmissionBinding.create({
      data: {
        id: randomUUID(),
        admissionId: grant.admissionId,
        domainKind: "release-canary",
        domainId: grant.admissionId,
        sourceBookId: grant.bookId,
        sourceRevisionId: grant.initialBookRevisionId,
        sourceHash: grant.initialBookContentHash,
      },
    });
    return grant;
  });
}
