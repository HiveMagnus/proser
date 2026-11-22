import { z } from 'zod';
const target = z.object({ targetId: z.string().uuid(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), sourceText: z.string().max(20000) }).strict();
export const documentFeedbackSchema = z.object({
  judgeSummary: z.object({ headline: z.string().max(1000), summary: z.string().max(8000), strengths: z.array(z.string().max(1000)).max(10), cautions: z.array(z.string().max(1000)).max(10) }).strict(),
  findings: z.array(z.object({ target: target.optional(), findingType: z.string().max(100), severity: z.enum(['critical','warning','suggestion']), title: z.string().max(1000), message: z.string().max(8000), suggestion: z.string().max(20000).optional(), rationale: z.string().max(8000).optional() }).strict()).max(10),
  compareCards: z.array(z.object({ target, title: z.string().max(1000), message: z.string().max(8000), optionALabel: z.string().max(100), optionAText: z.string().max(20000), optionBLabel: z.string().max(100), optionBText: z.string().max(20000), recommendedOption: z.enum(['a','b']).optional(), rationale: z.string().max(8000).optional() }).strict()).max(10),
}).strict();
export const documentCompareRevalidateSchema = z.object({ operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(), expectedSceneRevisionId: z.string().uuid() }).strict();
export const documentCompareSchema = documentCompareRevalidateSchema.extend({ traceId: z.string().min(1).max(255), compareCardId: z.number().int().positive(), chosen: z.enum(['a','b']), applyChosen: z.boolean(), validationId: z.string().uuid().optional(), rationale: z.string().max(4000).optional() }).strict();
