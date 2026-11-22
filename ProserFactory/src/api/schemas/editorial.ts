import { z } from 'zod';

import { EDITORIAL_LIMITS } from '@/services/editorial/editorialPolicy';

export const editorialScopeSchema = z.object({
  type: z.enum(['book', 'act', 'chapter', 'scene']).default('book'),
  id: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type !== 'book' && !value.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'id is required for non-book scope' });
  if (value.type === 'book' && value.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'id is not allowed for book scope' });
});

export const editorialOptimizeSchema = z.object({
  bookId: z.number().int().positive(),
  scope: editorialScopeSchema.default({ type: 'book' }),
  objective: z.string().trim().min(3).max(4_000).optional(),
  passPack: z.enum(['line_edit_safe', 'dialogue', 'voice_preservation', 'scene_energy', 'continuity', 'name_originality', 'final_polish', 'custom']),
  autonomy: z.enum(['review_only', 'propose_only', 'safe_auto', 'max_quality_auto']),
  profileId: z.string().uuid().optional(),
  protectedElements: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  changeBudget: z.object({
    maxChangedWordsPercentPerScene: z.number().min(0).max(EDITORIAL_LIMITS.maxChangedPercentScene).optional(),
    maxChangedWordsPercentTotal: z.number().min(0).max(EDITORIAL_LIMITS.maxChangedPercentTotal).optional(),
    maxProposals: z.number().int().min(0).max(EDITORIAL_LIMITS.maxProposals).optional(),
    maxCandidatesPerProposal: z.number().int().min(1).max(EDITORIAL_LIMITS.maxCandidatesPerProposal).optional(),
    maxInferenceTokens: z.number().int().min(0).max(EDITORIAL_LIMITS.maxInferenceTokens).optional(),
    maxJudgeEscalations: z.number().int().min(0).max(EDITORIAL_LIMITS.maxJudgeEscalations).optional(),
  }).strict().optional(),
  acceptancePolicy: z.object({
    minimumConfidence: z.number().min(0).max(1).optional(),
    minimumPreferenceMargin: z.number().min(0).max(1).optional(),
    maximumRisk: z.enum(['low', 'medium']).optional(),
    requireNoHardRegression: z.boolean().optional(),
  }).strict().optional(),
  modelPolicy: z.object({
    generator: z.string().trim().min(1).max(200).optional(),
    primaryJudge: z.string().trim().min(1).max(200).optional(),
    secondaryJudge: z.string().trim().min(1).max(200).optional(),
    tieBreakerJudge: z.string().trim().min(1).max(200).optional(),
    longRangeCritic: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.passPack === 'custom' && !value.objective) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['objective'], message: 'objective is required for custom pass' });
  if (value.passPack === 'custom' && value.objective && /\b(?:rewrite|replace)\s+(?:the\s+)?(?:whole|entire)\s+(?:book|novel|chapter)|\b(?:add|remove)\s+(?:a\s+)?(?:scene|chapter)|\brestructure\b/i.test(value.objective)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['objective'], message: 'custom objectives must be bounded passage-level editorial work' });
  }
});

export const editorialProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  bookId: z.number().int().positive().optional(),
  active: z.boolean().optional(),
  config: z.object({
    styleGoals: z.array(z.string().max(200)).max(50).optional(),
    mustPreserve: z.array(z.string().max(200)).max(100).optional(),
    mustAvoid: z.array(z.string().max(200)).max(100).optional(),
    preferredPov: z.string().max(100).optional(),
    preferredTense: z.string().max(100).optional(),
    dialogueAttribution: z.string().max(100).optional(),
    sentenceVariance: z.string().max(100).optional(),
    figurativeDensity: z.string().max(100).optional(),
    interiority: z.string().max(100).optional(),
    characterVoices: z.record(z.string(), z.string().max(1_000)).optional(),
    protectedElements: z.array(z.string().max(200)).max(200).optional(),
    intentionalExceptions: z.record(z.string(), z.array(z.string().max(200)).max(50)).optional(),
    passOverrides: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  }).strict(),
}).strict();

export const editorialPreferenceSchema = z.object({
  evidenceType: z.enum(['choose_candidate', 'choose_original', 'reject_all', 'undo_auto_edit', 'manual_rewrite', 'dismiss_finding', 'explicit_profile_rule']),
  candidateId: z.string().uuid().optional(),
  rationaleTags: z.array(z.enum(['clarity', 'rhythm', 'voice', 'subtlety', 'specificity', 'pacing', 'dialogue', 'canon'])).max(8).optional(),
  manualRewrite: z.string().min(1).max(4_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.manualRewrite && value.evidenceType !== 'manual_rewrite') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['manualRewrite'], message: 'manualRewrite requires manual_rewrite evidenceType' });
  }
});

export type EditorialOptimizeBody = z.infer<typeof editorialOptimizeSchema>;
