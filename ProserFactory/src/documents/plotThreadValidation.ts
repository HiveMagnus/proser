import { z } from 'zod';
const id = z.string().uuid();
const version = z.number().int().nonnegative();
export const plotThreadMutationSchema = z.object({
  operationId: id, expectedVersion: version,
  question: z.string().trim().min(1).max(1000).optional(),
  description: z.string().max(4000).optional(), notes: z.string().max(8000).optional(),
  status: z.enum(['open', 'escalated', 'resolved', 'abandoned']).optional(), archived: z.boolean().optional(),
}).strict();
export const plotThreadEvidenceSchema = z.object({
  operationId: id, expectedVersion: version, stage: z.enum(['setup', 'escalation', 'payoff']),
  sceneId: z.number().int().positive(), expectedRevisionId: id, expectedSceneRevisionId: id,
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/), replacesEvidenceId: id.optional(),
  targets: z.array(z.object({ blockId: z.string().min(1).max(128), from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(), sourceText: z.string().min(1).max(20000) }).strict()).min(1).max(20),
}).strict();
export const plotThreadOperationSchema = z.object({ operationId: id, expectedVersion: version }).strict();
export const plotThreadReviewSchema = plotThreadOperationSchema.extend({ expectedRevisionId: id, selectedModel: z.string().min(1).max(100).optional() });
export const plotThreadAssessmentSchema = plotThreadOperationSchema.extend({ assessment: z.enum(['earned', 'weak', 'insufficient-evidence']), notes: z.string().max(8000) });
export const plotThreadCritiqueSchema = z.object({
  assessment: z.enum(['earned', 'weak', 'insufficient-evidence']), summary: z.string().min(1).max(6000),
  findings: z.array(z.object({ aspect: z.enum(['promise', 'escalation', 'causality', 'payoff']),
    explanation: z.string().min(1).max(4000), suggestion: z.string().min(1).max(4000),
    citations: z.array(z.object({ evidenceId: id, quote: z.string().min(1).max(20000) }).strict()).min(1).max(12),
  }).strict()).min(1).max(12),
}).strict();
