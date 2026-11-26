import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { RequestHandler } from "express";
import { databaseService } from "@/lib/database";
import { canonicalDocument } from "@/documents/model";
import { DocumentError } from "@/documents/errors";
import { assertBookAiAllowed } from "@/lib/ai/bookAiPolicy";
import {
  configuredReleaseCanary,
  validateReleaseCanaryAdmission,
  RELEASE_CANARY_KIND,
} from "./releaseCanary";
import { currentDocumentMutationContext } from "@/services/documentMutationContext";

const instanceId = randomUUID();
export type ReleaseMaintenanceAction =
  | "backfill-document-authority"
  | "register-selected-artwork"
  | "recover-search-index"
  | "verify-document-bridge";
export interface VerifiedReleaseMaintenance {
  operationId: string;
  releaseId: string;
  generation: number;
  candidateSha: string;
  proofSha: string;
  action: ReleaseMaintenanceAction;
  userId: number;
  bookIds: number[];
  requestHash: string;
}
type Context = {
  admissionId?: string;
  canaryUserId?: number;
  recovery?: true;
  maintenance?: VerifiedReleaseMaintenance;
};
const contexts = new AsyncLocalStorage<Context>();
type EffectSource = {
  kind: string;
  id: string;
  bookId?: number;
  revisionId?: string;
  hash?: string;
};
const providerEffects = new AsyncLocalStorage<{
  dispatches: number;
  source?: EffectSource;
}>();
const knownNotStarted = new WeakSet<object>();
export function providerWasNotStarted(error: unknown) {
  return (
    typeof error === "object" && error !== null && knownNotStarted.has(error)
  );
}
export async function runReleaseProviderEffect<T>(
  action: () => Promise<T>,
  source?: EffectSource,
): Promise<T> {
  return providerEffects.run({ dispatches: 0, source }, async () => {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof DocumentError &&
        error.code.startsWith("DOCUMENT_ADMISSIONS_") &&
        providerEffects.getStore()?.dispatches === 0
      )
        knownNotStarted.add(error);
      throw error;
    }
  });
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
const fenced = (generation?: number) =>
  new DocumentError(
    "DOCUMENT_ADMISSIONS_FENCED",
    "New mutations are paused for a reviewed release. Recover existing exact operation IDs; do not retry unknown provider effects.",
    503,
    { generation },
  );
/** Express's original URL is classified before route handlers can rewrite it.
 * GET export creates artifacts; authentication/read-grant renewal is narrowly
 * permitted. No request parameter/header can supply an admission token. */
export function releaseRequestKind(
  method: string,
  url: string,
): "read" | "authentication" | "mutation" {
  const path =
    url
      .split("?")[0]
      .replace(/^\/api(?=\/|$)/, "")
      .replace(/\/+$/, "") || "/";
  method = method.toUpperCase();
  if (["GET", "HEAD"].includes(method))
    return /^\/books\/\d+\/export$/.test(path) ? "mutation" : "read";
  if (method === "OPTIONS") return "read";
  const uuid = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
  if (
    method === "POST" &&
    (new RegExp(
      `^/books/\\d+/(document-inference-operations|document-operator-effects|document-workflow-effects|document-analysis-operations|document-proposals|document-story-proposals|document-publication-jobs)/${uuid}/cancel$`,
      "i",
    ).test(path) ||
      new RegExp(`^/(workflows|generate/operations)/${uuid}/cancel$`, "i").test(
        path,
      ))
  )
    return "read";
  if (
    method === "POST" &&
    (path === "/auth/sync-user" ||
      /^\/nova-grants\/(capabilities-read|books-read|generation-read|workflow-read)$/.test(
        path,
      ))
  )
    return "authentication";
  return "mutation";
}
async function fence(tx: Prisma.TransactionClient, lock = false) {
  try {
    if (lock)
      await tx.$queryRaw`SELECT id FROM release_admission_fence WHERE id = 1 FOR SHARE`;
    const value = await tx.releaseAdmissionFence.findUnique({
      where: { id: 1 },
    });
    if (!value || !["open", "fenced"].includes(value.phase))
      throw new Error("Missing valid singleton");
    return value;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(
      "DOCUMENT_ADMISSIONS_UNAVAILABLE",
      "Release admission authority is unavailable. Preserve operation IDs and recover without replay.",
      503,
    );
  }
}
export async function releaseAdmissionsOpen() {
  return (await fence(databaseService.client)).phase === "open";
}
export async function assertNewReleaseAdmission(
  tx: Prisma.TransactionClient = databaseService.client,
) {
  const value = await fence(tx, true);
  if (value.phase !== "open") throw fenced(value.generation);
  return value;
}
export async function admitReleaseMutation(
  kind: string,
  scope: string,
  request: unknown,
  userId?: number,
) {
  // A book with AI switched off never reaches a provider, whichever path
  // the request took: the request's books and the provider effect's source.
  if (kind === "provider")
    await assertBookAiAllowed([providerEffects.getStore()?.source?.bookId]);
  const admitted = await databaseService.client.$transaction(async (tx) => {
    const value = await assertNewReleaseAdmission(tx);
    const admitted = await tx.releaseMutationAdmission.create({
      data: {
        id: randomUUID(),
        instanceId,
        userId,
        kind,
        scope,
        requestHash: digest(request),
        generation: value.generation,
      },
    });
    const source = providerEffects.getStore()?.source;
    if (kind === "provider" && source)
      await tx.releaseAdmissionBinding.create({
        data: {
          id: randomUUID(),
          admissionId: admitted.id,
          domainKind: source.kind,
          domainId: source.id,
          sourceBookId: source.bookId,
          sourceRevisionId: source.revisionId,
          sourceHash: source.hash,
        },
      });
    return admitted;
  });
  if (kind === "provider") {
    const effect = providerEffects.getStore();
    if (effect) effect.dispatches++;
  }
  return admitted;
}
/** Exact existing work may finish under its original authenticated admission.
 * A fresh provider dispatch always uses assertNewReleaseAdmission separately. */
export async function assertReleaseMutation(
  tx: Prisma.TransactionClient,
  scope: string,
  recovery = false,
  maintenanceAction?: ReleaseMaintenanceAction,
) {
  const value = await fence(tx, true);
  const context = contexts.getStore();
  if (context?.canaryUserId !== undefined) {
    const admitted = context.admissionId
      ? await tx.releaseMutationAdmission.findUnique({
          where: { id: context.admissionId },
        })
      : null;
    if (
      admitted &&
      (await validateReleaseCanaryAdmission(
        tx,
        admitted,
        value,
        scope,
        currentDocumentMutationContext()?.userId ?? context.canaryUserId,
      ))
    )
      return;
    throw fenced(value.generation);
  }
  if (value.phase === "open") return;
  const maintenance = context?.maintenance;
  if (
    maintenance &&
    maintenanceAction === maintenance.action &&
    /^book:\d+$/.test(scope) &&
    maintenance.bookIds.includes(Number(scope.slice(5))) &&
    value.releaseId === maintenance.releaseId &&
    value.generation === maintenance.generation &&
    value.candidateSha === maintenance.candidateSha &&
    value.proofSha === maintenance.proofSha
  ) {
    const admitted = await tx.releaseMutationAdmission.findUnique({
      where: { id: maintenance.operationId },
    });
    if (
      admitted?.kind === "release-maintenance" &&
      admitted.generation === maintenance.generation &&
      admitted.scope ===
        `${maintenance.action}:${maintenance.bookIds.join(",")}` &&
      admitted.requestHash === maintenance.requestHash &&
      admitted.userId === maintenance.userId
    )
      return;
  }
  if (recovery && context?.recovery) return;
  if (context?.admissionId) {
    const admitted = await tx.releaseMutationAdmission.findUnique({
      where: { id: context.admissionId },
    });
    if (admitted?.kind === RELEASE_CANARY_KIND) {
      if (
        await validateReleaseCanaryAdmission(
          tx,
          admitted,
          value,
          scope,
          currentDocumentMutationContext()?.userId,
        )
      )
        return;
      throw fenced(value.generation);
    }
    if (
      admitted &&
      admitted.generation < value.generation &&
      value.cutoff &&
      admitted.acceptedAt <= value.cutoff
    )
      return;
  }
  throw fenced(value.generation);
}
export async function assertPublicationReleaseAdmission(
  tx: Prisma.TransactionClient,
  userId: number,
  bookId: number,
) {
  const context = contexts.getStore();
  if (context?.canaryUserId === userId) {
    await assertReleaseMutation(tx, `book:${bookId}`);
    return;
  }
  await assertNewReleaseAdmission(tx);
}
export function withVerifiedReleaseMaintenance<T>(
  maintenance: VerifiedReleaseMaintenance,
  action: () => T,
) {
  return contexts.run({ maintenance }, action);
}
export function withReleaseCanaryAdmission<T>(
  admissionId: string,
  userId: number,
  action: () => T,
) {
  return contexts.run({ admissionId, canaryUserId: userId }, action);
}
export function withReleaseAdmission<T>(admissionId: string, action: () => T) {
  return contexts.run({ admissionId }, action);
}
/** Only trusted source recovery functions call this, never request JSON. */
export function withReleaseRecovery<T>(action: () => T) {
  return contexts.run({ recovery: true }, action);
}
export async function bindReleaseAdmission(
  tx: Prisma.TransactionClient,
  domainKind: string,
  domainId: string,
  source: { bookId?: number; revisionId?: string; hash?: string } = {},
) {
  const admissionId = contexts.getStore()?.admissionId;
  if (!admissionId) return;
  const existing = await tx.releaseAdmissionBinding.findUnique({
    where: {
      admissionId_domainKind_domainId: { admissionId, domainKind, domainId },
    },
  });
  if (existing) {
    if (existing.admissionId !== admissionId)
      throw new DocumentError(
        "DOCUMENT_ADMISSION_BINDING_CONFLICT",
        "Exact operation belongs to another accepted admission.",
        409,
      );
    return;
  }
  await tx.releaseAdmissionBinding.create({
    data: {
      id: randomUUID(),
      admissionId,
      domainKind,
      domainId,
      sourceBookId: source.bookId,
      sourceRevisionId: source.revisionId,
      sourceHash: source.hash,
    },
  });
}
/** The read context permits only central side-record recovery transactions.
 * Body/catalog writes are never exempted merely because their route uses GET. */
export const releaseAdmissionMiddleware: RequestHandler = async (
  req,
  _res,
  next,
) => {
  try {
    const kind = releaseRequestKind(req.method, req.originalUrl);
    if (kind === "read") {
      withReleaseRecovery(next);
      return;
    }
    if (kind === "authentication") {
      next();
      return;
    }
    if (await configuredReleaseCanary(req.method, req.originalUrl)) {
      next();
      return;
    }
    await assertNewReleaseAdmission();
    next();
  } catch (error) {
    next(error);
  }
};
/** Admission and binding are facts; domain journals own outcome evidence. */
export async function runAdmittedBackground<T>(
  kind: string,
  domainId: string,
  userId: number | undefined,
  action: () => Promise<T>,
  source: { bookId?: number; revisionId?: string; hash?: string } = {},
): Promise<T> {
  const context = contexts.getStore();
  if (context?.canaryUserId !== undefined) {
    if (
      kind !== "publication-render" ||
      userId !== context.canaryUserId ||
      !source.bookId ||
      !source.revisionId ||
      !source.hash
    )
      throw fenced();
    await databaseService.client.$transaction(async (tx) => {
      await assertReleaseMutation(tx, `book:${source.bookId}`);
      const row = await tx.documentPublication.findFirst({
        where: {
          id: domainId,
          bookId: source.bookId,
          userId,
          revisionId: source.revisionId,
        },
      });
      const binding = await tx.releaseAdmissionBinding.findUnique({
        where: {
          admissionId_domainKind_domainId: {
            admissionId: context.admissionId!,
            domainKind: "publication",
            domainId,
          },
        },
      });
      if (
        !row ||
        !binding ||
        binding.sourceBookId !== source.bookId ||
        binding.sourceRevisionId !== source.revisionId ||
        binding.sourceHash !== source.hash ||
        (row.manifest as { sourceHash?: string }).sourceHash !== source.hash
      )
        throw fenced();
      await bindReleaseAdmission(tx, kind, domainId, source);
    });
    return action();
  }
  const admission = await admitReleaseMutation(
    kind,
    domainId,
    { domainKind: kind, domainId },
    userId,
  );
  return withReleaseAdmission(admission.id, async () => {
    await databaseService.client.$transaction((tx) =>
      bindReleaseAdmission(tx, kind, domainId, source),
    );
    return action();
  });
}
