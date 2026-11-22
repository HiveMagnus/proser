import { z } from "zod";
import { documentSchema } from "./validation";
import type { DocumentPassageOperation } from "./passage-operations-model";
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const unicode = z
  .string()
  .max(32768)
  .refine(
    (value) =>
      !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      ),
    "Canonical Unicode is required",
  );
const paragraph = documentSchema.shape.blocks.element.options[0];
const textStyle = paragraph.shape.runs.element.shape.style;
const paragraphStyle = paragraph.shape.style;
const image = documentSchema.shape.blocks.element.options[1].omit({
  type: true,
  id: true,
});
const paragraphTarget = z
  .object({ blockId: identifier, paragraphHash: sha, containerHash: sha })
  .strict();
const runTarget = paragraphTarget
  .extend({
    runId: identifier,
    sourceHash: sha,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .strict();
const objectTarget = z
  .object({ objectId: identifier, sourceHash: sha, containerHash: sha })
  .strict();
const placement = z
  .object({
    neighborId: identifier,
    neighborHash: sha,
    side: z.enum(["before", "after"]),
    containerHash: sha,
  })
  .strict();
const textPatch = z
  .object({
    set: textStyle.optional(),
    unset: z
      .array(
        z.enum(
          Object.keys(textStyle.shape) as [
            keyof typeof textStyle.shape,
            ...Array<keyof typeof textStyle.shape>,
          ],
        ),
      )
      .max(20)
      .optional(),
  })
  .strict();
const paragraphPatch = z
  .object({
    set: paragraphStyle.optional(),
    unset: z
      .array(
        z.enum(
          Object.keys(paragraphStyle.shape) as [
            keyof typeof paragraphStyle.shape,
            ...Array<keyof typeof paragraphStyle.shape>,
          ],
        ),
      )
      .max(20)
      .optional(),
  })
  .strict();
const widths = z.array(z.number().positive().max(2000)).min(1).max(100);
const id = { id: z.string().uuid() };
export const passageOperationSchema: z.ZodType<DocumentPassageOperation> =
  z.discriminatedUnion("kind", [
    z
      .object({
        ...id,
        kind: z.literal("text"),
        target: runTarget,
        expectedText: unicode,
        replacement: unicode,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("run-format"),
        target: runTarget,
        expectedText: unicode,
        patch: textPatch,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("paragraph-format"),
        target: paragraphTarget,
        patch: paragraphPatch,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("paragraph-split"),
        target: runTarget,
        expectedText: z.literal(""),
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("paragraph-join"),
        left: paragraphTarget,
        right: paragraphTarget,
        boundaryHash: sha,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("insert-inline-image"),
        target: runTarget,
        image,
      })
      .strict(),
    z
      .object({ ...id, kind: z.literal("insert-image"), placement, image })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("update-image"),
        target: objectTarget,
        image,
      })
      .strict(),
    z
      .object({ ...id, kind: z.literal("remove-object"), target: objectTarget })
      .strict(),
    z.object({ ...id, kind: z.literal("insert-break"), placement }).strict(),
    z.object({ ...id, kind: z.literal("insert-paragraph"), placement, style: paragraphStyle.optional() }).strict(),
    z
      .object({
        ...id,
        kind: z.literal("insert-table"),
        placement,
        widths,
        rows: z.number().int().min(1).max(100),
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("table-widths"),
        target: objectTarget,
        widths,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("table-insert-row"),
        target: objectTarget,
        rowId: identifier,
        side: z.enum(["before", "after"]),
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("table-remove-row"),
        target: objectTarget,
        rowId: identifier,
        rowHash: sha,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("table-insert-column"),
        target: objectTarget,
        column: z.number().int().min(0).max(100),
        width: z.number().positive().max(2000),
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("table-remove-column"),
        target: objectTarget,
        column: z.number().int().min(0).max(99),
        columnHash: sha,
      })
      .strict(),
    z
      .object({
        ...id,
        kind: z.literal("resolve-change"),
        changeId: identifier,
        changeHash: sha,
        targetHash: sha,
        decision: z.enum(["accepted", "rejected"]),
      })
      .strict(),
  ]);
export const passageOperationsSchema = z
  .array(passageOperationSchema)
  .min(1)
  .max(32)
  .refine(
    (operations) =>
      new Set(operations.map((operation) => operation.id)).size ===
      operations.length,
    "Each operation ID must be distinct",
  );
