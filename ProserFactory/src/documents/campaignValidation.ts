import { z } from "zod";
const text = z.string().min(1).max(2000);
export const campaignCitationSchema = z
  .object({
    sceneId: z.number().int().positive(),
    sceneRevisionId: z.string().uuid(),
    blockId: z.string().min(1).max(128),
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    quote: z.string().min(1).max(4000),
  })
  .strict();
const rule = z
  .object({ text, citations: z.array(campaignCitationSchema).min(1).max(5) })
  .strict();
export const campaignConstraintsSchema = z
  .object({ facts: z.array(rule).max(40), voice: z.array(rule).max(10) })
  .strict();
export const campaignMutationSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    goal: z.string().min(3).max(4000),
    preset: z.enum(["antagonist", "character-arc", "pacing", "theme"]),
    constraints: campaignConstraintsSchema.default({ facts: [], voice: [] }),
    confirmed: z.boolean().default(false),
  })
  .strict();
export const campaignAnalysisSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expectedRevisionId: z.string().uuid(),
    mode: z.enum(["plan", "preview", "recheck"]).default("plan"),
    proposalId: z.string().uuid().optional(),
    targetIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (x) => (x.mode === "preview") === Boolean(x.proposalId),
    "Preview requires exactly one proposal ID",
  );
export const campaignDecisionSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expectedRevisionId: z.string().uuid(),
    decision: z.enum([
      "approve",
      "request-changes",
      "skip",
      "resolve",
      "finish",
    ]),
    stepId: z.string().max(128).optional(),
    proposalId: z.string().uuid().optional(),
    reason: z.string().max(4000).default(""),
  })
  .strict();
export const campaignStepSchema = z
  .object({
    id: z.string().min(1).max(128),
    sceneId: z.number().int().positive(),
    chapterId: z.number().int().positive(),
    title: text,
    instruction: text,
    citations: z.array(campaignCitationSchema).min(1).max(5),
    prerequisites: z.array(z.string().min(1).max(128)).max(100),
    consequences: z
      .array(
        z
          .object({
            prediction: text,
            citations: z.array(campaignCitationSchema).min(1).max(5),
          })
          .strict(),
      )
      .max(8),
    questions: z.array(text).max(8),
    manual: z.boolean(),
  })
  .strict();
export const campaignScanSchema = z
  .object({
    summary: z.string().max(1200),
    rechecks: z
      .array(
        z
          .object({
            target: z.string().min(1).max(128),
            assessment: z.enum(["holds", "changed", "missing", "inconclusive"]),
            explanation: text,
            citations: z.array(campaignCitationSchema).min(1).max(5),
          })
          .strict(),
      )
      .max(30),
    suggestions: campaignConstraintsSchema,
    steps: z.array(campaignStepSchema).max(3),
    gaps: z.array(text).max(8),
  })
  .strict();
export const campaignSynthesisSchema = z
  .object({
    summary: text,
    steps: z.array(campaignStepSchema).max(100),
    gaps: z.array(text).max(100),
  })
  .strict();
export const campaignVerificationSchema = z
  .object({
    passed: z.boolean(),
    facts: text,
    voice: text,
    consequences: text,
    citations: z.array(campaignCitationSchema).min(1).max(15),
    failures: z.array(text).max(20),
  })
  .strict();
