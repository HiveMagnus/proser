import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { databaseService } from "@/lib/database";
import { SceneProseService } from "@/services/sceneProseService";
import { currentDocumentMutationContext } from "@/services/documentMutationContext";
import { currentWorkflowExecution } from "@/services/workflowExecutionContext";
import {
  assertNewReleaseAdmission,
  bindReleaseAdmission,
  runReleaseProviderEffect,
  providerWasNotStarted,
} from "@/operations/releaseAdmission";
import { InferenceTerminalError } from "@/lib/ai/terminalReason";
import { documentService } from "./service";
import { DocumentError } from "./errors";
import { frozenTarget, verifyTargets } from "./targets";
import { editedDocument } from "./proposals";
import { documentProposalPrompt } from "./proposalPrompt";
import {
  proposalContextBudget,
  proposalContextBlocks,
} from "./proposalContext";
import {
  documentProposalRequestSchema,
  documentProposalOutputSchema,
} from "./proposalValidation";
import {
  documentStoryDiscussionSchema,
  documentStoryProposalRevalidateSchema,
  documentStoryProposalApplySchema,
  documentStoryDraftCommitSchema,
} from "./storyProposalValidation";
import {
  ownedStorySource,
  deriveStoryDraft,
  replaceStoryDocument,
  storyDigest,
  assertStoryBookOwner,
  exactLayoutStory,
} from "./storyProposalSources";
import { readScope } from "./scopes";
import type {
  DocumentStoryDiscussionSnapshot,
  DocumentStoryDiscussionInput,
} from "./story-proposal-model";
import type { DocumentProposalOutput } from "./proposal-model";
const db = () => databaseService.client;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const active = new Map<string, AbortController>();
export async function createStoryDiscussion(
  userId: number,
  bookId: number,
  raw: unknown,
) {
  const input = documentStoryDiscussionSchema.parse(raw);
  await assertStoryBookOwner(db(), userId, bookId);
  const requestHash = storyDigest({ userId, bookId, input });
  const prior = await db().documentStoryDiscussion.findUnique({
    where: { id: input.operationId },
  });
  if (prior) {
    if (
      prior.userId !== userId ||
      prior.bookId !== bookId ||
      prior.requestHash !== requestHash
    )
      throw new DocumentError(
        "DOCUMENT_OPERATION_CONFLICT",
        "Story discussion ID belongs to another request.",
        409,
      );
    return prior;
  }
  const source = await ownedStorySource(db(), userId, bookId, input.storyId);
  if (
    source.bookRevisionId !== input.expectedRevisionId ||
    source.layoutRevisionId !== input.expectedLayoutRevisionId ||
    source.contentHash !== input.expectedContentHash
  )
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Save/reconcile this owned story before preparing context.",
      412,
      {
        currentRevisionId: source.bookRevisionId,
        currentLayoutRevisionId: source.layoutRevisionId,
      },
    );
  const draft = input.localOperations
    ? deriveStoryDraft(source, input.localOperations, userId)
    : source.document;
  const targets = input.targets.map((target) => frozenTarget(draft, target));
  for (let index = 0; index < targets.length; index++)
    for (let other = index + 1; other < targets.length; other++)
      if (
        targets[index].blockId === targets[other].blockId &&
        targets[index].from <= targets[other].to &&
        targets[other].from <= targets[index].to
      )
        throw new DocumentError(
          "DOCUMENT_PROPOSAL_OVERLAP",
          "Selected story targets overlap.",
          409,
        );
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const previous = await tx.documentStoryDiscussion.findUnique({
      where: { id: input.operationId },
    });
    if (previous) {
      if (previous.userId !== userId || previous.requestHash !== requestHash)
        throw new DocumentError(
          "DOCUMENT_OPERATION_CONFLICT",
          "Story discussion ID was reused.",
          409,
        );
      return previous;
    }
    const current = await ownedStorySource(tx, userId, bookId, input.storyId);
    if (current.bookRevisionId !== source.bookRevisionId)
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Book changed during story context preparation.",
        412,
      );
    const budget = proposalContextBudget(targets),
      context = proposalContextBlocks(draft, targets);
    const snapshot: DocumentStoryDiscussionSnapshot = {
      schemaVersion: 1,
      sourceKind: "layout-story",
      storyId: input.storyId,
      sessionId: input.sessionId,
      projection: "final",
      sourceBookRevisionId: source.bookRevisionId,
      sourceBookContentHash: source.bookContentHash,
      sourceLayoutRevisionId: source.layoutRevisionId,
      sourceLayoutContentHash: source.layoutContentHash,
      sourceContentHash: source.contentHash,
      ownerContextHash: source.ownerContextHash,
      localDraftDigest: storyDigest(draft),
      unsaved: storyDigest(draft) !== source.contentHash,
      targets,
      blocks: context.blocks,
      codex: [],
      omitted: { blockIds: context.omittedBlockIds, codexIds: [] },
      ...budget,
      templateVersion: "1.0.0",
      conversation: [],
      omittedProposalIds: [],
      omittedEarlierTurnCount: 0,
      ...(input.localOperations
        ? { draftOperationId: input.localOperations.operationId }
        : {}),
    };
    const reserve = 8000;
    if (
      Buffer.byteLength(documentProposalPrompt(snapshot, "")) + reserve >
      snapshot.maxPromptBytes
    )
      throw new DocumentError(
        "DOCUMENT_CONTEXT_TOO_LARGE",
        "The complete target story blocks exceed this model context budget. Select fewer complete blocks.",
        413,
      );
    if (input.parentDiscussionId) {
      const parent = await tx.documentStoryDiscussion.findFirst({
        where: {
          id: input.parentDiscussionId,
          userId,
          bookId,
          storyId: input.storyId,
        },
      });
      if (!parent)
        throw new DocumentError(
          "DOCUMENT_SCOPE_NOT_FOUND",
          "Parent owned-story discussion not found.",
          404,
        );
      const parentSnapshot =
        parent.snapshot as unknown as DocumentStoryDiscussionSnapshot;
      snapshot.conversation = structuredClone(
        parentSnapshot.conversation ?? [],
      );
      snapshot.omittedEarlierTurnCount =
        (parentSnapshot.omittedEarlierTurnCount ?? 0) +
        (parentSnapshot.omittedProposalIds?.length ?? 0);
      const where = {
        discussionId: parent.id,
        userId,
        bookId,
        status: { in: ["ready", "applied"] },
      };
      const count = await tx.documentStoryProposal.count({ where }),
        turns = await tx.documentStoryProposal.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 9,
        });
      snapshot.omittedEarlierTurnCount += Math.max(0, count - turns.length);
      for (const turn of turns.reverse()) {
        const result = turn.result as unknown as {
            output?: DocumentProposalOutput;
          },
          request = turn.request as unknown as { instruction: string };
        if (result.output)
          snapshot.conversation.push({
            proposalId: turn.id,
            instruction: request.instruction,
            reply: result.output.reply,
            sourceLayoutRevisionId: parentSnapshot.sourceLayoutRevisionId,
          });
      }
      while (
        snapshot.conversation.length > 8 ||
        Buffer.byteLength(documentProposalPrompt(snapshot, "")) + reserve >
          snapshot.maxPromptBytes
      ) {
        const omitted = snapshot.conversation.shift();
        if (!omitted) break;
        snapshot.omittedProposalIds.push(omitted.proposalId);
      }
    }
    const canon = await readScope(
      tx,
      bookId,
      "canon",
      source.manifest.scopes!.canon,
    );
    for (const entry of canon.entries
      .filter((entry) => !entry.deletedAt)
      .sort((a, b) => a.id - b.id)) {
      snapshot.codex.push({
        id: entry.id,
        name: entry.entryName,
        type: entry.entryType,
        text: [entry.entryDescription, entry.attributes]
          .filter(Boolean)
          .join("\n"),
      });
      if (
        Buffer.byteLength(documentProposalPrompt(snapshot, "")) + reserve >
        snapshot.maxPromptBytes
      ) {
        snapshot.codex.pop();
        snapshot.omitted.codexIds.push(entry.id);
      }
    }
    return tx.documentStoryDiscussion.create({
      data: {
        id: input.operationId,
        bookId,
        userId,
        storyId: input.storyId,
        sessionId: input.sessionId,
        requestHash,
        request: json(input),
        snapshot: json(snapshot),
      },
    });
  });
}
export async function readStoryDiscussion(
  userId: number,
  bookId: number,
  id: string,
) {
  const row = await db().documentStoryDiscussion.findFirst({
    where: { id, bookId, userId },
  });
  if (!row)
    throw new DocumentError(
      "DOCUMENT_SCOPE_NOT_FOUND",
      "Owned-story discussion not found.",
      404,
    );
  const snapshot = row.snapshot as unknown as DocumentStoryDiscussionSnapshot;
  const source = await ownedStorySource(
    db(),
    userId,
    bookId,
    row.storyId,
    snapshot.sourceBookRevisionId,
  );
  if (
    source.layoutRevisionId !== snapshot.sourceLayoutRevisionId ||
    source.layoutContentHash !== snapshot.sourceLayoutContentHash ||
    source.bookContentHash !== snapshot.sourceBookContentHash ||
    source.contentHash !== snapshot.sourceContentHash
  )
    throw new DocumentError(
      "DOCUMENT_TARGET_SOURCE_INVALID",
      "Owned-story discussion source proof is inconsistent.",
      409,
    );
  return {
    ...row,
    draftOperations: (row.request as unknown as DocumentStoryDiscussionInput)
      .localOperations,
  };
}
export async function readStoryProposal(
  userId: number,
  bookId: number,
  id: string,
) {
  let row = await db().documentStoryProposal.findFirst({
    where: { id, bookId, userId },
  });
  if (!row)
    throw new DocumentError(
      "DOCUMENT_SCOPE_NOT_FOUND",
      "Owned-story proposal not found.",
      404,
    );
  const discussion = await readStoryDiscussion(
    userId,
    bookId,
    row.discussionId,
  );
  if (discussion.storyId !== row.storyId)
    throw new DocumentError(
      "DOCUMENT_TARGET_SOURCE_INVALID",
      "Proposal points to a different owned story source.",
      409,
    );
  if (
    row.status === "running" &&
    row.startedAt &&
    Date.now() - row.startedAt.getTime() > 150000
  ) {
    await db().documentStoryProposal.updateMany({
      where: { id, status: "running", startedAt: row.startedAt },
      data: {
        status: "unknown",
        errorCode: "PROVIDER_ACKNOWLEDGEMENT_EXPIRED",
      },
    });
    row = await db().documentStoryProposal.findUniqueOrThrow({ where: { id } });
  }
  const application = row.applicationOperationId
    ? await db().documentOperation.findFirst({
        where: { id: row.applicationOperationId, userId, bookId },
        select: { receipt: true },
      })
    : null;
  return {
    ...row,
    providerOutcome: row.result
      ? "completed"
      : row.startedAt
        ? row.status === "running"
          ? "pending"
          : "unknown"
        : "not-started",
    application: application?.receipt ?? null,
  };
}
export async function requestStoryProposal(
  userId: number,
  bookId: number,
  discussionId: string,
  raw: unknown,
) {
  const input = documentProposalRequestSchema.parse(raw),
    discussion = await readStoryDiscussion(userId, bookId, discussionId),
    snapshot =
      discussion.snapshot as unknown as DocumentStoryDiscussionSnapshot;
  if (
    Buffer.byteLength(documentProposalPrompt(snapshot, input.instruction)) >
    snapshot.maxPromptBytes
  )
    throw new DocumentError(
      "DOCUMENT_CONTEXT_TOO_LARGE",
      "The disclosed story context and instruction exceed the model budget.",
      413,
    );
  const requestHash = storyDigest({ userId, bookId, discussionId, input });
  let row = await db().documentStoryProposal.findUnique({
    where: { id: input.operationId },
  });
  if (
    row &&
    (row.userId !== userId ||
      row.bookId !== bookId ||
      row.requestHash !== requestHash)
  )
    throw new DocumentError(
      "DOCUMENT_OPERATION_CONFLICT",
      "Story proposal operation belongs to another request.",
      409,
    );
  if (!row)
    row = await documentService.sideRecord(userId, bookId, async (tx) => {
      const previous = await tx.documentStoryProposal.findUnique({
        where: { id: input.operationId },
      });
      if (previous) {
        if (previous.userId !== userId || previous.requestHash !== requestHash)
          throw new DocumentError(
            "DOCUMENT_OPERATION_CONFLICT",
            "Story proposal ID was reused.",
            409,
          );
        return previous;
      }
      const source = await ownedStorySource(
        tx,
        userId,
        bookId,
        snapshot.storyId,
      );
      if (source.bookRevisionId !== snapshot.sourceBookRevisionId)
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "The disclosed story changed before inference; prepare context again.",
          412,
        );
      const created = await tx.documentStoryProposal.create({
        data: {
          id: input.operationId,
          discussionId,
          bookId,
          userId,
          storyId: discussion.storyId,
          requestHash,
          request: json(input),
        },
      });
      await bindReleaseAdmission(tx, "story-proposal", created.id, {
        bookId,
        revisionId: snapshot.sourceLayoutRevisionId,
        hash: snapshot.sourceContentHash,
      });
      return created;
    });
  if (row.status !== "pending")
    return readStoryProposal(userId, bookId, row.id);
  await documentService.assertMutationAuthority(
    userId,
    bookId,
    snapshot.sourceBookRevisionId,
  );
  const claimed = await db().$transaction(async (tx) => {
    await assertNewReleaseAdmission(tx);
    return tx.documentStoryProposal.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "running", startedAt: new Date() },
    });
  });
  if (!claimed.count) return readStoryProposal(userId, bookId, row.id);
  const controller = new AbortController();
  active.set(row.id, controller);
  const caller =
    currentWorkflowExecution()?.signal ??
    currentDocumentMutationContext()?.signal();
  const signal = caller
    ? AbortSignal.any([caller, controller.signal])
    : controller.signal;
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void db()
      .documentStoryProposal.findUnique({
        where: { id: input.operationId },
        select: { status: true },
      })
      .then((value) => {
        if (!value || value.status !== "running") controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        polling = false;
      });
  }, 1000);
  timer.unref();
  let acknowledged = false;
  try {
    const response = await runReleaseProviderEffect(
      () =>
        SceneProseService.getInstance().proposeDocumentEdits(
          snapshot,
          input.instruction,
          {
            selectedModel: input.selectedModel,
            signal,
            timeoutMs: 120000,
            retries: 1,
          },
        ),
      {
        kind: "document-story-proposal",
        id: row.id,
        bookId,
        revisionId: snapshot.sourceLayoutRevisionId,
        hash: snapshot.sourceContentHash,
      },
    );
    acknowledged = true;
    if (Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024)
      throw new DocumentError(
        "DOCUMENT_PROPOSAL_RESULT_TOO_LARGE",
        "Story provider result exceeds 1 MiB.",
        413,
      );
    await db().documentStoryProposal.update({
      where: { id: row.id },
      data: { result: json(response) },
    });
    const output = documentProposalOutputSchema.parse(JSON.parse(response.raw)),
      known = new Map(
        snapshot.targets.map((target) => [target.targetId, target]),
      );
    if (
      new Set(output.edits.map((edit) => edit.targetId)).size !==
        output.edits.length ||
      output.edits.some(
        (edit) =>
          !known.has(edit.targetId) ||
          known.get(edit.targetId)!.sourceText !== edit.sourceText,
      )
    )
      throw new DocumentError(
        "DOCUMENT_PROPOSAL_INVALID",
        "The model changed supplied story identities or exact source text.",
        422,
      );
    const source = await ownedStorySource(
        db(),
        userId,
        bookId,
        snapshot.storyId,
        snapshot.sourceBookRevisionId,
      ),
      retained = discussion.request as unknown as DocumentStoryDiscussionInput;
    const draft = retained.localOperations
      ? deriveStoryDraft(source, retained.localOperations, userId)
      : source.document;
    if (storyDigest(draft) !== snapshot.localDraftDigest)
      throw new DocumentError(
        "DOCUMENT_TARGET_SOURCE_INVALID",
        "Original disclosed story derivative checksum changed.",
        409,
      );
    editedDocument(
      draft,
      snapshot,
      output,
      output.edits.map((edit) => edit.targetId),
      userId,
    );
    await db().documentStoryProposal.update({
      where: { id: row.id },
      data: { result: json({ ...response, output }) },
    });
    await db().documentStoryProposal.updateMany({
      where: { id: row.id, status: "running" },
      data: { status: "ready", completedAt: new Date() },
    });
  } catch (error) {
    if (providerWasNotStarted(error)) {
      await db().documentStoryProposal.updateMany({
        where: { id: row.id, status: "running" },
        data: {
          status: "pending",
          startedAt: null,
          errorCode: "PROVIDER_NOT_STARTED",
        },
      });
      throw error;
    }
    if (error instanceof InferenceTerminalError) {
      acknowledged = true;
      const bytes = Buffer.byteLength(error.partialOutput);
      await db().documentStoryProposal.update({
        where: { id: row.id },
        data: {
          result: json({
            providerOutcome: "completed",
            finishReason: error.finishReason,
            raw: bytes <= 1024 * 1024 ? error.partialOutput : undefined,
            partialOutputSha256: createHash("sha256")
              .update(error.partialOutput)
              .digest("hex"),
            partialOutputBytes: bytes,
            retainedPartialOutput: bytes <= 1024 * 1024,
            errorCode: error.code,
          }),
        },
      });
    }
    if (
      error instanceof DocumentError &&
      error.code === "DOCUMENT_PROPOSAL_RESULT_TOO_LARGE"
    )
      await db().documentStoryProposal.update({
        where: { id: row.id },
        data: {
          result: {
            providerOutcome: "completed",
            reason: "Provider result exceeded the retained byte ceiling.",
          },
        },
      });
    await db().documentStoryProposal.updateMany({
      where: { id: row.id, status: "running" },
      data: {
        status: acknowledged ? "failed" : "unknown",
        errorCode: acknowledged
          ? "PROPOSAL_RESPONSE_INVALID"
          : "PROVIDER_OUTCOME_UNKNOWN",
        completedAt: acknowledged ? new Date() : null,
      },
    });
  } finally {
    clearInterval(timer);
    active.delete(input.operationId);
  }
  return readStoryProposal(userId, bookId, row.id);
}
export async function cancelStoryProposal(
  userId: number,
  bookId: number,
  id: string,
) {
  const receipt = await documentService.sideRecord(
    userId,
    bookId,
    async (tx) => {
      const row = await tx.documentStoryProposal.findFirst({
        where: { id, bookId, userId },
      });
      if (!row)
        throw new DocumentError(
          "DOCUMENT_SCOPE_NOT_FOUND",
          "Owned-story proposal not found.",
          404,
        );
      await assertStoryBookOwner(tx, userId, bookId);
      if (["applied", "cancelled", "failed", "unknown"].includes(row.status))
        return { id, status: row.status };
      await tx.documentStoryProposal.update({
        where: { id },
        data: {
          status: "cancelled",
          errorCode: "CANCELLED_BY_OWNER",
          completedAt: new Date(),
        },
      });
      return { id, status: "cancelled" };
    },
  );
  if (receipt.status === "cancelled") active.get(id)?.abort();
  return receipt;
}
export async function revalidateStoryProposal(
  userId: number,
  bookId: number,
  proposalId: string,
  raw: unknown,
) {
  const input = documentStoryProposalRevalidateSchema.parse(raw),
    proposal = await readStoryProposal(userId, bookId, proposalId);
  if (proposal.status !== "ready")
    throw new DocumentError(
      "DOCUMENT_PROPOSAL_UNAVAILABLE",
      "Only a ready story proposal can be revalidated.",
      409,
    );
  const discussion = await readStoryDiscussion(
      userId,
      bookId,
      proposal.discussionId,
    ),
    snapshot =
      discussion.snapshot as unknown as DocumentStoryDiscussionSnapshot;
  const source = await ownedStorySource(db(), userId, bookId, proposal.storyId);
  if (
    source.bookRevisionId !== input.expectedRevisionId ||
    source.layoutRevisionId !== input.expectedLayoutRevisionId
  )
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Flush the owned story and use its acknowledged revisions.",
      412,
    );
  verifyTargets(source.document, snapshot.targets);
  if (source.ownerContextHash !== snapshot.ownerContextHash)
    throw new DocumentError(
      "DOCUMENT_TARGET_STALE",
      "Owned story parent/layout/styles changed since disclosure.",
      409,
    );
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const current = await ownedStorySource(
      tx,
      userId,
      bookId,
      proposal.storyId,
    );
    if (current.bookRevisionId !== source.bookRevisionId)
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Story changed during revalidation.",
        412,
      );
    const previous = await tx.documentStoryProposalValidation.findUnique({
      where: { id: input.operationId },
    });
    if (previous) {
      if (
        previous.proposalId !== proposalId ||
        previous.userId !== userId ||
        previous.bookRevisionId !== source.bookRevisionId ||
        previous.layoutRevisionId !== source.layoutRevisionId ||
        previous.contentHash !== source.contentHash
      )
        throw new DocumentError(
          "DOCUMENT_OPERATION_CONFLICT",
          "Story validation ID was reused.",
          409,
        );
      return previous;
    }
    return tx.documentStoryProposalValidation.create({
      data: {
        id: input.operationId,
        proposalId,
        bookId,
        userId,
        bookRevisionId: source.bookRevisionId,
        layoutRevisionId: source.layoutRevisionId,
        storyId: proposal.storyId,
        contentHash: source.contentHash,
        targets: json(snapshot.targets),
      },
    });
  });
}
export async function applyStoryProposal(
  userId: number,
  bookId: number,
  proposalId: string,
  raw: unknown,
) {
  const input = documentStoryProposalApplySchema.parse(raw),
    proposal = await readStoryProposal(userId, bookId, proposalId),
    discussion = await readStoryDiscussion(
      userId,
      bookId,
      proposal.discussionId,
    ),
    snapshot =
      discussion.snapshot as unknown as DocumentStoryDiscussionSnapshot;
  return documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId,
      expectedScopes: { layout: input.expectedLayoutRevisionId },
      payload: { action: "apply-owned-story-proposal", proposalId, input },
    },
    async (tx) => {
      const source = await ownedStorySource(
          tx,
          userId,
          bookId,
          proposal.storyId,
        ),
        row = await tx.documentStoryProposal.findFirstOrThrow({
          where: { id: proposalId, userId, bookId },
        }),
        validation = await tx.documentStoryProposalValidation.findFirst({
          where: { id: input.validationId, proposalId, userId, bookId },
        });
      if (row.status !== "ready" || !validation)
        throw new DocumentError(
          "DOCUMENT_PROPOSAL_UNAVAILABLE",
          "Story proposal must be ready and explicitly revalidated.",
          409,
        );
      if (
        validation.bookRevisionId !== input.expectedRevisionId ||
        validation.layoutRevisionId !== input.expectedLayoutRevisionId ||
        validation.storyId !== proposal.storyId ||
        validation.contentHash !== source.contentHash ||
        source.layoutRevisionId !== input.expectedLayoutRevisionId
      )
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "The revalidated story source changed.",
          412,
        );
      if (source.ownerContextHash !== snapshot.ownerContextHash)
        throw new DocumentError(
          "DOCUMENT_TARGET_STALE",
          "Owned story parent/style/layout changed.",
          409,
        );
      const result = row.result as unknown as {
          output: DocumentProposalOutput;
        },
        document = editedDocument(
          source.document,
          snapshot,
          result.output,
          input.targetIds,
          userId,
        );
      await tx.documentStoryProposal.update({
        where: { id: proposalId },
        data: { status: "applied", applicationOperationId: input.operationId },
      });
      return {
        result: {
          sourceKind: "layout-story",
          storyId: proposal.storyId,
          proposalId,
          targetIds: input.targetIds,
        },
        layout: replaceStoryDocument(source.layout, proposal.storyId, document),
        receiptProjection: "references",
      };
    },
    "ai",
  );
}
export async function commitStoryDraft(
  userId: number,
  bookId: number,
  storyId: string,
  raw: unknown,
) {
  const input = documentStoryDraftCommitSchema.parse(raw);
  return documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId,
      expectedScopes: { layout: input.expectedLayoutRevisionId },
      payload: { action: "commit-owned-story-draft", storyId, input },
    },
    async (tx) => {
      const source = await ownedStorySource(tx, userId, bookId, storyId);
      if (source.contentHash !== input.expectedContentHash)
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "Owned story content changed before draft commit.",
          412,
        );
      const document = deriveStoryDraft(source, input, userId),
        layout = replaceStoryDocument(source.layout, storyId, document);
      return {
        result: {
          sourceKind: "layout-story" as const,
          storyId,
          bookRevisionId: source.bookRevisionId,
          layoutRevisionId: source.layoutRevisionId,
          contentHash: source.contentHash,
        },
        layout,
        receiptProjection: "references",
        projectCommitted: ({ revisionId, manifest }) => ({
          sourceKind: "layout-story" as const,
          storyId,
          bookRevisionId: revisionId,
          layoutRevisionId: manifest.scopes!.layout.revisionId,
          contentHash: storyDigest(
            exactLayoutStory(layout, storyId).story.document,
          ),
        }),
      };
    },
  );
}
