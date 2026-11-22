import { campaignProposalContext, assertCampaignProposalCurrent, assertCampaignVerification } from './campaigns';
import { readChapterTransitions, assertTransitionRevision, verifyTransitionOutput } from './chapterTransitions';
import { plotThreadProposalContext, assertPlotThreadProposalCurrent, verifyPlotThreadProposalOutput } from './plotThreads';
import {
  assertNewReleaseAdmission,
  runReleaseProviderEffect,
  providerWasNotStarted,
} from "@/operations/releaseAdmission";
import { verifySceneTargetContext } from "./sceneTargetContext";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { databaseService } from "@/lib/database";
import { SceneProseService } from "@/services/sceneProseService";
import { currentDocumentMutationContext } from "@/services/documentMutationContext";
import { currentWorkflowExecution } from "@/services/workflowExecutionContext";
import { frozenTarget, verifyTargets, protectedObjects } from "./targets";
import { documentProposalPrompt } from "./proposalPrompt";
import {
  deriveDiscussionDraft,
  assertLegacyDiscussionDraft,
} from "./proposalDraft";
import { readPassageOwnedContext } from "./passageSource";
import {
  proposalContextBudget,
  proposalContextBlocks,
} from "./proposalContext";
import { InferenceTerminalError } from "@/lib/ai/terminalReason";
import { documentService } from "./service";
import { assertOwnedStyleReferences } from "./styleAuthority";
import { DocumentError } from "./errors";
import { validateDocument } from "./validation";
import { readScope } from "./scopes";
import {
  canonicalDocument,
  minimalTextEdit,
  projectDocument,
  replaceDocumentText,
  type ProserDocument,
} from "./model";
import {
  documentDiscussionSchema,
  documentProposalRequestSchema,
  documentProposalOutputSchema,
  documentProposalRevalidateSchema,
  documentProposalApplySchema,
} from "./proposalValidation";
import type {
  DocumentDiscussionSnapshot,
  DocumentProposalOutput,
} from "./proposal-model";

const db = () => databaseService.client;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
const active = new Map<string, AbortController>();
export function editedDocument(
  document: ProserDocument,
  snapshot: Pick<DocumentDiscussionSnapshot, "targets">,
  output: DocumentProposalOutput,
  targetIds: string[],
  userId: number,
) {
  const chosen = output.edits.filter((edit) =>
    targetIds.includes(edit.targetId),
  );
  if (
    new Set(targetIds).size !== targetIds.length ||
    chosen.length !== targetIds.length
  )
    throw new DocumentError(
      "DOCUMENT_PROPOSAL_INVALID",
      "Select existing proposal edits exactly once.",
      409,
    );
  verifyTargets(
    document,
    snapshot.targets.filter((target) => targetIds.includes(target.targetId)),
  );
  const projection = projectDocument(document);
  const operations = chosen
    .map((edit) => {
      const target = snapshot.targets.find(
        (target) => target.targetId === edit.targetId,
      )!;
      if (!target.editable)
        throw new DocumentError(
          "DOCUMENT_REVIEW_CONFLICT",
          "Resolve the existing review changes before editing this target.",
          409,
        );
      if (
        edit.sourceText !== target.sourceText ||
        edit.replacement.includes("\n\n")
      )
        throw new DocumentError(
          "DOCUMENT_PROPOSAL_INVALID",
          "The model changed source text or requested an unsupported paragraph operation.",
          422,
        );
      const spans = projection.spans.filter(
        (span) => span.blockId === target.blockId && span.runId !== undefined,
      );
      if (!spans.length)
        throw new DocumentError(
          "DOCUMENT_TARGET_STALE",
          "Selection is no longer editable.",
          409,
        );
      const diff = minimalTextEdit(target.sourceText, edit.replacement);
      return {
        blockId: target.blockId,
        from: spans[0].start + target.from + diff.start,
        to: spans[0].start + target.from + diff.end,
        source: target.sourceText.slice(diff.start, diff.end),
        replacement: diff.replacement,
      };
    })
    .sort((a, b) => b.from - a.from);
  for (let index = 1; index < operations.length; index++)
    if (operations[index].to >= operations[index - 1].from)
      throw new DocumentError(
        "DOCUMENT_PROPOSAL_OVERLAP",
        "Overlapping proposal edits require separate review.",
        409,
      );
  let next = document;
  for (const operation of operations)
    if (operation.source !== operation.replacement) {
      try {
        next = replaceDocumentText(
          next,
          operation.from,
          operation.to,
          operation.source,
          operation.replacement,
          randomUUID,
          {
            authorId: userId,
            authorName: String(userId),
            createdAt: new Date().toISOString(),
            origin: "ai",
            status: "pending",
          },
          { blockId: operation.blockId },
        );
      } catch (error) {
        throw new DocumentError(
          "DOCUMENT_PROPOSAL_INCOMPATIBLE",
          error instanceof Error
            ? error.message
            : "The edit cannot preserve this target.",
          409,
        );
      }
    }
  return validateDocument(next);
}
async function owned(userId: number, bookId: number) {
  if (
    (currentDocumentMutationContext()?.userId !== undefined &&
      currentDocumentMutationContext()!.userId !== userId) ||
    !(await db().book.findFirst({
      where: { id: bookId, userId, deletedAt: {} },
      select: { id: true },
    }))
  )
    throw new DocumentError("DOCUMENT_SCOPE_NOT_FOUND", "Book not found.", 404);
}
export async function createDocumentDiscussion(
  userId: number,
  bookId: number,
  raw: unknown,
) {
  const input = documentDiscussionSchema.parse(raw);
  await owned(userId, bookId);
  const requestHash = digest({ userId, bookId, input });
  const prior = await db().documentDiscussion.findUnique({
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
        "Discussion ID belongs to another request.",
        409,
      );
    return prior;
  }
  const source = await documentService.read(userId, bookId, input.sceneId);
  if (
    source.bookRevisionId !== input.expectedRevisionId ||
    source.revisionId !== input.expectedSceneRevisionId ||
    source.contentHash !== input.expectedContentHash
  )
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Save/reconcile this document before preparing context.",
      412,
      { currentRevisionId: source.bookRevisionId },
    );
  const sourceManifest = await db().bookDocumentRevision.findFirstOrThrow({
    where: { id: source.bookRevisionId, bookId },
    select: { manifest: true },
  });
  const immutableManifest =
    sourceManifest.manifest as unknown as import("./model").DocumentManifest;
  const reference = immutableManifest.scenes.find(
    (item) =>
      item.sceneId === input.sceneId && item.revisionId === source.revisionId,
  );
  if (!reference)
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "The owned scene is missing from its source manifest.",
      412,
    );
  const context = await readPassageOwnedContext(
    db(),
    bookId,
    source.bookRevisionId,
    immutableManifest,
    reference,
  );
  const transition = input.transitionChapterId === undefined ? undefined :
    (await readChapterTransitions(userId, bookId, input.expectedRevisionId, input.transitionChapterId)).transitions[0];
  if (input.transitionChapterId !== undefined && (!transition || !transition.ending.text.trim() || !transition.opening.text.trim() ||
      transition.opening.sceneId !== input.sceneId || !transition.opening.target ||
      canonicalDocument(input.targets) !== canonicalDocument([transition.opening.target]) ||
      input.localDocument || input.localOperations || input.parentDiscussionId))
    throw new DocumentError('DOCUMENT_TRANSITION_INVALID', 'Review requires the exact saved opening target and both adjacent chapter boundaries.', 409);
  if (input.plotThreadReviewId && (input.localDocument || input.localOperations || input.parentDiscussionId || input.transitionChapterId)) throw new DocumentError('PLOT_THREAD_EVIDENCE_INVALID', 'Thread revisions require only the cited saved target.', 409);
  const draft = input.localOperations
    ? deriveDiscussionDraft(
        source.document,
        input.localOperations,
        context,
        userId,
      )
    : input.localDocument
      ? validateDocument(input.localDocument)
      : source.document;
  if (input.localDocument) assertLegacyDiscussionDraft(source.document, draft);
  // Draft text/styles may vary. Protected objects and server review identities
  // remain bound to owned content until they have been committed independently.
  if (
    digest(protectedObjects(draft)) !==
      digest(protectedObjects(source.document)) ||
    digest(draft.changes) !== digest(source.document.changes) ||
    digest(draft.comments) !== digest(source.document.comments)
  )
    throw new DocumentError(
      "DOCUMENT_DRAFT_REQUIRES_SAVE",
      "Save object/review changes before preparing unsaved text context.",
      409,
    );
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
          "Selected targets overlap.",
          409,
        );
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const previous = await tx.documentDiscussion.findUnique({
      where: { id: input.operationId },
    });
    if (previous) {
      if (previous.requestHash !== requestHash || previous.userId !== userId)
        throw new DocumentError(
          "DOCUMENT_OPERATION_CONFLICT",
          "Discussion ID was reused.",
          409,
        );
      return previous;
    }
    const manifest = await tx.bookDocumentHead.findUniqueOrThrow({
      where: { bookId },
    });
    if (manifest.revisionId !== source.bookRevisionId)
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Book changed during context preparation.",
        412,
      );
    const references = (
      manifest.manifest as unknown as import("./model").DocumentManifest
    ).scopes!;
    const canon = await readScope(tx, bookId, "canon", references.canon);
    assertOwnedStyleReferences(
      draft,
      (await readScope(tx, bookId, "layout", references.layout)).styles,
    );
    const budget = proposalContextBudget(targets),
      contextBlocks = proposalContextBlocks(draft, targets);
    const snapshot: DocumentDiscussionSnapshot = {
      schemaVersion: 1,
      ...(input.revisionCampaignPlanId && input.revisionCampaignStepId ? { revisionCampaign: await campaignProposalContext(tx, userId, bookId, input.revisionCampaignPlanId, input.revisionCampaignStepId, input.sceneId, targets) } : {}),
      ...(transition ? { transition } : {}),
      ...(input.plotThreadReviewId && input.plotThreadEvidenceId ? { plotThread: await plotThreadProposalContext(tx, userId, bookId, input.plotThreadReviewId, input.plotThreadEvidenceId, input.sceneId, targets) } : {}),
      sceneId: input.sceneId,
      sessionId: input.sessionId,
      projection: "final",
      sourceBookRevisionId: source.bookRevisionId,
      sourceSceneRevisionId: source.revisionId,
      sourceContentHash: source.contentHash,
      bookLayoutHash: references.layout.contentHash,
      localDraftDigest: digest(draft),
      unsaved: digest(draft) !== source.contentHash,
      targets,
      blocks: contextBlocks.blocks,
      codex: [],
      omitted: { blockIds: contextBlocks.omittedBlockIds, codexIds: [] },
      maxPromptBytes: budget.maxPromptBytes,
      maxOutputTokens: budget.maxOutputTokens,
      templateVersion: "1.0.0",
      conversation: [],
      omittedProposalIds: [],
      omittedEarlierTurnCount: 0,
      ...(input.localOperations
        ? { draftOperationId: input.localOperations.operationId }
        : {}),
    };
    // A byte ceiling is a conservative token upper bound for UTF-8 byte fallback
    // tokenizers. Reserve instruction/template bytes without truncating targets.
    const reservedBytes = 8000;
    if (
      Buffer.byteLength(documentProposalPrompt(snapshot, "")) + reservedBytes >
      snapshot.maxPromptBytes
    )
      throw new DocumentError(
        "DOCUMENT_CONTEXT_TOO_LARGE",
        "The complete target blocks exceed this model context budget. Select fewer complete blocks.",
        413,
      );
    if (input.parentDiscussionId) {
      const parent = await tx.documentDiscussion.findFirst({
        where: {
          id: input.parentDiscussionId,
          userId,
          bookId,
          sceneId: input.sceneId,
        },
      });
      if (!parent)
        throw new DocumentError(
          "DOCUMENT_SCOPE_NOT_FOUND",
          "Parent discussion not found.",
          404,
        );
      const parentSnapshot =
        parent.snapshot as unknown as DocumentDiscussionSnapshot;
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
      const total = await tx.documentProposal.count({ where });
      const turns = await tx.documentProposal.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 9,
      });
      snapshot.omittedEarlierTurnCount += Math.max(0, total - turns.length);
      turns.reverse();
      for (const turn of turns) {
        const result = turn.result as unknown as {
          output?: DocumentProposalOutput;
        };
        const request = turn.request as unknown as { instruction: string };
        if (result.output)
          snapshot.conversation.push({
            proposalId: turn.id,
            instruction: request.instruction,
            reply: result.output.reply,
            sourceSceneRevisionId: parentSnapshot.sourceSceneRevisionId,
          });
      }
      // Retain complete turns. Record every omitted loaded turn rather than
      // cutting a reply or selected manuscript block silently.
      while (
        snapshot.conversation.length > 8 ||
        Buffer.byteLength(documentProposalPrompt(snapshot, "")) +
          reservedBytes >
          snapshot.maxPromptBytes
      ) {
        const omitted = snapshot.conversation.shift();
        if (!omitted) break;
        snapshot.omittedProposalIds.push(omitted.proposalId);
      }
    }
    for (const entry of canon.entries
      .filter((entry) => !entry.deletedAt)
      .sort((a, b) => a.id - b.id)) {
      const included = {
        id: entry.id,
        name: entry.entryName,
        type: entry.entryType,
        text: [entry.entryDescription, entry.attributes]
          .filter(Boolean)
          .join("\n"),
      };
      snapshot.codex.push(included);
      if (
        Buffer.byteLength(documentProposalPrompt(snapshot, "")) +
          reservedBytes >
        snapshot.maxPromptBytes
      ) {
        snapshot.codex.pop();
        snapshot.omitted.codexIds.push(entry.id);
      }
    }
    return tx.documentDiscussion.create({
      data: {
        id: input.operationId,
        bookId,
        userId,
        sceneId: input.sceneId,
        sessionId: input.sessionId,
        requestHash,
        request: json(input),
        snapshot: json(snapshot),
      },
    });
  });
}
export async function readDocumentDiscussion(
  userId: number,
  bookId: number,
  id: string,
) {
  await owned(userId, bookId);
  const row = await db().documentDiscussion.findFirst({
    where: { id, bookId, userId },
  });
  if (!row)
    throw new DocumentError(
      "DOCUMENT_SCOPE_NOT_FOUND",
      "Discussion not found.",
      404,
    );
  return row;
}
export async function readDocumentProposal(
  userId: number,
  bookId: number,
  id: string,
) {
  await owned(userId, bookId);
  let row = await db().documentProposal.findFirst({
    where: { id, bookId, userId },
  });
  if (!row)
    throw new DocumentError(
      "DOCUMENT_SCOPE_NOT_FOUND",
      "Proposal not found.",
      404,
    );
  // Campaign proposals use saved targets only. Retained acknowledged bytes
  // can be validated against that immutable source after a process interruption,
  // even if later edits have made the plan stale. Application still rechecks it.
  const retainedDigest = digest(row.result);
  const retained = row.result as unknown as { raw?: string; provenance?: unknown } | null;
  if (['running','unknown'].includes(row.status) && !active.has(row.id) && typeof retained?.raw === 'string') {
    const discussion = await db().documentDiscussion.findFirst({ where: { id: row.discussionId, userId, bookId } });
    const snapshot = discussion?.snapshot as unknown as DocumentDiscussionSnapshot | undefined;
    if (snapshot?.revisionCampaign) await documentService.sideRecord(userId, bookId, async tx => {
      const current = await tx.documentProposal.findFirstOrThrow({ where: { id, userId, bookId } });
      if (!['running','unknown'].includes(current.status) || digest(current.result) !== retainedDigest) return;
      let result: unknown = retained, status = 'failed', errorCode: string | null = 'PROPOSAL_RESPONSE_INVALID';
      try {
        if (digest({ userId, bookId, discussionId: current.discussionId, input: current.request }) !== current.requestHash) throw new DocumentError('DOCUMENT_OPERATION_CONFLICT','Retained proposal request checksum differs.',409);
        const saved = await tx.sceneDocumentRevision.findFirstOrThrow({ where: { bookId, sceneId: current.sceneId, id: snapshot.sourceSceneRevisionId } });
        if (digest(saved.document) !== snapshot.sourceContentHash) throw new DocumentError('DOCUMENT_SOURCE_STALE','Retained proposal source checksum differs.',412);
        const output = documentProposalOutputSchema.parse(JSON.parse(retained.raw!));
        if (new Set(output.edits.map(edit => edit.targetId)).size !== output.edits.length || output.edits.some(edit => !snapshot.targets.some(target => target.targetId === edit.targetId && target.sourceText === edit.sourceText))) throw new DocumentError('DOCUMENT_PROPOSAL_INVALID','Retained proposal targets differ.',422);
        editedDocument(validateDocument(saved.document), snapshot, output, output.edits.map(edit => edit.targetId), userId);
        result = { ...retained, output }; status = 'ready'; errorCode = null;
      } catch (error) { if (error instanceof DocumentError) errorCode = error.code; }
      await tx.documentProposal.update({ where: { id }, data: { result: json(result), status, errorCode, completedAt: new Date() } });
      await tx.auditLog.create({ data: { userId, entityType: 'book', entityId: bookId, action: 'update', metadata: { action: 'recover-campaign-proposal-result', proposalId: id, priorStatus: current.status, resultHash: digest(retained), status } } });
    });
    row = await db().documentProposal.findUniqueOrThrow({ where: { id } });
  }
  if (
    row.status === "running" &&
    row.startedAt &&
    Date.now() - row.startedAt.getTime() > 150000
  ) {
    await db().documentProposal.updateMany({
      where: { id, status: "running", startedAt: row.startedAt },
      data: {
        status: "unknown",
        errorCode: "PROVIDER_ACKNOWLEDGEMENT_EXPIRED",
      },
    });
    row = await db().documentProposal.findUniqueOrThrow({ where: { id } });
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
export async function requestDocumentProposal(
  userId: number,
  bookId: number,
  discussionId: string,
  raw: unknown,
) {
  const input = documentProposalRequestSchema.parse(raw);
  const discussion = await readDocumentDiscussion(userId, bookId, discussionId);
  const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
  const prompt = documentProposalPrompt(snapshot, input.instruction);
  if (snapshot.plotThread) await assertPlotThreadProposalCurrent(userId, bookId, snapshot.plotThread);
  if (Buffer.byteLength(prompt) > snapshot.maxPromptBytes)
    throw new DocumentError(
      "DOCUMENT_CONTEXT_TOO_LARGE",
      "The disclosed context and complete instruction exceed the context budget.",
      413,
    );
  const requestHash = digest({ userId, bookId, discussionId, input });
  let row = await db().documentProposal.findUnique({
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
      "Proposal operation belongs to another request.",
      409,
    );
  if (!row)
    row = await documentService.sideRecord(userId, bookId, async (tx) => {
      const previous = await tx.documentProposal.findUnique({
        where: { id: input.operationId },
      });
      if (previous) {
        if (previous.requestHash !== requestHash || previous.userId !== userId)
          throw new DocumentError(
            "DOCUMENT_OPERATION_CONFLICT",
            "Proposal ID was reused.",
            409,
          );
        return previous;
      }
      const head = await tx.bookDocumentHead.findUniqueOrThrow({
        where: { bookId },
      });
      if (head.revisionId !== snapshot.sourceBookRevisionId)
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "The disclosed source changed before inference. Prepare context again.",
          412,
        );
      if (snapshot.revisionCampaign) await assertCampaignProposalCurrent(tx, userId, bookId, snapshot.revisionCampaign);
      return tx.documentProposal.create({
        data: {
          id: input.operationId,
          discussionId,
          bookId,
          userId,
          sceneId: discussion.sceneId,
          requestHash,
          request: json(input),
        },
      });
    });
  if (row.status !== "pending")
    return readDocumentProposal(userId, bookId, row.id);
  if (snapshot.revisionCampaign) await assertCampaignProposalCurrent(db(), userId, bookId, snapshot.revisionCampaign, row.id);
  await documentService.assertMutationAuthority(
    userId,
    bookId,
    snapshot.sourceBookRevisionId,
  );
  const claimed = await db().$transaction(async (tx) => {
    await assertNewReleaseAdmission(tx);
    return tx.documentProposal.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "running", startedAt: new Date() },
    });
  });
  if (!claimed.count) return readDocumentProposal(userId, bookId, row.id);
  const controller = new AbortController();
  active.set(row.id, controller);
  const callerSignal =
    currentWorkflowExecution()?.signal ??
    currentDocumentMutationContext()?.signal();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void db()
      .documentProposal.findUnique({
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
        kind: "document-proposal",
        id: row.id,
        bookId,
        revisionId: snapshot.sourceSceneRevisionId,
        hash: snapshot.sourceContentHash,
      },
    );
    acknowledged = true;
    if (Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024)
      throw new DocumentError(
        "DOCUMENT_PROPOSAL_RESULT_TOO_LARGE",
        "Provider result exceeds 1 MiB.",
        413,
      );
    await db().documentProposal.update({
      where: { id: row.id },
      data: { result: json(response) },
    });
    const output = documentProposalOutputSchema.parse(JSON.parse(response.raw));
    const known = new Map(
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
        "The model changed supplied identities or exact source text.",
        422,
      );
    const retained =
      discussion.request as unknown as import("./proposal-model").DocumentDiscussionInput;
    const source = await db().sceneDocumentRevision.findUniqueOrThrow({
      where: { id: snapshot.sourceSceneRevisionId },
    });
    let derivative =
      retained.localDocument ?? validateDocument(source.document);
    if (retained.localOperations) {
      const original = await db().bookDocumentRevision.findFirstOrThrow({
        where: { id: snapshot.sourceBookRevisionId, bookId },
        select: { manifest: true },
      });
      const manifest =
        original.manifest as unknown as import("./model").DocumentManifest;
      const reference = manifest.scenes.find(
        (item) =>
          item.sceneId === snapshot.sceneId &&
          item.revisionId === snapshot.sourceSceneRevisionId,
      );
      if (!reference)
        throw new DocumentError(
          "DOCUMENT_TARGET_SOURCE_INVALID",
          "Original owned draft provenance is unavailable.",
          409,
        );
      derivative = deriveDiscussionDraft(
        derivative,
        retained.localOperations,
        await readPassageOwnedContext(
          db(),
          bookId,
          snapshot.sourceBookRevisionId,
          manifest,
          reference,
        ),
        userId,
      );
      if (digest(derivative) !== snapshot.localDraftDigest)
        throw new DocumentError(
          "DOCUMENT_TARGET_SOURCE_INVALID",
          "Original unsaved derivative checksum differs from the disclosed snapshot.",
          409,
        );
    }
    verifyTransitionOutput(snapshot, output);
    verifyPlotThreadProposalOutput(snapshot, output);
    editedDocument(
      derivative,
      snapshot,
      output,
      output.edits.map((edit) => edit.targetId),
      userId,
    );
    await db().documentProposal.update({
      where: { id: row.id },
      data: { result: json({ ...response, output }) },
    });
    if (snapshot.revisionCampaign) await documentService.sideRecord(userId, bookId, tx => assertCampaignProposalCurrent(tx, userId, bookId, snapshot.revisionCampaign!, row.id));
    await db().documentProposal.updateMany({
      where: { id: row.id, status: "running" },
      data: { status: "ready", completedAt: new Date() },
    });
  } catch (error) {
    if (providerWasNotStarted(error)) {
      await db().documentProposal.updateMany({
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
      const size = Buffer.byteLength(error.partialOutput);
      await db().documentProposal.update({
        where: { id: row.id },
        data: {
          result: json({
            providerOutcome: "completed",
            finishReason: error.finishReason,
            raw: size <= 1024 * 1024 ? error.partialOutput : undefined,
            partialOutputSha256: createHash("sha256")
              .update(error.partialOutput)
              .digest("hex"),
            partialOutputBytes: size,
            retainedPartialOutput: size <= 1024 * 1024,
            errorCode: error.code,
          }),
        },
      });
    }
    await db().documentProposal.updateMany({
      where: { id: row.id, status: "running" },
      data: {
        status: acknowledged ? "failed" : "unknown",
        errorCode: acknowledged
          ? "PROPOSAL_RESPONSE_INVALID"
          : "PROVIDER_OUTCOME_UNKNOWN",
        completedAt: acknowledged ? new Date() : null,
      },
    });
    if (
      error instanceof DocumentError &&
      error.code === "DOCUMENT_PROPOSAL_RESULT_TOO_LARGE"
    )
      await db().documentProposal.update({
        where: { id: row.id },
        data: {
          result: {
            providerOutcome: "completed",
            reason: "Provider result exceeded the retained byte ceiling.",
          },
        },
      });
  } finally {
    clearInterval(timer);
    active.delete(input.operationId);
  }
  return readDocumentProposal(userId, bookId, row.id);
}
export async function cancelDocumentProposal(
  userId: number,
  bookId: number,
  id: string,
) {
  const receipt = await documentService.sideRecord(
    userId,
    bookId,
    async (tx) => {
      const row = await tx.documentProposal.findFirst({
        where: { id, bookId, userId },
      });
      if (!row)
        throw new DocumentError(
          "DOCUMENT_SCOPE_NOT_FOUND",
          "Proposal not found.",
          404,
        );
      if (["applied", "cancelled", "failed", "unknown"].includes(row.status))
        return { id, status: row.status };
      await tx.documentProposal.update({
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
export async function revalidateDocumentProposal(
  userId: number,
  bookId: number,
  proposalId: string,
  raw: unknown,
) {
  const input = documentProposalRevalidateSchema.parse(raw);
  const proposal = await readDocumentProposal(userId, bookId, proposalId);
  if (proposal.status !== "ready")
    throw new DocumentError(
      "DOCUMENT_PROPOSAL_UNAVAILABLE",
      "Only a ready proposal can be revalidated.",
      409,
    );
  const discussion = await readDocumentDiscussion(
    userId,
    bookId,
    proposal.discussionId,
  );
  const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
  const source = await documentService.read(userId, bookId, proposal.sceneId);
  if (
    source.bookRevisionId !== input.expectedRevisionId ||
    source.revisionId !== input.expectedSceneRevisionId
  )
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Flush edits and use the resulting saved revision.",
      412,
    );
  assertTransitionRevision(snapshot, source.bookRevisionId);
  if (snapshot.revisionCampaign) await assertCampaignProposalCurrent(db(), userId, bookId, snapshot.revisionCampaign);
  if (snapshot.plotThread) await assertPlotThreadProposalCurrent(userId, bookId, snapshot.plotThread);
  verifyTargets(source.document, snapshot.targets);
  const head = await documentService.manifest(userId, bookId);
  await verifySceneTargetContext(
    db(),
    bookId,
    proposal.sceneId,
    {
      bookRevisionId: snapshot.sourceBookRevisionId,
      sceneRevisionId: snapshot.sourceSceneRevisionId,
      contentHash: snapshot.sourceContentHash,
      bookLayoutHash: snapshot.bookLayoutHash,
    },
    head,
  );
  if (head.scopes?.layout.contentHash !== snapshot.bookLayoutHash)
    throw new DocumentError(
      "DOCUMENT_TARGET_STALE",
      "Book layout changed since the proposal context.",
      409,
    );
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const current = await tx.bookDocumentHead.findUniqueOrThrow({
      where: { bookId },
    });
    if (current.revisionId !== source.bookRevisionId)
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Source changed during revalidation.",
        412,
      );
    if (snapshot.revisionCampaign) {
      const result = proposal.result as unknown as { output: DocumentProposalOutput };
      await assertCampaignProposalCurrent(tx, userId, bookId, snapshot.revisionCampaign);
      if (!result.output.edits.length) throw new DocumentError('REVISION_CAMPAIGN_PROPOSAL_INVALID', 'A prose edit is required.', 422);
    }
    const previous = await tx.documentProposalValidation.findUnique({
      where: { id: input.operationId },
    });
    if (previous) {
      if (
        previous.proposalId !== proposalId ||
        previous.userId !== userId ||
        previous.bookRevisionId !== source.bookRevisionId ||
        previous.sceneRevisionId !== source.revisionId
      )
        throw new DocumentError(
          "DOCUMENT_OPERATION_CONFLICT",
          "Validation ID was reused.",
          409,
        );
      return previous;
    }
    return tx.documentProposalValidation.create({
      data: {
        id: input.operationId,
        proposalId,
        bookId,
        userId,
        bookRevisionId: source.bookRevisionId,
        sceneRevisionId: source.revisionId,
        contentHash: source.contentHash,
        targets: json(snapshot.targets),
      },
    });
  });
}
export async function applyDocumentProposal(
  userId: number,
  bookId: number,
  proposalId: string,
  raw: unknown,
) {
  const input = documentProposalApplySchema.parse(raw);
  const proposal = await readDocumentProposal(userId, bookId, proposalId);
  const discussion = await readDocumentDiscussion(
    userId,
    bookId,
    proposal.discussionId,
  );
  const snapshot = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
  // The receipt path runs before the mutation callback, so retries recover even
  // after later content/review edits. Never rebase an unknown operation.
  return documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId,
      expectedScopes: {},
      payload: { action: "apply-document-proposal", proposalId, input },
    },
    async (tx) => {
      const source = await documentService.read(
        userId,
        bookId,
        proposal.sceneId,
      );
      const row = await tx.documentProposal.findFirstOrThrow({
        where: { id: proposalId, userId, bookId },
      });
      const validation = await tx.documentProposalValidation.findFirst({
        where: { id: input.validationId, proposalId, userId, bookId },
      });
      if (row.status !== "ready" || !validation)
        throw new DocumentError(
          "DOCUMENT_PROPOSAL_UNAVAILABLE",
          "Proposal must be ready and explicitly revalidated.",
          409,
        );
      if (
        validation.bookRevisionId !== input.expectedRevisionId ||
        validation.sceneRevisionId !== input.expectedSceneRevisionId ||
        validation.contentHash !== source.contentHash ||
        source.revisionId !== input.expectedSceneRevisionId
      )
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "The revalidated source changed.",
          412,
        );
      const head = await tx.bookDocumentHead.findUniqueOrThrow({
        where: { bookId },
      });
      await verifySceneTargetContext(
        tx,
        bookId,
        proposal.sceneId,
        {
          bookRevisionId: snapshot.sourceBookRevisionId,
          sceneRevisionId: snapshot.sourceSceneRevisionId,
          contentHash: snapshot.sourceContentHash,
          bookLayoutHash: snapshot.bookLayoutHash,
        },
        head.manifest as unknown as import("./model").DocumentManifest,
      );
      assertTransitionRevision(snapshot, head.revisionId);
      if (snapshot.revisionCampaign) await assertCampaignProposalCurrent(db(), userId, bookId, snapshot.revisionCampaign);
  if (snapshot.plotThread) await assertPlotThreadProposalCurrent(userId, bookId, snapshot.plotThread);
      const result = row.result as unknown as {
        output: DocumentProposalOutput;
      };
      verifyTransitionOutput(snapshot, result.output);
      verifyPlotThreadProposalOutput(snapshot, result.output);
      await assertCampaignVerification(tx, userId, bookId, proposalId, snapshot, result.output, input.targetIds);
      const document = editedDocument(
        source.document,
        snapshot,
        result.output,
        input.targetIds,
        userId,
      );
      await tx.documentProposal.update({
        where: { id: proposalId },
        data: { status: "applied", applicationOperationId: input.operationId },
      });
      return {
        receiptProjection: "references",
        result: {
          proposalId,
          targetIds: input.targetIds,
          sceneId: proposal.sceneId,
          sourceBookRevisionId: source.bookRevisionId,
          sourceSceneRevisionId: source.revisionId,
        },
        changedDocuments: [
          {
            sceneId: proposal.sceneId,
            expectedRevisionId: input.expectedSceneRevisionId,
            document,
          },
        ],
      };
    },
    "ai",
  );
}
