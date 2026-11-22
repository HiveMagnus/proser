import { currentDocumentMutationContext } from "@/services/documentMutationContext";
import { bindSharedResourceExecution } from "@/services/sharedResourceService";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { databaseService } from "@/lib/database";
import { documentService } from "./service";
import { assertStoryBookOwner, storyDigest } from "./storyProposalSources";
import { DocumentError } from "./errors";
import {
  bindReleaseAdmission,
  assertNewReleaseAdmission,
} from "@/operations/releaseAdmission";
import {
  createWorkflowEnqueue,
  dispatchWorkflowOutbox,
} from "@/queues/workflowOutbox";
import {
  campaignMutationSchema,
  campaignAnalysisSchema,
  campaignDecisionSchema,
} from "./campaignValidation";
import {
  captureCampaignSource,
  assertCampaignSource,
  verifyCampaignCitation,
  type CampaignClient,
  type CampaignSnapshot,
} from "./campaignSources";
import type {
  CampaignAnalysis,
  CampaignRecord,
  CampaignDetail,
  CampaignPlanRecord,
  CampaignProposalContext,
  CampaignVerification,
} from "./campaign-model";
import type {
  DocumentDiscussionSnapshot,
  DocumentProposalOutput,
} from "./proposal-model";
const db = () => databaseService.client;
export const campaignJson = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function ownedCampaign(
  tx: CampaignClient,
  userId: number,
  bookId: number,
  id: string,
  version?: number,
) {
  const campaign = await tx.revisionCampaign.findFirst({
    where: { id, userId, bookId },
  });
  if (!campaign)
    throw new DocumentError(
      "REVISION_CAMPAIGN_NOT_FOUND",
      "Campaign not found.",
      404,
    );
  if (version !== undefined && campaign.version !== version)
    throw new DocumentError(
      "REVISION_CAMPAIGN_VERSION_CONFLICT",
      "Campaign changed. Reload before saving.",
      409,
    );
  return campaign;
}
export async function campaignReceipt(
  userId: number,
  bookId: number,
  operationId: string,
) {
  await assertStoryBookOwner(db(), userId, bookId);
  const row = await db().revisionCampaignRecord.findFirst({
    where: { id: operationId, userId, bookId },
  });
  if (!row)
    throw new DocumentError(
      "REVISION_CAMPAIGN_OPERATION_NOT_FOUND",
      "No original campaign receipt.",
      404,
    );
  return row.payload;
}
async function mutate(
  userId: number,
  bookId: number,
  id: string,
  request: unknown,
  action: (
    tx: Prisma.TransactionClient,
  ) => Promise<{ campaignId: string; planId?: string; [key: string]: unknown }>,
) {
  const requestHash = storyDigest({ userId, bookId, request });
  return documentService.sideRecord(userId, bookId, async (tx) => {
    const previous = await tx.revisionCampaignRecord.findUnique({
      where: { id },
    });
    if (previous) {
      if (
        previous.bookId !== bookId ||
        previous.userId !== userId ||
        previous.requestHash !== requestHash
      )
        throw new DocumentError(
          "DOCUMENT_OPERATION_CONFLICT",
          "Campaign operation ID belongs to another request.",
          409,
        );
      return previous.payload as Record<string, unknown>;
    }
    const receipt = { operationId: id, ...(await action(tx)) };
    await tx.revisionCampaignRecord.create({
      data: {
        id,
        userId,
        bookId,
        campaignId: receipt.campaignId,
        planId: receipt.planId,
        kind: "mutation",
        requestHash,
        payload: campaignJson(receipt),
      },
    });
    await tx.auditLog.create({
      data: {
        userId,
        entityType: "book",
        entityId: bookId,
        action: "update",
        metadata: campaignJson({ action: "revision-campaign", receipt }),
      },
    });
    return receipt;
  });
}
export async function saveCampaign(
  userId: number,
  bookId: number,
  id: string | undefined,
  raw: unknown,
) {
  const input = campaignMutationSchema.parse(raw);
  return mutate(
    userId,
    bookId,
    input.operationId,
    { id, input },
    async (tx) => {
      if (!id && input.expectedVersion !== 0)
        throw new DocumentError(
          "REVISION_CAMPAIGN_VERSION_CONFLICT",
          "New campaigns use version zero.",
          409,
        );
      const prior = id
        ? await ownedCampaign(tx, userId, bookId, id, input.expectedVersion)
        : null;
      const source = await captureCampaignSource(
        tx,
        bookId,
        input.goal,
        input.constraints,
        input.confirmed,
      );
      for (const rule of [
        ...input.constraints.facts,
        ...input.constraints.voice,
      ])
        for (const citation of rule.citations)
          await verifyCampaignCitation(tx, bookId, source, citation);
      if (
        input.confirmed &&
        (!input.constraints.facts.length || !input.constraints.voice.length)
      )
        throw new DocumentError(
          "REVISION_CAMPAIGN_RULES_REQUIRED",
          "Confirm at least one cited protected fact and one cited voice sample.",
          422,
        );
      const data = {
        goal: input.goal,
        preset: input.preset,
        constraints: campaignJson(input.constraints),
        confirmed: input.confirmed,
        status: "active",
      };
      const campaign = prior
        ? await tx.revisionCampaign.update({
            where: { id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.revisionCampaign.create({
            data: { id: input.operationId, bookId, userId, ...data },
          });
      return { campaignId: campaign.id, version: campaign.version };
    },
  );
}
export async function listCampaigns(userId: number, bookId: number) {
  await assertStoryBookOwner(db(), userId, bookId);
  return db().revisionCampaign.findMany({
    where: { bookId, userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  }) as unknown as Promise<CampaignRecord[]>;
}
export async function readCampaign(
  userId: number,
  bookId: number,
  id: string,
  exactPlanId?: string,
): Promise<CampaignDetail> {
  await assertStoryBookOwner(db(), userId, bookId);
  const campaign = await ownedCampaign(db(), userId, bookId, id);
  const rows = await db().revisionCampaignPlan.findMany({
    where: {
      campaignId: id,
      userId,
      bookId,
      ...(exactPlanId ? { id: exactPlanId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 30,
  });
  const plans: CampaignPlanRecord[] = [];
  for (const row of rows) {
    const snapshot = row.snapshot as unknown as CampaignSnapshot;
    const records = await db().revisionCampaignRecord.findMany({
      where: { planId: row.id, userId, bookId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const result = records.find((x) => x.kind === "analysis");
    const partial = records
      .filter((x) => x.kind.startsWith("scan:"))
      .map(
        (x) =>
          x.payload as unknown as {
            coverage: CampaignAnalysis["coverage"][number];
            steps: CampaignAnalysis["steps"];
            suggestions: CampaignAnalysis["suggestions"];
          },
      );
    const partialAnalysis: CampaignAnalysis | undefined =
      !result && partial.length
        ? {
            rechecks: [],
            summary:
              "Partial analysis; recover the original workflow before preparing edits.",
            suggestions: {
              facts: partial.flatMap((x) => x.suggestions.facts).slice(0, 40),
              voice: partial.flatMap((x) => x.suggestions.voice).slice(0, 10),
            },
            steps: partial.flatMap((x) => x.steps),
            coverage: partial.map((x) => x.coverage),
            gaps: [
              "This analysis has not finished scanning and synthesizing the complete manuscript.",
            ],
            complete: false,
          }
        : undefined;
    const decisions = records
      .filter((x) => x.kind === "decision")
      .map(
        (x) => x.payload as unknown as CampaignPlanRecord["decisions"][number],
      );
    let stale = row.campaignVersion !== campaign.version;
    try {
      await assertCampaignSource(db(), bookId, snapshot);
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      stale = true;
    }
    const run = await db().workflowRun.findUniqueOrThrow({
      where: { id: row.runId },
    });
    plans.push({
      id: row.id,
      campaignId: id,
      campaignVersion: row.campaignVersion,
      runId: row.runId,
      bookRevisionId: snapshot.bookRevisionId,
      stale,
      approved:
        records.some((x) => x.kind === "approval") &&
        !records.some((x) => x.kind === "request-changes"),
      analysis: result
        ? (result.payload as unknown as CampaignAnalysis)
        : partialAnalysis,
      workflowStatus: run.status,
      failureReason: run.failureReason,
      decisions,
    });
  }
  const verifications = (
    await db().revisionCampaignRecord.findMany({
      where: { campaignId: id, bookId, userId, kind: "verification" },
      orderBy: { createdAt: "desc" },
    })
  ).map((x) => x.payload as unknown as CampaignVerification);
  return {
    campaign: campaign as unknown as CampaignRecord,
    plans,
    verifications,
    complete:
      campaign.status === "complete" &&
      plans.some(
        (x) =>
          !x.stale &&
          x.analysis?.complete &&
          !x.analysis.steps.length &&
          !x.analysis.gaps.length &&
          x.decisions.some((d) => d.decision === "finish"),
      ),
  };
}
export async function launchCampaignAnalysis(
  userId: number,
  bookId: number,
  campaignId: string,
  raw: unknown,
) {
  const input = campaignAnalysisSchema.parse(raw);
  const receipt = await mutate(
    userId,
    bookId,
    input.operationId,
    { campaignId, input },
    async (tx) => {
      const campaign = await ownedCampaign(
        tx,
        userId,
        bookId,
        campaignId,
        input.expectedVersion,
      );
      const source = await captureCampaignSource(
        tx,
        bookId,
        campaign.goal,
        campaign.constraints as unknown as CampaignRecord["constraints"],
        campaign.confirmed,
      );
      if (Buffer.byteLength(JSON.stringify(source)) > 8 * 1024 * 1024)
        throw new DocumentError(
          "REVISION_CAMPAIGN_SOURCE_TOO_LARGE",
          "Complete campaign context exceeds the 8 MiB capture ceiling; it was not truncated.",
          413,
        );
      source.preset = campaign.preset;
      source.directions = (
        await tx.revisionCampaignRecord.findMany({
          where: { campaignId, kind: { in: ["request-changes", "decision"] } },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      )
        .map(
          (x) =>
            x.payload as unknown as {
              decision: string;
              reason: string;
              stepId?: string;
            },
        )
        .filter((x) => ["skip", "request-changes"].includes(x.decision));
      if (source.bookRevisionId !== input.expectedRevisionId)
        throw new DocumentError(
          "REVISION_CAMPAIGN_STALE",
          "Refresh the manuscript before analysis.",
          412,
        );
      const unresolved = await tx.documentWorkflowEffect.findFirst({
        where: {
          bookId,
          status: { in: ["unknown", "running"] },
          runId: {
            in: (
              await tx.revisionCampaignPlan.findMany({
                where: { campaignId },
                select: { runId: true },
              })
            ).map((x) => x.runId),
          },
        },
      });
      const active = await tx.workflowRun.count({
        where: {
          bookId,
          workflowType: "revision_campaign_analysis",
          status: { in: ["queued", "running", "paused"] },
        },
      });
      if (unresolved || active)
        throw new DocumentError(
          "REVISION_CAMPAIGN_RECOVERY_REQUIRED",
          "Recover or explicitly cancel the original workflow before starting another analysis. Unknown provider effects cannot be repeated.",
          409,
        );
      if (input.mode === "preview") {
        const proposal = await tx.documentProposal.findFirst({
          where: { id: input.proposalId, bookId, userId, status: "ready" },
        });
        const discussion =
          proposal &&
          (await tx.documentDiscussion.findFirst({
            where: { id: proposal.discussionId, bookId, userId },
          }));
        const context = (
          discussion?.snapshot as unknown as
            DocumentDiscussionSnapshot | undefined
        )?.revisionCampaign;
        if (!context || context.campaignId !== campaignId)
          throw new DocumentError(
            "REVISION_CAMPAIGN_PROPOSAL_INVALID",
            "Preview requires a ready proposal belonging to this campaign.",
            422,
          );
        await assertCampaignProposalCurrent(tx, userId, bookId, context);
      }
      const runId = randomUUID();
      const settings = {
        campaignId,
        planId: input.operationId,
        mode: input.mode,
        proposalId: input.proposalId,
        targetIds: input.targetIds,
      };
      await assertNewReleaseAdmission(tx);
      await tx.workflowRun.create({
        data: {
          id: runId,
          bookId,
          userId,
          workflowType: "revision_campaign_analysis",
          idempotencyKey: `revision-campaign:${input.operationId}`,
          configHash: storyDigest({ input, source }),
          settings: campaignJson(settings),
          progress: { completed: 0, total: 1, percent: 0 },
        },
      });
      await bindReleaseAdmission(tx, "workflow", runId, {
        bookId,
        revisionId: source.bookRevisionId,
      });
      const resourceOperationId =
        currentDocumentMutationContext()?.sharedResourceOperationId;
      if (resourceOperationId)
        await bindSharedResourceExecution(
          tx,
          resourceOperationId,
          "workflow",
          runId,
        );
      await tx.workflowTask.create({
        data: {
          id: randomUUID(),
          runId,
          taskKey: "revision_campaign_analysis:root",
          taskType: "revision_campaign_analysis",
          phase: "queued",
          scopeType: "book",
          scopeId: String(bookId),
          ordinal: 0,
          dependencies: [],
        },
      });
      await tx.revisionCampaignPlan.create({
        data: {
          id: input.operationId,
          campaignId,
          bookId,
          userId,
          campaignVersion: campaign.version,
          runId,
          snapshot: campaignJson(source),
        },
      });
      await createWorkflowEnqueue(
        tx,
        runId,
        userId,
        "workflow_created",
        `campaign:${input.operationId}`,
      );
      return {
        campaignId,
        bookId,
        planId: input.operationId,
        runId,
        statusUrl: `/api/workflows/${runId}`,
      };
    },
  );
  if (process.env.NODE_ENV !== "test")
    await dispatchWorkflowOutbox([
      String((receipt as Record<string, unknown>).runId),
    ]);
  return receipt;
}
export async function campaignPlanCurrent(
  tx: CampaignClient,
  userId: number,
  bookId: number,
  planId: string,
) {
  const plan = await tx.revisionCampaignPlan.findFirst({
    where: { id: planId, userId, bookId },
  });
  if (!plan)
    throw new DocumentError(
      "REVISION_CAMPAIGN_PLAN_NOT_FOUND",
      "Plan not found.",
      404,
    );
  const campaign = await ownedCampaign(
    tx,
    userId,
    bookId,
    plan.campaignId,
    plan.campaignVersion,
  );
  await assertCampaignSource(
    tx,
    bookId,
    plan.snapshot as unknown as CampaignSnapshot,
  );
  return {
    plan,
    campaign,
    snapshot: plan.snapshot as unknown as CampaignSnapshot,
  };
}
export async function campaignDecision(
  userId: number,
  bookId: number,
  campaignId: string,
  planId: string,
  raw: unknown,
) {
  const input = campaignDecisionSchema.parse(raw);
  return mutate(
    userId,
    bookId,
    input.operationId,
    { campaignId, planId, input },
    async (tx) => {
      await ownedCampaign(
        tx,
        userId,
        bookId,
        campaignId,
        input.expectedVersion,
      );
      const row = await tx.revisionCampaignPlan.findFirst({
        where: { id: planId, campaignId, bookId, userId },
      });
      if (!row)
        throw new DocumentError(
          "REVISION_CAMPAIGN_PLAN_NOT_FOUND",
          "Plan not found.",
          404,
        );
      const current = await tx.bookDocumentHead.findUniqueOrThrow({
        where: { bookId },
      });
      if (current.revisionId !== input.expectedRevisionId)
        throw new DocumentError(
          "REVISION_CAMPAIGN_STALE",
          "Manuscript changed before this decision.",
          412,
        );
      const analysis = (
        await tx.revisionCampaignRecord.findFirst({
          where: { planId, kind: "analysis" },
        })
      )?.payload as unknown as CampaignAnalysis | undefined;
      if (!analysis)
        throw new DocumentError(
          "REVISION_CAMPAIGN_NOT_READY",
          "Wait for the saved analysis.",
          409,
        );
      if (input.decision !== "resolve")
        await campaignPlanCurrent(tx, userId, bookId, planId);
      if (
        input.decision === "approve" &&
        !(await ownedCampaign(tx, userId, bookId, campaignId)).confirmed
      )
        throw new DocumentError(
          "REVISION_CAMPAIGN_RULES_REQUIRED",
          "Confirm protected facts and voice samples before approving a plan.",
          409,
        );
      const step = analysis.steps.find((x) => x.id === input.stepId);
      if (["skip", "resolve"].includes(input.decision) && !step)
        throw new DocumentError(
          "REVISION_CAMPAIGN_STEP_INVALID",
          "Choose an existing plan step.",
          422,
        );
      if (
        ["skip", "request-changes"].includes(input.decision) &&
        !input.reason.trim()
      )
        throw new DocumentError(
          "REVISION_CAMPAIGN_REASON_REQUIRED",
          "Record the reason for this decision.",
          422,
        );
      if (input.decision === "resolve") {
        const proposal = await tx.documentProposal.findFirst({
          where: { id: input.proposalId, bookId, userId, status: "applied" },
        });
        const discussion =
          proposal &&
          (await tx.documentDiscussion.findUnique({
            where: { id: proposal.discussionId },
          }));
        const context = (
          discussion?.snapshot as unknown as
            DocumentDiscussionSnapshot | undefined
        )?.revisionCampaign;
        if (
          !context ||
          context.planId !== planId ||
          context.stepId !== step!.id
        )
          throw new DocumentError(
            "REVISION_CAMPAIGN_PROPOSAL_INVALID",
            "Resolve the exact applied proposal for this step.",
            422,
          );
        const scene = await documentService.read(userId, bookId, step!.sceneId);
        if (scene.document.changes.some((x) => x.status === "pending"))
          throw new DocumentError(
            "REVISION_CAMPAIGN_PENDING_REVIEW",
            "Resolve the scene’s pending tracked edits before re-reviewing downstream effects.",
            409,
          );
      }
      if (input.decision === "finish") {
        if (!analysis.complete || analysis.gaps.length || analysis.steps.length)
          throw new DocumentError(
            "REVISION_CAMPAIGN_INCOMPLETE",
            "Required steps, coverage gaps or manual follow-up remain. Re-review and resolve them before completing.",
            409,
          );
        await tx.revisionCampaign.update({
          where: { id: campaignId },
          data: { status: "complete" },
        });
      }
      const kind =
        input.decision === "approve"
          ? "approval"
          : input.decision === "request-changes"
            ? "request-changes"
            : "decision";
      await tx.revisionCampaignRecord.create({
        data: {
          id: randomUUID(),
          campaignId,
          planId,
          userId,
          bookId,
          kind,
          requestHash: storyDigest(input),
          payload: campaignJson({ ...input, sceneId: step?.sceneId }),
        },
      });
      return {
        campaignId,
        planId,
        decision: input.decision,
        stepId: input.stepId,
        version: input.expectedVersion,
      };
    },
  );
}
export async function assertCampaignProposalCurrent(
  tx: CampaignClient,
  userId: number,
  bookId: number,
  context: CampaignProposalContext,
  allowedProposalId?: string,
) {
  const { plan, campaign } = await campaignPlanCurrent(
    tx,
    userId,
    bookId,
    context.planId,
  );
  if (
    plan.campaignId !== context.campaignId ||
    campaign.version !== context.campaignVersion ||
    !campaign.confirmed
  )
    throw new DocumentError(
      "REVISION_CAMPAIGN_STALE",
      "Campaign context changed.",
      412,
    );
  const approved = await tx.revisionCampaignRecord.count({
    where: { planId: plan.id, kind: "approval" },
  });
  const changed = await tx.revisionCampaignRecord.count({
    where: { planId: plan.id, kind: "request-changes" },
  });
  if (!approved || changed)
    throw new DocumentError(
      "REVISION_CAMPAIGN_APPROVAL_REQUIRED",
      "Approve the current plan before preparing edits.",
      409,
    );
  const decisions = await tx.revisionCampaignRecord.findMany({
    where: { campaignId: context.campaignId, kind: "decision" },
  });
  const campaignDiscussions = await tx.documentDiscussion.findMany({
    where: {
      bookId,
      userId,
      snapshot: {
        path: ["revisionCampaign", "campaignId"],
        equals: context.campaignId,
      },
    },
    select: { id: true },
  });
  const unresolved = await tx.documentProposal.findFirst({
    where: {
      bookId,
      userId,
      discussionId: { in: campaignDiscussions.map((x) => x.id) },
      status: { in: ["pending", "running", "unknown"] },
      ...(allowedProposalId ? { id: { not: allowedProposalId } } : {}),
    },
  });
  if (unresolved)
    throw new DocumentError(
      "REVISION_CAMPAIGN_RECOVERY_REQUIRED",
      "Recover the original proposal outcome before requesting another campaign edit.",
      409,
    );
  const applied = await tx.documentProposal.findMany({
    where: {
      bookId,
      userId,
      status: "applied",
      discussionId: { in: campaignDiscussions.map((x) => x.id) },
    },
    select: { id: true },
  });
  if (
    applied.some(
      (proposal) =>
        !decisions.some(
          (x) =>
            (x.payload as { proposalId?: string; decision?: string })
              .proposalId === proposal.id &&
            (x.payload as { decision?: string }).decision === "resolve",
        ),
    )
  )
    throw new DocumentError(
      "REVISION_CAMPAIGN_PENDING_REVIEW",
      "Resolve and record the previously applied step, then re-review downstream evidence.",
      409,
    );
  const values = decisions.map(
    (x) => x.payload as { stepId: string; decision: string; sceneId?: number },
  );
  if (
    values.some(
      (x) =>
        x.stepId === context.stepId && ["skip", "resolve"].includes(x.decision),
    )
  )
    throw new DocumentError(
      "REVISION_CAMPAIGN_STEP_BLOCKED",
      "This step was skipped or resolved. Refresh the plan.",
      409,
    );
  for (const prerequisite of context.step.prerequisites)
    if (
      !values.some((x) => x.stepId === prerequisite && x.decision === "resolve")
    )
      throw new DocumentError(
        "REVISION_CAMPAIGN_STEP_BLOCKED",
        "Resolve prerequisites and refresh downstream evidence first.",
        409,
      );
}
export async function campaignProposalContext(
  tx: CampaignClient,
  userId: number,
  bookId: number,
  planId: string,
  stepId: string,
  sceneId: number,
  targets: DocumentDiscussionSnapshot["targets"],
): Promise<CampaignProposalContext> {
  const { plan, campaign, snapshot } = await campaignPlanCurrent(
    tx,
    userId,
    bookId,
    planId,
  );
  const result = await tx.revisionCampaignRecord.findFirst({
    where: { planId, kind: "analysis" },
  });
  const analysis = result?.payload as unknown as CampaignAnalysis | undefined;
  const step = analysis?.steps.find((x) => x.id === stepId);
  if (!step || step.manual || !analysis?.complete || step.sceneId !== sceneId)
    throw new DocumentError(
      "REVISION_CAMPAIGN_STEP_INVALID",
      "A fully reviewed prose step is required.",
      422,
    );
  const citations = step.citations.filter((x) => x.sceneId === sceneId);
  if (
    targets.length !== citations.length ||
    targets.some(
      (x, i) =>
        x.blockId !== citations[i].blockId ||
        x.from !== citations[i].from ||
        x.to !== citations[i].to ||
        x.sourceText !== citations[i].quote ||
        !x.editable,
    )
  )
    throw new DocumentError(
      "REVISION_CAMPAIGN_TARGET_INVALID",
      "Use the exact editable cited targets.",
      422,
    );
  const context = {
    campaignId: campaign.id,
    campaignVersion: campaign.version,
    planId: plan.id,
    stepId,
    bookRevisionId: snapshot.bookRevisionId,
    goal: snapshot.goal,
    constraints: snapshot.constraints,
    step,
    downstream: analysis.steps.filter((x) => x.prerequisites.includes(stepId)),
  };
  await assertCampaignProposalCurrent(tx, userId, bookId, context);
  return context;
}
export async function assertCampaignVerification(
  tx: CampaignClient,
  userId: number,
  bookId: number,
  proposalId: string,
  snapshot: DocumentDiscussionSnapshot,
  output: DocumentProposalOutput,
  targetIds?: string[],
) {
  if (!snapshot.revisionCampaign) return;
  await assertCampaignProposalCurrent(
    tx,
    userId,
    bookId,
    snapshot.revisionCampaign,
  );
  const candidate = targetIds
    ? {
        ...output,
        edits: output.edits.filter((x) => targetIds.includes(x.targetId)),
      }
    : output;
  const records = await tx.revisionCampaignRecord.findMany({
    where: {
      bookId,
      userId,
      campaignId: snapshot.revisionCampaign.campaignId,
      kind: "verification",
    },
  });
  if (
    !records.some((row) => {
      const proof = row.payload as unknown as CampaignVerification;
      return (
        proof.proposalId === proposalId &&
        proof.candidateHash === storyDigest(candidate) &&
        proof.bookRevisionId === snapshot.sourceBookRevisionId &&
        proof.passed &&
        !proof.failures.length
      );
    })
  )
    throw new DocumentError(
      "REVISION_CAMPAIGN_VERIFICATION_REQUIRED",
      "Preview and verify this exact candidate before applying. Violations or inconclusive checks block application.",
      409,
    );
}
