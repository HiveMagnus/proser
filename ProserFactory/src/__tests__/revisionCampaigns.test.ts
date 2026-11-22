import { currentWorkflowExecution } from "@/services/workflowExecutionContext";
import { randomUUID } from "node:crypto";
import { databaseService } from "@/lib/database";
import { documentService } from "@/documents/service";
import {
  paragraphsOf,
  resolveChange,
  projectDocument,
} from "@/documents/model";
import {
  saveCampaign,
  readCampaign,
  launchCampaignAnalysis,
  campaignDecision,
  campaignReceipt,
} from "@/documents/campaigns";
import {
  campaignChunks,
  captureCampaignSource,
} from "@/documents/campaignSources";
import {
  createDocumentDiscussion,
  requestDocumentProposal,
  readDocumentProposal,
  revalidateDocumentProposal,
  applyDocumentProposal,
} from "@/documents/proposals";
import { SceneProseService } from "@/services/sceneProseService";
import { workflowService } from "@/services/workflowService";
import { savePlotThread, addPlotThreadEvidence } from "@/documents/plotThreads";
import type {
  CampaignCitation,
  CampaignStep,
  CampaignConstraints,
  CampaignDetail,
} from "@/documents/campaign-model";
import type {
  DocumentProposalProviderResult,
  DocumentProposalOutput,
} from "@/documents/proposal-model";
const db = () => databaseService.client;
const provenance = {
  providerId: "isolated-seeded-fixture",
  params: {},
  recipe: "revision-campaign",
  recipeVersion: "1.0.0",
};
const texts = [
  "The key was brass. Mara waited by the gate and counted the guards as the rain fell around her. Beyond the bars, the antagonist watched the narrow street. He knew she would return for her brother, but he said nothing about the debt. The red seal lay beside his hand, untouched. She kept her voice low and her eyes on the key.",
  "The key was brass. Mara waited by the prison door and listened to the guards changing shifts. The antagonist held the red seal in his open hand. He wanted her to see it, wanted her to understand that the debt had followed her here. She did not look away. She remembered the promise she had made to her brother and kept her voice low.",
  "The key was brass. Mara waited by the vault while the antagonist confessed that the debt had bought her silence. She had followed the red seal from the gate to the prison and now to this room. Her brother stood behind her. She kept her voice low and asked for the ledger, and the antagonist finally placed it on the table.",
];
interface ScanContext {
  reviewTargets?: Array<{
    target: string;
    boundary?: { ending?: CampaignCitation; opening?: CampaignCitation };
  }>;
  boundaries?: Array<{
    openingChapterId: number;
    ending?: CampaignCitation;
    opening?: CampaignCitation;
  }>;
  source: CampaignCitation;
  chapterId: number;
  previouslyResolved?: boolean;
}
interface SynthesisContext {
  groups: Array<{ steps: CampaignStep[] }>;
}
function seeded(
  task: "scan" | "synthesize" | "verify",
  raw: unknown,
): DocumentProposalProviderResult {
  if (task === "scan") {
    const context = raw as ScanContext,
      citation = context.source;
    const rule = {
      text: "The key is brass; preserve the close viewpoint and restrained voice.",
      citations: [citation],
    };
    const neighbor = context.previouslyResolved
      ? context.boundaries?.find(
          (edge) => edge.ending?.sceneId === citation.sceneId && edge.opening,
        )
      : undefined;
    return {
      raw: JSON.stringify({
        rechecks: (context.reviewTargets ?? []).map((x) => ({
          target: x.target,
          assessment: "holds",
          explanation:
            "The actual current passage preserves the linked causal evidence and neighboring boundary.",
          citations: [x.boundary?.ending ?? x.boundary?.opening ?? citation],
        })),
        summary:
          "The threat can become more deliberate while preserving the key and viewpoint.",
        suggestions: { facts: [rule], voice: [rule] },
        steps: context.previouslyResolved
          ? neighbor
            ? [
                {
                  id: "adjacent",
                  sceneId: neighbor.opening!.sceneId,
                  chapterId: neighbor.openingChapterId,
                  title: "Edit the next chapter",
                  instruction:
                    "This step belongs to the independent neighboring scan.",
                  citations: [neighbor.opening!],
                  prerequisites: [],
                  consequences: [],
                  questions: [],
                  manual: false,
                },
              ]
            : []
          : [
              {
                id: "local",
                sceneId: citation.sceneId,
                chapterId: context.chapterId,
                title: "Make the pressure deliberate",
                instruction:
                  "Add a restrained indication that the antagonist is watching the exits.",
                citations: [citation],
                prerequisites: [],
                consequences: [
                  {
                    prediction:
                      "The later confession should retain its causal link to the red seal.",
                    citations: [citation],
                  },
                ],
                questions: [],
                manual: false,
              },
            ],
        gaps: [],
      }),
      provenance,
    };
  }
  if (task === "synthesize") {
    const steps = (raw as SynthesisContext).groups.flatMap((x) => x.steps);
    return {
      raw: JSON.stringify({
        summary:
          "Strengthen the antagonist across setup, escalation and payoff; the adjacent chapter boundaries retain the same causal order.",
        steps: steps.map((x, i) => ({
          ...x,
          prerequisites: i ? [steps[i - 1].id] : [],
          consequences: [
            {
              prediction:
                "Recheck the later evidence and neighboring chapter boundary after this edit.",
              citations: steps.map((y) => y.citations[0]).slice(0, 5),
            },
          ],
        })),
        gaps: [],
      }),
      provenance,
    };
  }
  const context = raw as { campaign: { step: CampaignStep } };
  return {
    raw: JSON.stringify({
      passed: true,
      facts:
        "The brass key and red seal remain unchanged in the actual proposed text.",
      voice:
        "Close viewpoint, restrained diction and sentence cadence remain intact.",
      consequences:
        "The increased pressure prepares the later confession; recheck the linked evidence after approval.",
      citations: context.campaign.step.citations,
      failures: [],
    }),
    provenance,
  };
}
describe("revision campaigns", () => {
  let userId: number, bookId: number, scenes: number[], campaignId: string;
  const priorAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
  beforeEach(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
    userId = (
      await db().user.create({
        data: {
          githubId: `campaign-fixture-${randomUUID()}`,
          username: "Campaign author",
        },
      })
    ).id;
    const book = await db().book.create({
      data: {
        userId,
        title: "Synthetic three-chapter antagonist campaign",
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: texts.map((prose, i) => ({
                chapterNumber: i + 1,
                scenes: { create: { sceneNumber: 1, prose } },
              })),
            },
          },
        },
      },
    });
    bookId = book.id;
    await documentService.initialize(userId, bookId);
    scenes = (await documentService.manifest(userId, bookId)).scenes.map(
      (x) => x.sceneId,
    );
    const receipt = await saveCampaign(userId, bookId, undefined, {
      operationId: randomUUID(),
      expectedVersion: 0,
      goal: "Strengthen the antagonist across setup, escalation and payoff",
      preset: "antagonist",
    });
    campaignId = String(receipt.campaignId);
    jest
      .spyOn(SceneProseService.prototype, "reviewCampaign")
      .mockImplementation(async (task, context) => seeded(task, context));
    jest
      .spyOn(SceneProseService.prototype, "proposeDocumentEdits")
      .mockImplementation(async (snapshot) => ({
        raw: JSON.stringify({
          reply: "Make the waiting deliberate.",
          edits: [
            {
              targetId: snapshot.targets[0].targetId,
              sourceText: snapshot.targets[0].sourceText,
              replacement: snapshot.targets[0].sourceText.replace(
                "waited by",
                "waited, counting exits, by",
              ),
            },
          ],
        }),
        provenance,
      }));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const manifest = await documentService.manifest(userId, bookId);
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: manifest.revisionId,
        expectedScopes: { structure: manifest.scopes!.structure.revisionId },
        payload: { fixture: "retire-revision-campaign" },
      },
      async (tx) => ({
        result: await tx.book.update({
          where: { id: bookId },
          data: { deletedAt: new Date() },
        }),
      }),
    );
  });
  afterAll(() => {
    if (priorAuthority === undefined)
      delete process.env.DOCUMENT_AUTHORITY_ENABLED;
    else process.env.DOCUMENT_AUTHORITY_ENABLED = priorAuthority;
  });
  const detail = () => readCampaign(userId, bookId, campaignId);
  const analyze = async (mode = "plan", proposalId?: string) => {
    const campaign = (await detail()).campaign,
      source = await documentService.manifest(userId, bookId);
    const receipt = await launchCampaignAnalysis(userId, bookId, campaignId, {
      operationId: randomUUID(),
      expectedVersion: campaign.version,
      expectedRevisionId: source.revisionId,
      mode,
      ...(proposalId ? { proposalId } : {}),
    });
    await workflowService.process(
      String((receipt as Record<string, unknown>).runId),
    );
    return (await detail()).plans.find((x) => x.id === receipt.planId)!;
  };
  const decision = async (
    planId: string,
    decision: string,
    extra: Record<string, unknown> = {},
  ) =>
    campaignDecision(userId, bookId, campaignId, planId, {
      operationId: randomUUID(),
      expectedVersion: (await detail()).campaign.version,
      expectedRevisionId: (await documentService.manifest(userId, bookId))
        .revisionId,
      decision,
      ...extra,
    });
  const confirm = async (value: CampaignDetail) =>
    saveCampaign(userId, bookId, campaignId, {
      operationId: randomUUID(),
      expectedVersion: value.campaign.version,
      goal: value.campaign.goal,
      preset: value.campaign.preset,
      constraints: value.plans.find((x) => x.analysis)!.analysis!.suggestions,
      confirmed: true,
    });
  const prepare = async (planId: string, step: CampaignStep) => {
    const source = await documentService.read(userId, bookId, step.sceneId);
    return createDocumentDiscussion(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      sessionId: randomUUID(),
      sceneId: step.sceneId,
      expectedRevisionId: source.bookRevisionId,
      expectedSceneRevisionId: source.revisionId,
      expectedContentHash: source.contentHash,
      projection: "final",
      revisionCampaignPlanId: planId,
      revisionCampaignStepId: step.id,
      targets: step.citations.map((c) => ({
        blockId: c.blockId,
        from: c.from,
        to: c.to,
        sourceText: c.quote,
      })),
    });
  };
  test("completes explicitly approved edits across three chapters and re-reviews downstream evidence", async () => {
    const threadReceipt = await savePlotThread(userId, bookId, undefined, {
      operationId: randomUUID(),
      expectedVersion: 0,
      question: "Will Mara recover the ledger?",
    });
    for (let i = 0; i < 3; i++) {
      const source = await documentService.read(userId, bookId, scenes[i]),
        paragraph = paragraphsOf(source.document)[0];
      await addPlotThreadEvidence(
        userId,
        bookId,
        Number((threadReceipt as { threadId: number }).threadId),
        {
          operationId: randomUUID(),
          expectedVersion: i + 1,
          stage: ["setup", "escalation", "payoff"][i],
          sceneId: scenes[i],
          expectedRevisionId: source.bookRevisionId,
          expectedSceneRevisionId: source.revisionId,
          expectedContentHash: source.contentHash,
          targets: [
            {
              blockId: paragraph.id,
              from: 0,
              to: texts[i].length,
              sourceText: texts[i],
            },
          ],
        },
      );
    }
    const initial = await documentService.manifest(userId, bookId);
    await analyze();
    await confirm(await detail());
    const receipts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const plan = await analyze(i ? "recheck" : "plan");
      expect(plan.analysis!.complete).toBe(true);
      expect(plan.analysis!.coverage).toHaveLength(3);
      await decision(plan.id, "approve");
      const step = plan.analysis!.steps[0];
      expect(step.sceneId).toBe(scenes[i]);
      expect(step.consequences[0].citations.length).toBeGreaterThanOrEqual(1);
      const discussion = await prepare(plan.id, step);
      const proposal = await requestDocumentProposal(
        userId,
        bookId,
        discussion.id,
        { operationId: randomUUID(), instruction: step.instruction },
      );
      expect(proposal.status).toBe("ready");
      const source = await documentService.read(userId, bookId, step.sceneId);
      const validationInput = {
        operationId: randomUUID(),
        expectedRevisionId: source.bookRevisionId,
        expectedSceneRevisionId: source.revisionId,
      };
      const validation = await revalidateDocumentProposal(
        userId,
        bookId,
        proposal.id,
        validationInput,
      );
      const applyInput = {
        ...validationInput,
        operationId: randomUUID(),
        validationId: validation.id,
        targetIds: (
          proposal.result as unknown as { output: DocumentProposalOutput }
        ).output.edits.map((x) => x.targetId),
      };
      await expect(
        applyDocumentProposal(userId, bookId, proposal.id, applyInput),
      ).rejects.toMatchObject({
        code: "REVISION_CAMPAIGN_VERIFICATION_REQUIRED",
      });
      await analyze("preview", proposal.id);
      const proof = (await detail()).verifications.find(
        (x) => x.proposalId === proposal.id,
      )!;
      expect(proof.failures).toEqual([]);
      expect(proof.passed).toBe(true);
      const receipt = await applyDocumentProposal(
        userId,
        bookId,
        proposal.id,
        applyInput,
      );
      receipts.push(receipt.operationId);
      expect(
        await applyDocumentProposal(userId, bookId, proposal.id, applyInput),
      ).toEqual(receipt);
      await expect(
        decision(plan.id, "resolve", {
          stepId: step.id,
          proposalId: proposal.id,
        }),
      ).rejects.toMatchObject({ code: "REVISION_CAMPAIGN_PENDING_REVIEW" });
      const changed = await documentService.read(userId, bookId, step.sceneId);
      let resolved = changed.document;
      for (const change of changed.document.changes.filter(
        (x) => x.status === "pending",
      ))
        resolved = resolveChange(resolved, change.id, "accepted");
      await documentService.commit(userId, bookId, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: changed.bookRevisionId,
        scenes: [
          {
            sceneId: step.sceneId,
            expectedRevisionId: changed.revisionId,
            document: resolved,
          },
        ],
      });
      await decision(plan.id, "resolve", {
        stepId: step.id,
        proposalId: proposal.id,
      });
      expect((await detail()).plans.find((x) => x.id === plan.id)!.stale).toBe(
        true,
      );
      expect(
        projectDocument(
          (await documentService.read(userId, bookId, step.sceneId)).document,
        ).text,
      ).toContain("The key was brass.");
    }
    const final = await analyze("recheck");
    expect(final.analysis!.steps).toHaveLength(0);
    expect(final.analysis!.gaps).toEqual([]);
    expect(
      await db().revisionCampaignRecord.findFirst({
        where: { planId: final.id, kind: "scan:0" },
      }),
    ).toMatchObject({
      payload: {
        steps: [],
        boundarySteps: [{ sceneId: scenes[1], title: "Edit the next chapter" }],
      },
    });
    await decision(final.id, "finish");
    expect((await detail()).complete).toBe(true);
    expect(new Set(receipts).size).toBe(3);
    expect(
      (await documentService.manifest(userId, bookId)).revisionId,
    ).not.toBe(initial.revisionId);
    expect(
      await db().documentWorkflowEffect.count({
        where: { bookId, status: "unknown" },
      }),
    ).toBe(0);
  });
  test("an unrelated scene identifier cannot use a disclosed edge as an edit target", async () => {
    jest
      .mocked(SceneProseService.prototype.reviewCampaign)
      .mockImplementationOnce(async (task, context) => {
        const original = seeded(task, context);
        const scan = context as ScanContext;
        const edge = scan.boundaries?.find((boundary) => boundary.opening);
        if (!edge?.opening) throw new Error("Expected a neighboring opening");
        const output = JSON.parse(original.raw) as { steps: CampaignStep[] };
        output.steps[0] = {
          ...output.steps[0],
          chapterId: edge.openingChapterId,
          sceneId: scenes[2],
          citations: [edge.opening],
        };
        return { ...original, raw: JSON.stringify(output) };
      });
    const plan = await analyze();
    expect(plan.analysis!.complete).toBe(false);
    expect(plan.analysis!.coverage[0]).toMatchObject({
      sceneId: scenes[0],
      status: "failed",
      reason: "Scan proposed an undisclosed scene target.",
    });
  });
  test("retains exact receipts, rejects conflicting operation IDs and isolates ownership", async () => {
    const operationId = randomUUID(),
      input = {
        operationId,
        expectedVersion: 1,
        goal: "Develop the theme of loyalty",
        preset: "theme",
      };
    const receipt = await saveCampaign(userId, bookId, campaignId, input);
    expect(await saveCampaign(userId, bookId, campaignId, input)).toEqual(
      receipt,
    );
    expect(await campaignReceipt(userId, bookId, operationId)).toEqual(receipt);
    await expect(
      saveCampaign(userId, bookId, campaignId, {
        ...input,
        goal: "Different goal",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_OPERATION_CONFLICT" });
    await expect(
      readCampaign(userId + 99999, bookId, campaignId),
    ).rejects.toMatchObject({ status: 404 });
  });
  test("blocks stale rules, fabricated citations, unapproved steps and skipped dependencies", async () => {
    const first = await analyze();
    await expect(
      prepare(first.id, first.analysis!.steps[0]),
    ).rejects.toMatchObject({ code: "REVISION_CAMPAIGN_STALE" });
    const rules = structuredClone(first.analysis!.suggestions);
    rules.facts[0].citations[0].quote = "fabricated";
    await expect(
      saveCampaign(userId, bookId, campaignId, {
        operationId: randomUUID(),
        expectedVersion: 1,
        goal: "Strengthen antagonist",
        preset: "antagonist",
        constraints: rules,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TARGET_STALE" });
    await confirm(await detail());
    const current = await analyze();
    await decision(current.id, "approve");
    await decision(current.id, "skip", {
      stepId: current.analysis!.steps[0].id,
      reason: "Keep this setup as written.",
    });
    await expect(
      prepare(current.id, current.analysis!.steps[1]),
    ).rejects.toMatchObject({ code: "REVISION_CAMPAIGN_STEP_BLOCKED" });
    await expect(decision(current.id, "finish")).rejects.toMatchObject({
      code: "REVISION_CAMPAIGN_INCOMPLETE",
    });
  });
  test("concurrent campaign edits serialize and invalidate existing plans", async () => {
    await analyze();
    const results = await Promise.allSettled(
      ["First goal", "Second goal"].map((goal) =>
        saveCampaign(userId, bookId, campaignId, {
          operationId: randomUUID(),
          expectedVersion: 1,
          goal,
          preset: "theme",
        }),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await detail()).plans[0].stale).toBe(true);
  });
  test("bounded scanning covers all Unicode ranges without dropped or split text", async () => {
    const source = await captureCampaignSource(
      db(),
      bookId,
      "Test",
      { facts: [], voice: [] } as CampaignConstraints,
      false,
    );
    const chunks = await campaignChunks(db(), bookId, source, 37);
    for (const sceneId of scenes) {
      const selected = chunks.filter((x) => x.coverage.sceneId === sceneId);
      expect(selected.map((x) => x.citation?.quote ?? "").join("")).toBe(
        texts[scenes.indexOf(sceneId)],
      );
      expect(selected[0].coverage.from).toBe(0);
      selected
        .slice(1)
        .forEach((x, i) =>
          expect(x.coverage.from).toBe(selected[i].coverage.to),
        );
    }
  });
  test("unknown provider outcomes block another analysis even after cancellation", async () => {
    jest
      .mocked(SceneProseService.prototype.reviewCampaign)
      .mockRejectedValueOnce(new Error("Connection lost after dispatch"));
    const campaign = (await detail()).campaign,
      source = await documentService.manifest(userId, bookId);
    const input = {
      operationId: randomUUID(),
      expectedVersion: campaign.version,
      expectedRevisionId: source.revisionId,
    };
    const receipt = await launchCampaignAnalysis(
      userId,
      bookId,
      campaignId,
      input,
    );
    await expect(
      workflowService.process(
        String((receipt as Record<string, unknown>).runId),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNKNOWN" });
    expect(
      await launchCampaignAnalysis(userId, bookId, campaignId, input),
    ).toEqual(receipt);
    await workflowService.control(
      userId,
      String((receipt as Record<string, unknown>).runId),
      "cancel",
    );
    await expect(
      launchCampaignAnalysis(userId, bookId, campaignId, {
        ...input,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CAMPAIGN_RECOVERY_REQUIRED" });
    expect(SceneProseService.prototype.reviewCampaign).toHaveBeenCalledTimes(1);
  });
  test("retained provider bytes resume without another dispatch after interrupted record publication", async () => {
    const source = await documentService.manifest(userId, bookId);
    const receipt = await launchCampaignAnalysis(userId, bookId, campaignId, {
      operationId: randomUUID(),
      expectedVersion: 1,
      expectedRevisionId: source.revisionId,
    });
    jest
      .mocked(SceneProseService.prototype.reviewCampaign)
      .mockImplementationOnce(async (task, context) => {
        const result = seeded(task, context);
        await db().workflowRun.update({
          where: { id: currentWorkflowExecution()!.runId },
          data: { status: "paused" },
        });
        return result;
      });
    await workflowService.process(
      String((receipt as Record<string, unknown>).runId),
    );
    expect(SceneProseService.prototype.reviewCampaign).toHaveBeenCalledTimes(1);
    expect(
      await db().documentWorkflowEffect.count({
        where: {
          runId: String((receipt as Record<string, unknown>).runId),
          status: "completed",
        },
      }),
    ).toBe(1);
    await db().documentWorkflowEffect.updateMany({
      where: {
        runId: String((receipt as Record<string, unknown>).runId),
        status: "completed",
      },
      data: { status: "unknown" },
    });
    await workflowService.control(
      userId,
      String((receipt as Record<string, unknown>).runId),
      "resume",
    );
    await workflowService.process(
      String((receipt as Record<string, unknown>).runId),
    );
    expect(
      jest
        .mocked(SceneProseService.prototype.reviewCampaign)
        .mock.calls.filter(
          ([task, context]) =>
            task === "scan" &&
            (context as ScanContext).source.sceneId === scenes[0],
        ),
    ).toHaveLength(1);
    expect(
      (await detail()).plans.find((x) => x.id === receipt.planId)!.analysis!
        .complete,
    ).toBe(true);
  });
  test("budget exhaustion leaves explicit missing coverage and cannot complete", async () => {
    const original = process.env.REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS;
    process.env.REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS = "8192";
    try {
      const plan = await analyze();
      expect(plan.analysis!.complete).toBe(false);
      expect(
        plan.analysis!.coverage.every((x) => x.status === "budget-limited"),
      ).toBe(true);
      expect(plan.analysis!.gaps.length).toBeGreaterThan(0);
      await expect(decision(plan.id, "finish")).rejects.toMatchObject({
        code: "REVISION_CAMPAIGN_INCOMPLETE",
      });
      expect(SceneProseService.prototype.reviewCampaign).not.toHaveBeenCalled();
    } finally {
      if (original === undefined)
        delete process.env.REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS;
      else process.env.REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS = original;
    }
  });
  test("unrelated scene edits invalidate the whole plan while retaining its exact quotations", async () => {
    const plan = await analyze();
    await confirm(await detail());
    const approved = await analyze();
    await decision(approved.id, "approve");
    const source = await documentService.read(userId, bookId, scenes[2]);
    const changed = structuredClone(source.document);
    paragraphsOf(changed)[0].runs[0].text += " Rain gathered at the door.";
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      scenes: [
        {
          sceneId: scenes[2],
          expectedRevisionId: source.revisionId,
          document: changed,
        },
      ],
    });
    await expect(
      prepare(approved.id, approved.analysis!.steps[0]),
    ).rejects.toMatchObject({ code: "REVISION_CAMPAIGN_STALE" });
    const historical = await readCampaign(userId, bookId, campaignId, plan.id);
    expect(historical.plans[0].analysis!.steps[0].citations[0].quote).toBe(
      texts[0],
    );
    expect(historical.plans[0].stale).toBe(true);
  });
  test("plot evidence changes invalidate plans without a manuscript head change", async () => {
    const plan = await analyze();
    const source = await documentService.manifest(userId, bookId);
    await savePlotThread(userId, bookId, undefined, {
      operationId: randomUUID(),
      expectedVersion: 0,
      question: "A competing interpretation of the antagonist",
    });
    expect((await documentService.manifest(userId, bookId)).revisionId).toBe(
      source.revisionId,
    );
    expect((await detail()).plans[0].stale).toBe(true);
    expect(
      (await readCampaign(userId, bookId, campaignId, plan.id)).plans[0]
        .analysis,
    ).toEqual(plan.analysis);
  });
  test('recovers an acknowledged campaign proposal after interruption without redispatch', async () => {
    await analyze(); await confirm(await detail());
    const plan = await analyze(); await decision(plan.id, 'approve');
    const discussion = await prepare(plan.id, plan.analysis!.steps[0]);
    const proposal = await requestDocumentProposal(userId, bookId, discussion.id, { operationId: randomUUID(), instruction: 'Preserve the brass key and add restrained pressure.' });
    const retained = proposal.result as unknown as DocumentProposalProviderResult;
    await db().documentProposal.update({ where: { id: proposal.id }, data: { status: 'unknown', result: { raw: retained.raw, provenance: retained.provenance as never } } });
    const recovered = await readDocumentProposal(userId, bookId, proposal.id);
    expect(recovered.status).toBe('ready');
    expect((recovered.result as unknown as { output: DocumentProposalOutput }).output.edits).toHaveLength(1);
    expect(SceneProseService.prototype.proposeDocumentEdits).toHaveBeenCalledTimes(1);
  });

});
