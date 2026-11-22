import { z } from "zod";
import { passageOperationsSchema } from "./passageOperationValidation";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const documentStoryDiscussionSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    sessionId: z.string().uuid(),
    storyId: id,
    expectedRevisionId: z.string().uuid(),
    expectedLayoutRevisionId: z.string().uuid(),
    expectedContentHash: sha,
    projection: z.literal("final"),
    targets: z
      .array(
        z
          .object({
            blockId: id,
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
            sourceText: z.string().max(20000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    localOperations: z
      .object({
        operationId: z.string().uuid(),
        operations: passageOperationsSchema,
      })
      .strict()
      .optional(),
    parentDiscussionId: z.string().uuid().optional(),
  })
  .strict();
export const documentStoryProposalRevalidateSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    expectedLayoutRevisionId: z.string().uuid(),
  })
  .strict();
export const documentStoryProposalApplySchema =
  documentStoryProposalRevalidateSchema
    .extend({
      validationId: z.string().uuid(),
      targetIds: z.array(z.string().uuid()).min(1).max(100),
    })
    .strict();
export const documentStoryDraftCommitSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    expectedLayoutRevisionId: z.string().uuid(),
    expectedContentHash: sha,
    operations: passageOperationsSchema,
  })
  .strict();
