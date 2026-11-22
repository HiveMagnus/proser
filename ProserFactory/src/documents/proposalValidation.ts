import { z } from 'zod';
import { documentSchema } from './validation';
import { passageOperationsSchema } from './passageOperationValidation';
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const documentDiscussionSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), sessionId: z.string().uuid(), sceneId: z.number().int().positive(),
  expectedRevisionId: z.string().uuid(), expectedSceneRevisionId: z.string().uuid(), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  projection: z.literal('final'), targets: z.array(z.object({ blockId: id, from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), sourceText: z.string().max(20000) }).strict()).min(1).max(100),
  localDocument: documentSchema.optional(),
  localOperations: z.object({ operationId: z.string().uuid(), operations: passageOperationsSchema }).strict().optional(),
  transitionChapterId: z.number().int().positive().optional(),
  revisionCampaignPlanId: z.string().uuid().optional(),
  revisionCampaignStepId: z.string().min(1).max(128).optional(),
  plotThreadReviewId: z.string().uuid().optional(),
  plotThreadEvidenceId: z.string().uuid().optional(),
  parentDiscussionId: z.string().uuid().optional(),
}).strict().refine(input => Boolean(input.revisionCampaignPlanId) === Boolean(input.revisionCampaignStepId), 'Campaign plan and step must be supplied together').refine(input => !input.revisionCampaignPlanId || !(input.plotThreadReviewId || input.transitionChapterId || input.localDocument || input.localOperations || input.parentDiscussionId), 'Campaign edits require saved targets and no other review context').refine((input) => !(input.localDocument && input.localOperations), 'Use exactly one unsaved context representation').refine(input => Boolean(input.plotThreadReviewId) === Boolean(input.plotThreadEvidenceId), 'Thread review and evidence IDs must be supplied together');
export const documentProposalRequestSchema = z.object({ operationId: z.string().uuid(), instruction: z.string().min(1).max(8000).refine((value) => Buffer.byteLength(value) <= 8000, 'Instruction exceeds 8000 UTF-8 bytes'), selectedModel: z.string().min(1).max(100).optional() }).strict();
export const documentProposalOutputSchema = z.object({ reply: z.string().max(16000), edits: z.array(z.object({ targetId: z.string().uuid(), sourceText: z.string().max(20000), replacement: z.string().max(20000) }).strict()).max(100) }).strict();
export const documentProposalRevalidateSchema = z.object({ operationId: z.string().uuid(), expectedRevisionId: z.string().uuid(), expectedSceneRevisionId: z.string().uuid() }).strict();
export const documentProposalApplySchema = documentProposalRevalidateSchema.extend({ validationId: z.string().uuid(), targetIds: z.array(z.string().uuid()).min(1).max(100) }).strict();
