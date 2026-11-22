import { z } from "zod";
const unicodeText = z
  .string()
  .max(32768)
  .refine(
    (value) =>
      !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      ),
    "Canonical text must contain valid Unicode without NUL",
  );
const cursor = z
  .object({
    paragraph: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    item: z.number().int().nonnegative().optional(),
    run: z.number().int().nonnegative().optional(),
  })
  .strict();
const bounds = {
  maxCharacters: z.number().int().min(128).max(32768).optional(),
  maxParagraphs: z.number().int().min(1).max(64).optional(),
  maxRuns: z.number().int().min(1).max(256).optional(),
  reviewOffset: z.number().int().nonnegative().optional(),
};
export const documentPassageQuery = z
  .object({
    bookRevisionId: z.string().uuid().optional(),
    edge: z.literal("last").optional(),
    anchorBlockId: z.string().min(1).max(128).optional(),
    anchorRunId: z.string().min(1).max(128).optional(),
    anchorOffset: z.coerce.number().int().nonnegative().optional(),
    anchorSourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    paragraph: z.coerce.number().int().nonnegative().default(0),
    offset: z.coerce.number().int().nonnegative().default(0),
    item: z.coerce.number().int().nonnegative().optional(),
    run: z.coerce.number().int().nonnegative().optional(),
    projection: z.enum(["final", "original", "markup"]).optional(),
    maxRuns: z.coerce.number().int().min(1).max(256).optional(),
    reviewOffset: z.coerce.number().int().nonnegative().optional(),
    maxCharacters: z.coerce.number().int().min(128).max(32768).optional(),
    maxParagraphs: z.coerce.number().int().min(1).max(64).optional(),
  })
  .strict();
export const documentPassageCommitSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    expectedSceneRevisionId: z.string().uuid(),
    windowHash: z.string().regex(/^[a-f0-9]{64}$/),
    cursor,
    ...bounds,
    tracking: z.boolean().optional(),
    edits: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(128),
            runId: z.string().min(1).max(128),
            sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
            expectedText: unicodeText,
            replacement: unicodeText,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export const documentPassageRestoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    expectedSceneRevisionId: z.string().uuid(),
    windowHash: z.string().regex(/^[a-f0-9]{64}$/),
    cursor,
    ...bounds,
    restoreFromRevisionId: z.string().uuid(),
    restoreCursor: cursor.optional(),
  })
  .strict();
