import {
  campaignPrompt,
  campaignScanRules,
  resolveCampaignCitations,
  CAMPAIGN_RECIPE_VERSION,
} from "./campaignCitations";
import { randomUUID } from "node:crypto";
import type { WorkflowRun } from "@prisma/client";
import { databaseService } from "@/lib/database";
import { SceneProseService } from "@/services/sceneProseService";
import {
  assertWorkflowLease,
  currentWorkflowExecution,
} from "@/services/workflowExecutionContext";
import { verifyCandidate } from "@/services/editorial/editorialVerificationService";
import { textHash } from "@/services/editorial/textAnchors";
import { documentService } from "./service";
import { runWorkflowEffect } from "./workflowEffects";
import { storyDigest } from "./storyProposalSources";
import {
  campaignJson,
  campaignPlanCurrent,
  assertCampaignProposalCurrent,
} from "./campaigns";
import {
  campaignChunks,
  assertCampaignSource,
  verifyCampaignCitation,
  type CampaignSnapshot,
} from "./campaignSources";
import {
  campaignScanSchema,
  campaignSynthesisSchema,
  campaignVerificationSchema,
} from "./campaignValidation";
import type {
  CampaignEvidenceRecheck,
  CampaignAnalysis,
  CampaignCoverage,
  CampaignConstraints,
  CampaignStep,
  CampaignCitation,
  CampaignVerification,
} from "./campaign-model";
import type {
  DocumentDiscussionSnapshot,
  DocumentProposalOutput,
  DocumentProposalProviderResult,
} from "./proposal-model";
import { DocumentError } from "./errors";
import { proposalContextBudget } from "./proposalContext";
const db = () => databaseService.client;
function withinSource(citation: CampaignCitation, source: CampaignCitation) {
  return (
    citation.sceneId === source.sceneId &&
    citation.sceneRevisionId === source.sceneRevisionId &&
    citation.blockId === source.blockId &&
    citation.from >= source.from &&
    citation.to <= source.to
  );
}

export async function processCampaignAnalysis(run: WorkflowRun) {
  const settings = run.settings as {
    campaignId: string;
    planId: string;
    mode: string;
    proposalId?: string;
    targetIds?: string[];
  };
  const plan = await db().revisionCampaignPlan.findFirstOrThrow({
    where: {
      id: settings.planId,
      runId: run.id,
      bookId: run.bookId,
      userId: run.userId,
    },
  });
  const snapshot = plan.snapshot as unknown as CampaignSnapshot;
  await campaignPlanCurrent(db(), run.userId, run.bookId, plan.id);
  const prose = new SceneProseService();
  const maxPromptBytes = Math.min(
    64000,
    proposalContextBudget([]).maxPromptBytes - 6144,
  );
  const budget = Number(
    process.env.REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS ?? 2000000,
  );
  if (!Number.isSafeInteger(budget) || budget < 8192 || budget > 8000000)
    throw new DocumentError(
      "REVISION_CAMPAIGN_BUDGET_INVALID",
      "Campaign inference budget must be 8192–8000000 conservative tokens.",
      503,
    );
  let consumed = 0;
  const call = async (
    key: string,
    task: "scan" | "synthesize" | "verify",
    context: unknown,
  ): Promise<DocumentProposalProviderResult> => {
    const previousEffect = await db().documentWorkflowEffect.findFirst({
      where: { runId: run.id, effectKey: key },
    });
    const savedPrompt = (
      previousEffect?.request as { prompt?: unknown } | undefined
    )?.prompt;
    if (previousEffect?.status === "pending" && typeof savedPrompt !== "string")
      throw new DocumentError(
        "REVISION_CAMPAIGN_LEGACY_REQUEST_REQUIRES_REVIEW",
        "This undispatched request predates retained versioned prompts. Cancel its original workflow and explicitly refresh the plan; its original request remains retained.",
        409,
      );
    const prompt =
      typeof savedPrompt === "string"
        ? savedPrompt
        : campaignPrompt(task, context);
    const bytes = Buffer.byteLength(prompt);
    if (bytes > maxPromptBytes || consumed + bytes + 11192 > budget)
      throw new DocumentError(
        "REVISION_CAMPAIGN_BUDGET_LIMIT",
        "Complete context exceeds the disclosed bounded campaign budget; no text was silently omitted.",
        413,
      );
    consumed += bytes + 11192;
    return runWorkflowEffect(
      {
        userId: run.userId,
        bookId: run.bookId,
        runId: run.id,
        effectKey: key,
        expectedRevisionId: snapshot.bookRevisionId,
        timeoutMs: 120000,
        intent: { planId: plan.id, task, digest: storyDigest(context) },
      },
      async (tx) => {
        await campaignPlanCurrent(tx, run.userId, run.bookId, plan.id);
        return {
          task,
          context,
          maxPromptBytes,
          prompt,
          recipeVersion: CAMPAIGN_RECIPE_VERSION,
        };
      },
      (request, signal) =>
        prose.reviewCampaign(
          request.task,
          request.context,
          { signal },
          request.maxPromptBytes,
          { prompt: request.prompt, recipeVersion: request.recipeVersion },
        ),
    );
  };
  const record = async (kind: string, payload: unknown) =>
    documentService.sideRecord(run.userId, run.bookId, async (tx) => {
      await assertWorkflowLease(run.id);
      await campaignPlanCurrent(tx, run.userId, run.bookId, plan.id);
      const previous = await tx.revisionCampaignRecord.findFirst({
        where: { planId: plan.id, kind },
      });
      if (previous) {
        if (storyDigest(previous.payload) !== storyDigest(payload))
          throw new DocumentError(
            "REVISION_CAMPAIGN_RESULT_CONFLICT",
            "Retained analysis differs from original result.",
            409,
          );
        return;
      }
      await tx.revisionCampaignRecord.create({
        data: {
          id: randomUUID(),
          planId: plan.id,
          campaignId: plan.campaignId,
          userId: run.userId,
          bookId: run.bookId,
          kind,
          requestHash: storyDigest(payload),
          payload: campaignJson(payload),
        },
      });
    });
  const verifyCitations = async (citations: CampaignCitation[]) => {
    for (const citation of citations)
      await verifyCampaignCitation(db(), run.bookId, snapshot, citation);
  };
  if (settings.mode === "preview") {
    const proposal = await db().documentProposal.findFirstOrThrow({
      where: {
        id: settings.proposalId,
        bookId: run.bookId,
        userId: run.userId,
        status: "ready",
      },
    });
    const discussion = await db().documentDiscussion.findUniqueOrThrow({
      where: { id: proposal.discussionId },
    });
    const source = discussion.snapshot as unknown as DocumentDiscussionSnapshot;
    if (!source.revisionCampaign)
      throw new DocumentError(
        "REVISION_CAMPAIGN_PROPOSAL_INVALID",
        "Campaign-bound proposal required.",
        422,
      );
    await assertCampaignProposalCurrent(
      db(),
      run.userId,
      run.bookId,
      source.revisionCampaign,
    );
    const original = (
      proposal.result as unknown as { output: DocumentProposalOutput }
    ).output;
    if (
      settings.targetIds?.some(
        (id) => !original.edits.some((x) => x.targetId === id),
      )
    )
      throw new DocumentError(
        "REVISION_CAMPAIGN_TARGET_INVALID",
        "Preview selected an unknown target.",
        422,
      );
    const output = settings.targetIds
      ? {
          ...original,
          edits: original.edits.filter((x) =>
            settings.targetIds!.includes(x.targetId),
          ),
        }
      : original;
    const failures: string[] = [];
    if (!output.edits.length) failures.push("no_proposed_edits");
    for (const edit of output.edits) {
      const result = verifyCandidate({
        original: edit.sourceText,
        candidate: edit.replacement,
        expectedSourceHash: textHash(edit.sourceText),
        maxChangedPercent: 30,
        protectedElements: source.revisionCampaign.constraints.facts.map(
          (x) => x.text,
        ),
        allowNewNames: false,
      });
      failures.push(...result.failures);
      if (edit.sourceText === edit.replacement)
        failures.push("unchanged_candidate");
    }
    const provider = await call("preview", "verify", {
      campaign: source.revisionCampaign,
      proposed: output,
      targets: source.targets,
      sourceRevisionId: snapshot.bookRevisionId,
    });
    const result = campaignVerificationSchema.parse(
      resolveCampaignCitations(provider.raw, {
        campaign: source.revisionCampaign,
        proposed: output,
        targets: source.targets,
        sourceRevisionId: snapshot.bookRevisionId,
      }),
    );
    await verifyCitations(result.citations);
    const verification: CampaignVerification = {
      ...result,
      proposalId: proposal.id,
      targetIds: output.edits.map((edit) => edit.targetId),
      candidateHash: storyDigest(output),
      bookRevisionId: snapshot.bookRevisionId,
      passed: result.passed && !result.failures.length && !failures.length,
      failures: [...failures, ...result.failures],
      provider: provider.provenance,
    };
    await record("verification", verification);
  } else {
    const chunks = await campaignChunks(db(), run.bookId, snapshot);
    const priorDecisions = await db().revisionCampaignRecord.findMany({
      where: { campaignId: plan.campaignId, kind: "decision" },
    });
    const resolvedScenes = new Set(
      priorDecisions
        .map((x) => x.payload as { decision: string; sceneId?: number })
        .filter((x) => x.decision === "resolve")
        .map((x) => x.sceneId),
    );
    const coverage: CampaignCoverage[] = [];
    const suggestions: CampaignConstraints = { facts: [], voice: [] };
    const steps: CampaignStep[] = [],
      scannedGroups: Array<{
        summary: string;
        steps: CampaignStep[];
        gaps: string[];
      }> = [];
    const gaps: string[] = snapshot.threads.flatMap((thread) =>
      thread.evidence
        .filter(
          (evidence) =>
            !snapshot.scenes.some(
              (scene) => scene.sceneId === evidence.sceneId,
            ),
        )
        .map(
          (evidence) =>
            `Plot evidence ${evidence.id} points to an inactive or unavailable scene; select replacement evidence.`,
        ),
    );
    const rechecks: CampaignEvidenceRecheck[] = [];
    for (let index = 0; index < chunks.length; index++) {
      await assertWorkflowLease(run.id);
      const chunk = chunks[index];
      if (!chunk.citation) {
        coverage.push(chunk.coverage);
        if (chunk.coverage.reason) gaps.push(chunk.coverage.reason);
        continue;
      }
      try {
        const reviewTargets = [
          ...snapshot.threads.flatMap((thread) =>
            thread.evidence
              .filter((evidence) => evidence.sceneId === chunk.coverage.sceneId)
              .map((evidence) => ({
                target: evidence.id,
                kind: "plot-thread",
                question: thread.question,
                evidence,
              })),
          ),
          ...snapshot.boundaries
            .filter(
              (boundary) =>
                boundary.endingChapterId === chunk.coverage.chapterId ||
                boundary.openingChapterId === chunk.coverage.chapterId,
            )
            .map((boundary) => ({
              target: `boundary:${boundary.endingChapterId}:${boundary.openingChapterId}`,
              kind: "chapter-transition",
              boundary,
            })),
        ];
        const scanContext = {
          goal: snapshot.goal,
          preset: snapshot.preset,
          reviewTargets,
          authorDirections: snapshot.directions ?? [],
          constraints: campaignScanRules(snapshot.constraints),
          previouslyResolved: resolvedScenes.has(chunk.coverage.sceneId),
          boundaries: snapshot.boundaries.filter(
            (x) =>
              x.endingChapterId === chunk.coverage.chapterId ||
              x.openingChapterId === chunk.coverage.chapterId,
          ),
          canon: snapshot.canon.entries.filter(
            (entry) =>
              !entry.deletedAt &&
              (chunk.citation!.quote.includes(entry.entryName) ||
                snapshot.goal.includes(entry.entryName)),
          ),
          chapterId: chunk.coverage.chapterId,
          source: chunk.citation,
        };
        const result = await call(`scan:${index}`, "scan", scanContext);
        const output = campaignScanSchema.parse(
          resolveCampaignCitations(result.raw, scanContext),
        );
        if (
          reviewTargets.some(
            (target) =>
              !output.rechecks.some(
                (recheck) => recheck.target === target.target,
              ),
          ) ||
          output.rechecks.some(
            (recheck) =>
              !reviewTargets.some((target) => target.target === recheck.target),
          )
        )
          throw new DocumentError(
            "REVISION_CAMPAIGN_CITATION_INVALID",
            "Every disclosed plot link and chapter boundary needs an explicit re-review.",
            422,
          );
        for (const recheck of output.rechecks) {
          const target = reviewTargets.find(
            (x) => x.target === recheck.target,
          )!;
          if (
            "evidence" in target &&
            !recheck.citations.some(
              (c) =>
                c.sceneId === target.evidence.sceneId &&
                target.evidence.blockIds.includes(c.blockId),
            )
          )
            throw new DocumentError(
              "REVISION_CAMPAIGN_CITATION_INVALID",
              "Plot evidence re-review requires the original stable paragraph in the current source; choose replacement evidence if it was removed.",
              422,
            );
          if (
            "boundary" in target &&
            !recheck.citations.some((c) =>
              [target.boundary.ending, target.boundary.opening].some(
                (edge) => edge && withinSource(c, edge),
              ),
            )
          )
            throw new DocumentError(
              "REVISION_CAMPAIGN_CITATION_INVALID",
              "Chapter-boundary re-review requires a literal current ending or opening citation.",
              422,
            );
        }
        const citations = [
          ...output.suggestions.facts,
          ...output.suggestions.voice,
        ]
          .flatMap((x) => x.citations)
          .concat(output.rechecks.flatMap((x) => x.citations))
          .concat(
            output.steps.flatMap((x) => [
              ...x.citations,
              ...x.consequences.flatMap((c) => c.citations),
            ]),
          );
        const edges = scanContext.boundaries
          .flatMap((boundary) => [boundary.ending, boundary.opening])
          .filter((edge): edge is CampaignCitation => Boolean(edge));
        const source = chunk.citation;
        const disclosed = [source, ...edges];
        for (const citation of citations) {
          if (!disclosed.some((range) => withinSource(citation, range)))
            throw new DocumentError(
              "REVISION_CAMPAIGN_CITATION_INVALID",
              "Scan cited text outside its disclosed source range.",
              422,
            );
        }
        await verifyCitations(citations);
        const boundarySteps: CampaignStep[] = [];
        const localSteps = output.steps.filter((step, i) => {
          const local =
            step.sceneId === chunk.coverage.sceneId &&
            step.chapterId === chunk.coverage.chapterId;
          const targetCitations = step.citations.filter(
            (citation) => citation.sceneId === step.sceneId,
          );
          // In-flight legacy plans must reconstruct their original synthesis inputs.
          if (
            local &&
            targetCitations.length &&
            (!snapshot.scanScope ||
              targetCitations.every((citation) =>
                withinSource(citation, source),
              ))
          ) {
            step.id = `${plan.id}:${index}:${i}`;
            step.prerequisites = [];
            return true;
          }
          if (
            snapshot.scanScope &&
            step.chapterId !== chunk.coverage.chapterId &&
            snapshot.scenes.some(
              (scene) =>
                scene.sceneId === step.sceneId &&
                scene.chapterId === step.chapterId,
            ) &&
            targetCitations.length &&
            targetCitations.every((citation) =>
              edges.some((edge) => withinSource(citation, edge)),
            )
          ) {
            // The adjacent scene has its own scan. Retain this suggestion for audit.
            boundarySteps.push(step);
            return false;
          }
          throw new DocumentError(
            "REVISION_CAMPAIGN_STEP_INVALID",
            "Scan proposed an undisclosed scene target.",
            422,
          );
        });
        coverage.push(chunk.coverage);
        rechecks.push(...output.rechecks);
        gaps.push(
          ...output.rechecks
            .filter((x) => ["missing", "inconclusive"].includes(x.assessment))
            .map((x) => x.explanation),
        );
        suggestions.facts.push(...output.suggestions.facts);
        suggestions.voice.push(...output.suggestions.voice);
        steps.push(...localSteps);
        scannedGroups.push({
          summary: output.summary,
          steps: localSteps,
          gaps: output.gaps,
        });
        gaps.push(...output.gaps);
        await record(`scan:${index}`, {
          coverage: chunk.coverage,
          ...output,
          steps: localSteps,
          ...(boundarySteps.length ? { boundarySteps } : {}),
        });
      } catch (error) {
        if (
          !(error instanceof DocumentError) ||
          ![
            "REVISION_CAMPAIGN_BUDGET_LIMIT",
            "REVISION_CAMPAIGN_CITATION_INVALID",
            "REVISION_CAMPAIGN_STEP_INVALID",
          ].includes(error.code)
        )
          throw error;
        coverage.push({
          ...chunk.coverage,
          status:
            error.code === "REVISION_CAMPAIGN_BUDGET_LIMIT"
              ? "budget-limited"
              : "failed",
          reason: error.message,
        });
        gaps.push(
          `Scene ${chunk.coverage.sceneId}, ${chunk.coverage.from}–${chunk.coverage.to}: ${error.message}`,
        );
      }
      await db().workflowRun.updateMany({
        where: {
          id: run.id,
          leaseOwner: currentWorkflowExecution()!.leaseOwner,
        },
        data: {
          progress: campaignJson({
            completed: index + 1,
            total: chunks.length,
            percent: Math.floor(((index + 1) / chunks.length) * 90),
          }),
        },
      });
    }
    // Reduction is hierarchical: every source group contributes, with immutable
    // intermediate results. Oversized reductions become explicit coverage gaps.
    let groups = scannedGroups;
    let level = 0;
    try {
      if (!groups.length)
        groups = [
          {
            summary: "No actionable prose steps were supported.",
            steps: [],
            gaps: [],
          },
        ];
      do {
        const next: typeof groups = [];
        for (let index = 0; index < groups.length;) {
          const batch: typeof groups = [];
          while (
            index < groups.length &&
            Buffer.byteLength(JSON.stringify([...batch, groups[index]])) <
              Math.max(2000, maxPromptBytes - 9000)
          )
            batch.push(groups[index++]);
          if (!batch.length)
            throw new DocumentError(
              "REVISION_CAMPAIGN_BUDGET_LIMIT",
              "An unabridged plan step exceeds the synthesis budget.",
              413,
            );
          const context = {
            goal: snapshot.goal,
            preset: snapshot.preset,
            authorDirections: snapshot.directions ?? [],
            constraints: snapshot.constraints,
            groups: batch,
            boundaries: snapshot.boundaries.filter((x) =>
              batch
                .flatMap((group) => group.steps)
                .some(
                  (step) =>
                    step.chapterId === x.endingChapterId ||
                    step.chapterId === x.openingChapterId,
                ),
            ),
            priorCoverage: coverage.map((x) => ({
              sceneId: x.sceneId,
              status: x.status,
            })),
            plotEvidence:
              Buffer.byteLength(JSON.stringify(snapshot.threads)) < 6000
                ? snapshot.threads
                : [],
          };
          if (
            !context.plotEvidence.length &&
            snapshot.threads.length &&
            snapshot.threads.length > 0
          )
            gaps.push(
              "Plot Thread evidence exceeds this reduction context; thread-wide consequences require follow-up.",
            );
          const result = await call(
            `synthesis:${level}:${next.length}`,
            "synthesize",
            context,
          );
          const output = campaignSynthesisSchema.parse(
            resolveCampaignCitations(result.raw, context),
          );
          const supplied = batch.flatMap((x) => x.steps);
          const incomingIds = new Set(supplied.map((x) => x.id));
          if (
            output.steps.length !== supplied.length ||
            new Set(output.steps.map((x) => x.id)).size !== supplied.length ||
            output.steps.some((x) => !incomingIds.has(x.id))
          )
            throw new DocumentError(
              "REVISION_CAMPAIGN_CITATION_INVALID",
              "Synthesis must retain every supported step exactly once.",
              422,
            );
          for (const step of output.steps) {
            const original = supplied.find((x) => x.id === step.id)!;
            if (
              step.sceneId !== original.sceneId ||
              step.chapterId !== original.chapterId ||
              storyDigest(step.citations) !== storyDigest(original.citations) ||
              step.manual !== original.manual
            )
              throw new DocumentError(
                "REVISION_CAMPAIGN_CITATION_INVALID",
                "Synthesis changed a frozen target.",
                422,
              );
            await verifyCitations(
              step.consequences.flatMap((x) => x.citations),
            );
          }
          await record(`synthesis:${level}:${next.length}`, output);
          next.push(output);
        }
        if (next.length >= groups.length && groups.length > 1)
          throw new DocumentError(
            "REVISION_CAMPAIGN_BUDGET_LIMIT",
            "The complete step graph exceeds supported reduction capacity.",
            413,
          );
        groups = next;
        level++;
      } while (groups.length > 1);
    } catch (error) {
      if (
        !(error instanceof DocumentError) ||
        ![
          "REVISION_CAMPAIGN_BUDGET_LIMIT",
          "REVISION_CAMPAIGN_CITATION_INVALID",
        ].includes(error.code)
      )
        throw error;
      gaps.push(error.message);
      groups = [
        {
          summary:
            "Partial campaign: inspect coverage gaps before requesting edits.",
          steps,
          gaps: [],
        },
      ];
    }
    const final = groups[0];
    const visited = new Set<string>();
    for (const step of final.steps) {
      if (step.prerequisites.some((x) => !visited.has(x)))
        gaps.push(
          `Step ${step.id} has an unresolved, cyclic or out-of-order prerequisite.`,
        );
      visited.add(step.id);
    }
    for (const kind of ["facts", "voice"] as const) {
      const merged = new Map<string, CampaignConstraints["facts"][number]>();
      for (const rule of suggestions[kind]) {
        const key = rule.text.trim().replace(/\s+/g, " ").toLowerCase();
        const prior = merged.get(key);
        if (!prior)
          merged.set(key, { ...rule, citations: [...rule.citations] });
        else
          prior.citations = [
            ...prior.citations,
            ...rule.citations.filter(
              (citation) =>
                !prior.citations.some(
                  (saved) => storyDigest(saved) === storyDigest(citation),
                ),
            ),
          ].slice(0, 5);
      }
      suggestions[kind] = [...merged.values()];
    }
    if (suggestions.facts.length > 40 || suggestions.voice.length > 10) {
      suggestions.facts = suggestions.facts.slice(0, 40);
      suggestions.voice = suggestions.voice.slice(0, 10);
    }
    gaps.push(...final.gaps);
    const analysis: CampaignAnalysis = {
      rechecks,
      summary: final.summary,
      steps: final.steps,
      suggestions,
      coverage,
      gaps: [...new Set(gaps)],
      complete:
        !gaps.length &&
        coverage.every((x) => ["reviewed", "empty"].includes(x.status)),
    };
    await record("analysis", analysis);
  }
  await documentService.sideRecord(run.userId, run.bookId, async (tx) => {
    await assertWorkflowLease(run.id);
    await assertCampaignSource(tx, run.bookId, snapshot);
    const owner = currentWorkflowExecution()!.leaseOwner;
    await tx.workflowTask.updateMany({
      where: { runId: run.id, leaseOwner: owner },
      data: { status: "completed", finishedAt: new Date() },
    });
    await tx.workflowRun.updateMany({
      where: { id: run.id, leaseOwner: owner },
      data: {
        status: "completed",
        phase: "completed",
        progress: { percent: 100, completed: 1, total: 1 },
        finishedAt: new Date(),
      },
    });
    await tx.workflowEvent.create({
      data: {
        runId: run.id,
        eventType: "completed",
        data: { campaignId: plan.campaignId, planId: plan.id },
      },
    });
  });
}
