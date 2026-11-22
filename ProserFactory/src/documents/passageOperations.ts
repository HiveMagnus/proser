/** Pure canonical mutations over the complete server-owned scene. This module
 * never authenticates, writes DB, calls providers or accepts Canvas commands. */
import { z } from "zod";
import {
  canonicalDocument,
  projectDocument,
  replaceDocumentText,
  resolveChange,
  visibleRun,
  visibleParagraph,
  MAX_DOCUMENT_BYTES,
  type ProserDocument,
  type DocumentParagraph,
  type DocumentRun,
  type DocumentChange,
  type DocumentAnchorLineage,
  type DocumentImage,
  type TextStyle,
  type ParagraphStyle,
} from "./model";
import { parseCommentCandidateDocument } from "./commentAnchors";
import { validateDocument } from "./validation";
import {
  validateDocumentStyleReferences,
  type DocumentStyleDefinitions,
} from "./style-model";
import { compatibilityOperationId } from "./operationIdentity";
import { DocumentError } from "./errors";
import type { DocumentPassageSourceFrame } from "./passage-model";
import type {
  DocumentPassageOperation,
  DocumentPassageOperationResult,
  PassageRunSource,
  PassageParagraphSource,
  PassageObjectSource,
  PassageBodyPlacement,
  PassageStylePatch,
} from "./passage-operations-model";
import { passageOperationsSchema } from "./passageOperationValidation";
import {
  operationSourceHash,
  passageParagraphLocation,
  passageOperationParagraphSource,
  passageOperationObjectSource,
  passageOperationPlacement,
  passageBoundaryHash,
  passageReviewTargetHash,
  sourceRun,
  bodyParagraphs,
  passageTableRowHash,
  passageTableColumnHash,
  passageOperationRunSource,
  emptyPassageBodyPlacement,
} from "./passageOperationSources";
export interface PassageOperationActor {
  id: number;
  name: string;
  createdAt: string;
  origin: "manual" | "ai" | "workflow";
  automatedResolutionApproved?: boolean;
}
export interface PassageOperationWindow {
  runs: PassageRunSource[];
  paragraphIds?: string[];
  objectIds?: string[];
  neighborIds?: string[];
  changeIds?: string[];
  rowIds?: string[];
}
export interface LayoutStoryOperationSource {
  sourceKind: "layout-story"; bookId: number; storyId: string; bookRevisionId: string; layoutRevisionId: string; contentHash: string; projection: "final";
}
export interface PassageOperationOptions {
  operationId: string;
  sourceFrame: DocumentPassageSourceFrame | LayoutStoryOperationSource;
  actor: PassageOperationActor;
  tracking?: boolean;
  window: PassageOperationWindow;
  verifiedAssets?: ReadonlyMap<number, string>;
  styles?: DocumentStyleDefinitions;
}
function fail(code: string, message: string, status = 409): never {
  throw new DocumentError(code, message, status);
}
const grapheme = (text: string, offset: number) =>
  offset === 0 ||
  offset === text.length ||
  new Intl.Segmenter("und", { granularity: "grapheme" })
    .segment(text)
    .containing(offset)?.index === offset;
const own = (
  change: DocumentChange | undefined,
  actor: PassageOperationActor,
) =>
  change?.status === "pending" &&
  change.origin === "manual" &&
  change.authorId === actor.id &&
  change.importedAuthor === undefined &&
  actor.origin === "manual" &&
  ["insertion", "paragraphInsertion"].includes(change.kind);
function patch<T extends TextStyle | ParagraphStyle>(
  before: T,
  change: PassageStylePatch<T>,
): T {
  const unset = change.unset ?? [];
  if (
    new Set(unset).size !== unset.length ||
    unset.some((key) =>
      Object.prototype.hasOwnProperty.call(change.set ?? {}, key),
    )
  )
    fail(
      "DOCUMENT_PASSAGE_STYLE_INVALID",
      "Style properties cannot be set and removed twice.",
    );
  const next = { ...before, ...change.set };
  for (const key of unset) delete next[key];
  return next;
}
function assertParagraphSource(
  document: ProserDocument,
  target: PassageParagraphSource,
  window: PassageOperationWindow,
) {
  if (
    !(window.paragraphIds ?? window.runs.map((run) => run.blockId)).includes(
      target.blockId,
    )
  )
    fail(
      "DOCUMENT_PASSAGE_TARGET_OUTSIDE_WINDOW",
      "Paragraph is outside the disclosed passage.",
    );
  if (
    canonicalDocument(
      passageOperationParagraphSource(document, target.blockId),
    ) !== canonicalDocument(target)
  )
    fail(
      "DOCUMENT_SOURCE_STALE",
      "Paragraph properties or container identities changed.",
      412,
    );
  return passageParagraphLocation(document, target.blockId);
}
function assertRunSource(
  document: ProserDocument,
  target: PassageRunSource,
  window: PassageOperationWindow,
  expected?: string,
) {
  const allowed = window.runs.find(
    (run) =>
      run.blockId === target.blockId &&
      run.runId === target.runId &&
      run.sourceHash === target.sourceHash &&
      run.paragraphHash === target.paragraphHash &&
      run.containerHash === target.containerHash &&
      target.from >= run.from &&
      target.to <= run.to,
  );
  if (!allowed || target.to < target.from)
    fail(
      "DOCUMENT_PASSAGE_TARGET_OUTSIDE_WINDOW",
      "Run span is outside the exact disclosed passage.",
    );
  const location = passageParagraphLocation(document, target.blockId);
  const run = sourceRun(document, target);
  if (
    operationSourceHash(run) !== target.sourceHash ||
    canonicalDocument(
      passageOperationParagraphSource(document, target.blockId),
    ) !==
      canonicalDocument({
        blockId: target.blockId,
        paragraphHash: target.paragraphHash,
        containerHash: target.containerHash,
      })
  )
    fail(
      "DOCUMENT_SOURCE_STALE",
      "Run/paragraph formatting or container changed.",
      412,
    );
  const length = run.inlineImage ? 1 : run.text.length;
  if (
    target.to > length ||
    !grapheme(run.inlineImage ? "\uFFFC" : run.text, target.from) ||
    !grapheme(run.inlineImage ? "\uFFFC" : run.text, target.to) ||
    (expected !== undefined &&
      run.text.slice(target.from, target.to) !== expected)
  )
    fail("DOCUMENT_SOURCE_STALE", "Text or Unicode boundaries changed.", 412);
  const projection = projectDocument(document);
  const projected = projection.spans.find(
    (span) => span.blockId === target.blockId && span.runId === target.runId,
  );
  if (
    projected &&
    (!grapheme(projection.text, projected.start + target.from) ||
      !grapheme(projection.text, projected.start + target.to))
  )
    fail(
      "DOCUMENT_SOURCE_STALE",
      "Edit splits a grapheme across canonical runs/paragraphs.",
      412,
    );
  if (
    !visibleParagraph(location.paragraph, document.changes, "final") ||
    !visibleRun(run, document.changes, "final")
  )
    fail(
      "DOCUMENT_REVIEW_CONFLICT",
      "Hidden review targets cannot be directly edited.",
    );
  return { location, run };
}
function assertEditable(
  document: ProserDocument,
  paragraph: DocumentParagraph,
  runIds: string[],
  actor: PassageOperationActor,
  format = false,
) {
  for (const change of document.changes.filter(
    (change) =>
      change.status === "pending" &&
      (change.targetBlockIds?.includes(paragraph.id) ||
        change.targetRunIds.some((id) => runIds.includes(id))),
  )) {
    if (own(change, actor)) continue;
    if (
      !format &&
      ["paragraphSplit", "paragraphJoin"].includes(change.kind) &&
      change.origin === "manual" &&
      change.authorId === actor.id &&
      actor.origin === "manual" &&
      change.importedAuthor === undefined
    )
      continue;
    fail(
      "DOCUMENT_REVIEW_CONFLICT",
      "Resolve this pending review target before editing its content/formatting.",
    );
  }
}
function assertObject(
  document: ProserDocument,
  target: PassageObjectSource,
  window: PassageOperationWindow,
) {
  if (!window.objectIds?.includes(target.objectId))
    fail(
      "DOCUMENT_PASSAGE_TARGET_OUTSIDE_WINDOW",
      "Object is outside the disclosed passage.",
    );
  if (
    canonicalDocument(
      passageOperationObjectSource(document, target.objectId),
    ) !== canonicalDocument(target)
  )
    fail("DOCUMENT_SOURCE_STALE", "Object payload/container changed.", 412);
}
function assertPlacement(
  document: ProserDocument,
  target: PassageBodyPlacement,
  window: PassageOperationWindow,
) {
  if (!window.neighborIds?.includes(target.neighborId))
    fail(
      "DOCUMENT_PASSAGE_TARGET_OUTSIDE_WINDOW",
      "Body neighbor is outside the disclosed passage.",
    );
  if (document.blocks.length === 0 && canonicalDocument(target) === canonicalDocument(emptyPassageBodyPlacement())) return;
  if (
    canonicalDocument(
      passageOperationPlacement(document, target.neighborId, target.side),
    ) !== canonicalDocument(target)
  )
    fail("DOCUMENT_SOURCE_STALE", "Body placement/order changed.", 412);
}
function assertAsset(
  image: Omit<DocumentImage, "type" | "id">,
  verified?: ReadonlyMap<number, string>,
) {
  if (verified?.get(image.assetId) !== image.sha256)
    fail(
      "DOCUMENT_ASSET_UNVERIFIED",
      "Insert/update requires a server-verified owned immutable asset digest.",
    );
}
function assertRemovedReview(
  document: ProserDocument,
  paragraphs: DocumentParagraph[],
) {
  const blocks = new Set(paragraphs.map((p) => p.id));
  const runs = new Set(paragraphs.flatMap((p) => p.runs.map((r) => r.id)));
  if (
    document.changes.some(
      (change) =>
        change.targetBlockIds?.some((id) => blocks.has(id)) ||
        change.targetRunIds.some((id) => runs.has(id)),
    )
  )
    fail(
      "DOCUMENT_REVIEW_TARGET_HISTORY_REQUIRED",
      "Reviewed targets require complete restoration or owned historical target preservation before structural removal.",
    );
}
/** The transport independently verifies manifest/layout/membership/window CAS;
 * this engine validates its owned scene hash and exact allowed target scopes. */
export function applyPassageOperations(
  raw: ProserDocument,
  input: unknown,
  options: PassageOperationOptions,
): DocumentPassageOperationResult {
  const parsed = passageOperationsSchema.safeParse(input);
  if (!parsed.success)
    fail(
      "DOCUMENT_PASSAGE_OPERATION_INVALID",
      "Invalid bounded typed operations.",
      422,
    );
  const operations = parsed.data;
  if (Buffer.byteLength(canonicalDocument(operations)) > 256 * 1024)
    fail(
      "DOCUMENT_PASSAGE_OPERATION_TOO_LARGE",
      "Operation batch exceeds 256 KiB.",
      413,
    );
  z.string().uuid().parse(options.operationId);
  z.number().int().positive().parse(options.actor.id);
  z.string().datetime().parse(options.actor.createdAt);
  if (
    options.sourceFrame.projection !== "final" &&
    operations.some((operation) => operation.kind !== "resolve-change")
  )
    fail(
      "DOCUMENT_PASSAGE_VIEW_READONLY",
      "Direct editing uses the working/final projection.",
    );
  const original = validateDocument(raw);
  if (operationSourceHash(original) !== ("sceneContentHash" in options.sourceFrame ? options.sourceFrame.sceneContentHash : options.sourceFrame.contentHash))
    fail(
      "DOCUMENT_SOURCE_STALE",
      "Server scene differs from the captured source frame.",
      412,
    );
  let next = structuredClone(original);
  const introducedIds: DocumentPassageOperationResult["introducedIds"] = [];
  const anchorLineage: DocumentAnchorLineage[] = [];
  const mappingDrafts: Array<{
    op: DocumentPassageOperation;
    source: PassageRunSource;
    target?: { blockId: string; runId: string; from: number; to: number };
    relation: DocumentPassageOperationResult["operationMappings"][number]["relation"];
  }> = [];
  const touched = {
    blockIds: new Set<string>(),
    runIds: new Set<string>(),
    objectIds: new Set<string>(),
    changeIds: new Set<string>(),
  };
  const occupied = new Set<string>();
  const tracking =
    options.actor.origin === "manual" ? options.tracking === true : true;
  const attribute = () => ({
    authorId: options.actor.id,
    authorName: options.actor.name,
    createdAt: options.actor.createdAt,
    origin: options.actor.origin,
    status:
      options.actor.origin === "workflow" &&
      options.actor.automatedResolutionApproved
        ? ("accepted" as const)
        : ("pending" as const),
  });
  const fresh = (op: DocumentPassageOperation, role: string) => {
    const id = compatibilityOperationId("proser.passage-resource.v1", {
      bookId: options.sourceFrame.bookId,
      ...("sceneId" in options.sourceFrame ? { sceneId: options.sourceFrame.sceneId } : { sourceKind: "layout-story", storyId: options.sourceFrame.storyId }),
      operationId: options.operationId,
      opId: op.id,
      role,
    });
    introducedIds.push({ operationId: op.id, role, id });
    return id;
  };
  const claim = (key: string) => {
    if (occupied.has(key))
      fail(
        "DOCUMENT_PASSAGE_OPERATION_OVERLAP",
        "Overlapping frozen targets need coalescing or a separate save.",
      );
    occupied.add(key);
  };
  const mapRun = (
    op: DocumentPassageOperation,
    old: DocumentRun,
    oldBlock: string,
    from: number,
    to: number,
    newRun: DocumentRun | undefined,
    newBlock: string,
    targetFrom: number,
    relation: DocumentPassageOperationResult["operationMappings"][number]["relation"],
  ) => {
    const allowed = options.window.runs.find(
      (run) => run.blockId === oldBlock && run.runId === old.id,
    );
    if (!allowed) return;
    const start = Math.max(from, allowed.from),
      end = Math.min(to, allowed.to);
    if (end < start || (end === start && from !== to)) return;
    const adjusted =
      relation === "unchanged" ||
      relation === "formatted" ||
      relation === "moved";
    const newStart = adjusted ? targetFrom + start - from : targetFrom;
    const newEnd = adjusted
      ? newStart + end - start
      : newRun
        ? newRun.inlineImage
          ? 1
          : newRun.text.length
        : newStart;
    mappingDrafts.push({
      op,
      source: passageOperationRunSource(original, oldBlock, old.id, start, end),
      ...(newRun
        ? {
            target: {
              blockId: newBlock,
              runId: newRun.id,
              from: newStart,
              to: newEnd,
            },
          }
        : {}),
      relation,
    });
  };
  const lineage = (
    op: DocumentPassageOperation,
    old: DocumentRun,
    oldBlock: string,
    newRun: DocumentRun,
    newBlock: string,
    from: number,
    to: number,
    targetFrom = 0,
  ) => {
    if ("sceneId" in options.sourceFrame) anchorLineage.push({
      kind: "split",
      source: {
        sceneId: options.sourceFrame.sceneId,
        blockId: oldBlock,
        runId: old.id,
        from,
        to,
      },
      target: {
        sceneId: options.sourceFrame.sceneId,
        blockId: newBlock,
        runId: newRun.id,
        from: targetFrom,
        to: targetFrom + to - from,
      },
    });
    mapRun(
      op,
      old,
      oldBlock,
      from,
      to,
      newRun,
      newBlock,
      targetFrom,
      oldBlock === newBlock ? "unchanged" : "moved",
    );
  };
  for (const op of operations) {
    if (options.actor.origin === "ai" && op.kind !== "text")
      fail(
        "DOCUMENT_AI_OPERATION_FORBIDDEN",
        "AI proposals may supply only exact text edits.",
      );
    if (
      op.kind === "text" ||
      op.kind === "run-format" ||
      op.kind === "paragraph-split" ||
      op.kind === "insert-inline-image"
    ) {
      const { location, run: source } = assertRunSource(
        original,
        op.target,
        options.window,
        "expectedText" in op ? op.expectedText : undefined,
      );
      claim(`run:${source.id}`);
      assertEditable(
        next,
        passageParagraphLocation(next, op.target.blockId).paragraph,
        [source.id],
        options.actor,
        op.kind === "run-format",
      );
      touched.blockIds.add(location.paragraph.id);
      touched.runIds.add(source.id);
      if (op.kind === "text") {
        if (op.expectedText === op.replacement && !source.inlineImage) {
          mapRun(
            op,
            source,
            op.target.blockId,
            op.target.from,
            op.target.to,
            sourceRun(next, op.target),
            op.target.blockId,
            op.target.from,
            "unchanged",
          );
          continue;
        }
        if (source.inlineImage)
          fail(
            "DOCUMENT_PASSAGE_TARGET_PROTECTED",
            "Text operations cannot replace an inline image.",
          );
        const paragraph = passageParagraphLocation(
          next,
          op.target.blockId,
        ).paragraph;
        const run = paragraph.runs.find((run) => run.id === source.id)!;
        const existing =
          next.changes.find((change) => change.id === run.changeId) ||
          next.changes.find((change) => change.id === paragraph.changeId);
        if (own(existing, options.actor)) {
          run.text =
            run.text.slice(0, op.target.from) +
            op.replacement +
            run.text.slice(op.target.to);
          if (op.target.from)
            mapRun(
              op,
              source,
              op.target.blockId,
              0,
              op.target.from,
              run,
              op.target.blockId,
              0,
              "unchanged",
            );
          mappingDrafts.push({
            op,
            source: op.target,
            target: {
              blockId: op.target.blockId,
              runId: run.id,
              from: op.target.from,
              to: op.target.from + op.replacement.length,
            },
            relation: "replacement",
          });
          if (op.target.to < source.text.length)
            mapRun(
              op,
              source,
              op.target.blockId,
              op.target.to,
              source.text.length,
              run,
              op.target.blockId,
              op.target.from + op.replacement.length,
              "unchanged",
            );
          continue;
        }
        const span = projectDocument(next).spans.find(
          (span) =>
            span.blockId === op.target.blockId &&
            span.runId === op.target.runId &&
            span.editable,
        );
        if (!span)
          fail(
            "DOCUMENT_PASSAGE_TARGET_PROTECTED",
            "The exact text target is hidden/protected.",
          );
        let sequence = 0;
        const index = paragraph.runs.findIndex((run) => run.id === source.id);
        const following = paragraph.runs[index + 1]?.id;
        next = replaceDocumentText(
          next,
          span.start + op.target.from,
          span.start + op.target.to,
          op.expectedText,
          op.replacement,
          () => fresh(op, `text-resource-${sequence++}`),
          tracking ? attribute() : undefined,
          { blockId: op.target.blockId, runId: op.target.runId },
        );
        const output = passageParagraphLocation(next, op.target.blockId)
          .paragraph.runs;
        const endIndex = following
          ? output.findIndex((run) => run.id === following)
          : output.length;
        const pieces = output.slice(index, endIndex);
        let at = 0;
        if (op.target.from) {
          const prefix = pieces[at++];
          lineage(
            op,
            source,
            op.target.blockId,
            prefix,
            op.target.blockId,
            0,
            op.target.from,
          );
        }
        if (tracking && op.target.to > op.target.from) {
          const removed = pieces[at++];
          mapRun(
            op,
            source,
            op.target.blockId,
            op.target.from,
            op.target.to,
            removed,
            op.target.blockId,
            0,
            "deleted",
          );
        }
        if (op.replacement) {
          const inserted = pieces[at++];
          mappingDrafts.push({
            op,
            source: op.target,
            target: {
              blockId: op.target.blockId,
              runId: inserted.id,
              from: 0,
              to: op.replacement.length,
            },
            relation:
              op.target.from === op.target.to ? "inserted" : "replacement",
          });
        } else if (!tracking && op.target.to > op.target.from)
          mapRun(
            op,
            source,
            op.target.blockId,
            op.target.from,
            op.target.to,
            undefined,
            op.target.blockId,
            0,
            "deleted",
          );
        if (op.target.to < source.text.length) {
          const tail = pieces[at];
          lineage(
            op,
            source,
            op.target.blockId,
            tail,
            op.target.blockId,
            op.target.to,
            source.text.length,
          );
        }
        continue;
      }
      if (op.kind === "run-format") {
        if (source.inlineImage || op.target.to === op.target.from)
          fail(
            "DOCUMENT_PASSAGE_TARGET_PROTECTED",
            "Formatting needs a nonempty exact text span.",
          );
        const paragraph = passageParagraphLocation(
          next,
          op.target.blockId,
        ).paragraph;
        const index = paragraph.runs.findIndex((run) => run.id === source.id);
        const current = paragraph.runs[index]!;
        const style = patch(current.style, op.patch);
        if (canonicalDocument(style) === canonicalDocument(current.style)) {
          mapRun(
            op,
            source,
            op.target.blockId,
            op.target.from,
            op.target.to,
            current,
            op.target.blockId,
            op.target.from,
            "unchanged",
          );
          continue;
        }
        if (tracking && style.hyperlink !== current.style.hyperlink)
          fail(
            "DOCUMENT_LINK_TRACKING_UNSUPPORTED",
            "Word hyperlink-target changes have no supported native formatting revision; use an explicit direct hyperlink edit.",
          );
        const pieces: Array<{
          from: number;
          to: number;
          run: DocumentRun;
          selected: boolean;
        }> = [];
        for (const [from, to, selected] of [
          [0, op.target.from, false],
          [op.target.from, op.target.to, true],
          [op.target.to, current.text.length, false],
        ] as const)
          if (to > from) {
            const id = pieces.length
              ? fresh(op, `format-run-${pieces.length}`)
              : current.id;
            const ownInsertion = own(
              next.changes.find((change) => change.id === current.changeId),
              options.actor,
            );
            const run = {
              ...current,
              id,
              text: current.text.slice(from, to),
              style: selected ? style : { ...current.style },
            };
            if (pieces.length && current.changeId && !ownInsertion)
              delete run.changeId;
            pieces.push({ from, to, run, selected });
            if (ownInsertion)
              next.changes
                .find((change) => change.id === current.changeId)!
                .targetRunIds.push(...(id === current.id ? [] : [id]));
          }
        paragraph.runs.splice(index, 1, ...pieces.map((piece) => piece.run));
        const selected = pieces.find((piece) => piece.selected)!;
        if (
          tracking &&
          !own(
            next.changes.find((change) => change.id === current.changeId),
            options.actor,
          )
        )
          next.changes.push({
            ...attribute(),
            id: fresh(op, "format-change"),
            kind: "format",
            targetRunIds: [selected.run.id],
            beforeStyle: { ...current.style },
            afterStyle: { ...style },
          });
        for (const piece of pieces)
          if (!piece.selected)
            lineage(
              op,
              source,
              op.target.blockId,
              piece.run,
              op.target.blockId,
              piece.from,
              piece.to,
            );
          else {
            if ("sceneId" in options.sourceFrame) anchorLineage.push({kind:"format",source:{sceneId:options.sourceFrame.sceneId,blockId:op.target.blockId,runId:source.id,from:piece.from,to:piece.to},target:{sceneId:options.sourceFrame.sceneId,blockId:op.target.blockId,runId:piece.run.id,from:0,to:piece.to-piece.from}});
            mapRun(op,source,op.target.blockId,piece.from,piece.to,piece.run,op.target.blockId,0,"formatted");
          }
        continue;
      }
      if (op.kind === "paragraph-split") {
        if (op.target.from !== op.target.to)
          fail(
            "DOCUMENT_PASSAGE_BOUNDARY_INVALID",
            "Split requires an exact caret.",
          );
        const located = passageParagraphLocation(next, op.target.blockId);
        const paragraph = located.paragraph;
        if (
          paragraph.boundaryChangeId &&
          next.changes.find(
            (change) => change.id === paragraph.boundaryChangeId,
          )?.status === "pending"
        )
          fail(
            "DOCUMENT_BOUNDARY_HISTORY_REQUIRED",
            "Resolve or preserve the exact existing boundary history before replacing its paragraph mark.",
          );
        assertEditable(
          next,
          paragraph,
          paragraph.runs.map((run) => run.id),
          options.actor,
        );
        const right: DocumentParagraph = {
          type: "paragraph",
          id: fresh(op, "split-paragraph"),
          style: { ...paragraph.style },
          runs: [],
          ...(paragraph.changeId ? { changeId: paragraph.changeId } : {}),
        };
        const sourceParagraph = structuredClone(paragraph);
        const leftRuns: DocumentRun[] = [];
        let found = false;
        for (const run of sourceParagraph.runs) {
          if (!found && run.id !== op.target.runId) {
            leftRuns.push(run);
            continue;
          }
          if (run.id !== op.target.runId) {
            right.runs.push(run);
            lineage(op, run, paragraph.id, run, right.id, 0, run.text.length);
            continue;
          }
          found = true;
          const cut = op.target.from;
          if (run.inlineImage) {
            if (cut === 0) {
              right.runs.push(run);
              lineage(op, run, paragraph.id, run, right.id, 0, 0);
            } else if (cut === 1) leftRuns.push(run);
            else
              fail(
                "DOCUMENT_PASSAGE_BOUNDARY_INVALID",
                "Inline image caret cannot split an object.",
              );
            continue;
          }
          if (cut > 0) {
            const left = { ...run, text: run.text.slice(0, cut) };
            leftRuns.push(left);
            lineage(op, run, paragraph.id, left, paragraph.id, 0, cut);
          }
          if (cut < run.text.length) {
            const fragment = {
              ...run,
              id: cut ? fresh(op, "split-run") : run.id,
              text: run.text.slice(cut),
            };
            if (cut && run.changeId) {
              const change = next.changes.find(
                (change) => change.id === run.changeId,
              );
              if (own(change, options.actor))
                change!.targetRunIds.push(fragment.id);
              else delete fragment.changeId;
            }
            right.runs.push(fragment);
            lineage(
              op,
              run,
              paragraph.id,
              fragment,
              right.id,
              cut,
              run.text.length,
            );
          }
        }
        paragraph.runs = leftRuns.length
          ? leftRuns
          : [
              {
                id: fresh(op, "split-left-empty"),
                text: "",
                style: { ...source.style },
              },
            ];
        if (!right.runs.length)
          right.runs.push({
            id: fresh(op, "split-right-empty"),
            text: "",
            style: { ...source.style },
          });
        const insertion = next.changes.find(
          (change) => change.id === paragraph.changeId,
        );
        if (own(insertion, options.actor))
          insertion!.targetBlockIds!.push(right.id);
        const change: DocumentChange = {
          ...attribute(),
          id: fresh(op, "split-change"),
          kind: "paragraphSplit",
          status: tracking ? attribute().status : "accepted",
          targetRunIds: [],
          targetBlockIds: [paragraph.id, right.id],
        };
        paragraph.boundaryChangeId = change.id;
        next.changes.push(change);
        const index = located.container.findIndex(
          (item) => item.id === paragraph.id,
        );
        located.container.splice(index + 1, 0, right);
        touched.blockIds.add(right.id);
        touched.changeIds.add(change.id);
        continue;
      }
      if (tracking)
        fail(
          "DOCUMENT_OBJECT_TRACKING_UNSUPPORTED",
          "Image insertion cannot masquerade as a native text revision; use an explicit direct object edit.",
        );
      assertAsset(op.image, options.verifiedAssets);
      if (source.inlineImage || op.target.from !== op.target.to)
        fail(
          "DOCUMENT_PASSAGE_TARGET_PROTECTED",
          "Inline insertion requires a text caret.",
        );
      const paragraph = passageParagraphLocation(
        next,
        op.target.blockId,
      ).paragraph;
      const index = paragraph.runs.findIndex((run) => run.id === source.id);
      const before = paragraph.runs[index]!;
      const image: DocumentRun = {
        id: fresh(op, "inline-image"),
        text: "",
        style: {},
        inlineImage: { ...op.image },
      };
      const runs: DocumentRun[] = [];
      if (op.target.from)
        runs.push({ ...before, text: before.text.slice(0, op.target.from) });
      runs.push(image);
      if (op.target.from < before.text.length)
        runs.push({
          ...before,
          id: op.target.from ? fresh(op, "inline-tail") : before.id,
          text: before.text.slice(op.target.from),
        });
      if (before.changeId)
        fail(
          "DOCUMENT_OBJECT_REVIEW_CONFLICT",
          "Resolve existing review before inserting an object inside that run.",
        );
      paragraph.runs.splice(index, 1, ...runs);
      if (op.target.from)
        lineage(
          op,
          source,
          op.target.blockId,
          runs[0],
          op.target.blockId,
          0,
          op.target.from,
        );
      mappingDrafts.push({
        op,
        source: op.target,
        target: { blockId: op.target.blockId, runId: image.id, from: 0, to: 1 },
        relation: "inserted",
      });
      if (op.target.from < before.text.length)
        lineage(
          op,
          source,
          op.target.blockId,
          runs[runs.length - 1],
          op.target.blockId,
          op.target.from,
          before.text.length,
        );
      continue;
    }
    if (op.kind === "paragraph-format") {
      assertParagraphSource(original, op.target, options.window);
      claim(`paragraph:${op.target.blockId}`);
      const paragraph = passageParagraphLocation(
        next,
        op.target.blockId,
      ).paragraph;
      assertEditable(
        next,
        paragraph,
        paragraph.runs.map((run) => run.id),
        options.actor,
        true,
      );
      const before = { ...paragraph.style };
      paragraph.style = patch(before, op.patch);
      if (
        tracking &&
        canonicalDocument(before) !== canonicalDocument(paragraph.style) &&
        !own(
          next.changes.find((change) => change.id === paragraph.changeId),
          options.actor,
        )
      )
        next.changes.push({
          ...attribute(),
          id: fresh(op, "paragraph-format-change"),
          kind: "paragraphFormat",
          targetRunIds: [],
          targetBlockIds: [paragraph.id],
          beforeParagraphStyle: before,
          afterParagraphStyle: { ...paragraph.style },
        });
      touched.blockIds.add(paragraph.id);
      continue;
    }
    if (op.kind === "paragraph-join") {
      assertParagraphSource(original, op.left, options.window);
      assertParagraphSource(original, op.right, options.window);
      if (
        passageBoundaryHash(original, op.left.blockId, op.right.blockId) !==
        op.boundaryHash
      )
        fail(
          "DOCUMENT_SOURCE_STALE",
          "The exact paragraph boundary changed.",
          412,
        );
      claim(`paragraph:${op.left.blockId}`);
      claim(`paragraph:${op.right.blockId}`);
      const left = passageParagraphLocation(next, op.left.blockId).paragraph;
      const right = passageParagraphLocation(next, op.right.blockId).paragraph;
      if (
        left.boundaryChangeId &&
        next.changes.find((change) => change.id === left.boundaryChangeId)
          ?.status === "pending"
      )
        fail(
          "DOCUMENT_BOUNDARY_HISTORY_REQUIRED",
          "An existing paragraph mark needs owned history preservation before re-editing.",
        );
      assertEditable(
        next,
        left,
        left.runs.map((run) => run.id),
        options.actor,
      );
      assertEditable(
        next,
        right,
        right.runs.map((run) => run.id),
        options.actor,
      );
      if (canonicalDocument(left.style) !== canonicalDocument(right.style))
        fail(
          "DOCUMENT_PASSAGE_STYLE_INCOMPATIBLE",
          "Joining incompatible paragraph properties requires explicit reconciliation.",
        );
      const record: DocumentChange = {
        ...attribute(),
        id: fresh(op, "join-change"),
        kind: "paragraphJoin",
        status: tracking ? attribute().status : "accepted",
        targetRunIds: [],
        targetBlockIds: [left.id, right.id],
      };
      left.boundaryChangeId = record.id;
      next.changes.push(record);
      touched.blockIds.add(left.id);
      touched.blockIds.add(right.id);
      touched.changeIds.add(record.id);
      continue;
    }
    if (op.kind === "resolve-change") {
      if (
        options.actor.origin === "ai" ||
        (options.actor.origin === "workflow" &&
          !options.actor.automatedResolutionApproved)
      )
        fail(
          "DOCUMENT_REVIEW_RESOLUTION_AUTHORITY_INVALID",
          "Authenticated review or existing authorized automation must resolve changes.",
        );
      if (!options.window.changeIds?.includes(op.changeId))
        fail(
          "DOCUMENT_PASSAGE_TARGET_OUTSIDE_WINDOW",
          "Review record was not disclosed.",
        );
      claim(`review:${op.changeId}`);
      const record = original.changes.find(
        (change) => change.id === op.changeId,
      );
      if (
        !record ||
        record.status !== "pending" ||
        operationSourceHash(record) !== op.changeHash ||
        passageReviewTargetHash(original, record) !== op.targetHash
      )
        fail(
          "DOCUMENT_REVIEW_TARGET_STALE",
          "The complete review record/target changed.",
        );
      if (
        operations.some(
          (other) =>
            other.id !== op.id &&
            (("target" in other &&
              "blockId" in other.target &&
              record.targetBlockIds?.includes(other.target.blockId)) ||
              ("target" in other &&
                "runId" in other.target &&
                record.targetRunIds.includes(other.target.runId))),
        )
      )
        fail(
          "DOCUMENT_REVIEW_RESOLUTION_SAVE_FIRST",
          "Save target edits separately before resolving their original review.",
        );
      if (passageReviewTargetHash(next, record) !== op.targetHash)
        fail(
          "DOCUMENT_REVIEW_RESOLUTION_SAVE_FIRST",
          "Save target edits separately before resolving their original review.",
        );
      next = resolveChange(next, record.id, op.decision);
      touched.changeIds.add(record.id);
      continue;
    }
    if (op.kind === "insert-paragraph") {
      assertPlacement(original,op.placement,options.window);
      claim(`placement:${op.placement.neighborId}`);
      const paragraph:DocumentParagraph={type:"paragraph",id:fresh(op,"paragraph"),style:{...op.style},runs:[{id:fresh(op,"paragraph-run"),text:"",style:{}}]};
      if(tracking){const change:DocumentChange={...attribute(),id:fresh(op,"paragraph-insertion"),kind:"paragraphInsertion",targetRunIds:[],targetBlockIds:[paragraph.id]};paragraph.changeId=change.id;next.changes.push(change);touched.changeIds.add(change.id);}
      const index=original.blocks.length===0?0:next.blocks.findIndex(block=>block.id===op.placement.neighborId)+(op.placement.side==="after"?1:0);
      next.blocks.splice(index,0,paragraph);touched.blockIds.add(paragraph.id);touched.runIds.add(paragraph.runs[0].id);continue;
    }
    if (tracking)
      fail(
        "DOCUMENT_OBJECT_TRACKING_UNSUPPORTED",
        "Table/object structure has no supported native Word revision semantics. Disable tracking explicitly for a direct edit.",
      );
    if ("placement" in op) {
      assertPlacement(original, op.placement, options.window);
      claim(`placement:${op.placement.neighborId}`);
      const index =
        next.blocks.findIndex((block) => block.id === op.placement.neighborId) +
        (op.placement.side === "after" ? 1 : 0);
      let block: ProserDocument["blocks"][number];
      if (op.kind === "insert-break")
        block = { type: "pageBreak", id: fresh(op, "page-break") };
      else if (op.kind === "insert-image") {
        assertAsset(op.image, options.verifiedAssets);
        block = { type: "image", id: fresh(op, "image"), ...op.image };
      } else if (op.kind === "insert-table") {
        block = {
          type: "table",
          id: fresh(op, "table"),
          widths: [...op.widths],
          rows: Array.from({ length: op.rows }, (_, row) => ({
            id: fresh(op, `row-${row}`),
            cells: op.widths.map((_, column) => ({
              id: fresh(op, `cell-${row}-${column}`),
              paragraphs: [
                {
                  type: "paragraph" as const,
                  id: fresh(op, `paragraph-${row}-${column}`),
                  style: {},
                  runs: [
                    {
                      id: fresh(op, `run-${row}-${column}`),
                      text: "",
                      style: {},
                    },
                  ],
                },
              ],
            })),
          })),
        };
      } else
        return fail(
          "DOCUMENT_PASSAGE_OPERATION_INVALID",
          "Unsupported placement intent.",
        );
      next.blocks.splice(index, 0, block);
      touched.objectIds.add(block.id);
      continue;
    }
    assertObject(original, op.target, options.window);
    claim(`object:${op.target.objectId}`);
    touched.objectIds.add(op.target.objectId);
    const block = next.blocks.find((block) => block.id === op.target.objectId);
    if (op.kind === "update-image") {
      assertAsset(op.image, options.verifiedAssets);
      if (block?.type === "image") Object.assign(block, op.image);
      else {
        const paragraph = bodyParagraphs(next).find((paragraph) =>
          paragraph.runs.some(
            (run) => run.id === op.target.objectId && run.inlineImage,
          ),
        );
        const run = paragraph?.runs.find(
          (run) => run.id === op.target.objectId,
        );
        if (!run?.inlineImage)
          fail(
            "DOCUMENT_PASSAGE_TARGET_PROTECTED",
            "Only an exact image can be updated.",
          );
        assertEditable(next, paragraph!, [run.id], options.actor, true);
        run.inlineImage = { ...op.image };
      }
      continue;
    }
    if (op.kind === "remove-object") {
      if (block) {
        if (block.type === "paragraph")
          fail(
            "DOCUMENT_PASSAGE_TARGET_PROTECTED",
            "Paragraph removal requires explicit canonical paragraph operations.",
          );
        if (block.type === "table")
          assertRemovedReview(
            next,
            block.rows.flatMap((row) =>
              row.cells.flatMap((cell) => cell.paragraphs),
            ),
          );
        next.blocks = next.blocks.filter((item) => item.id !== block.id);
      } else {
        const paragraph = bodyParagraphs(next).find((paragraph) =>
          paragraph.runs.some(
            (run) => run.id === op.target.objectId && run.inlineImage,
          ),
        );
        if (!paragraph)
          fail(
            "DOCUMENT_PASSAGE_TARGET_PROTECTED",
            "Only supported owned objects can be removed.",
          );
        assertEditable(next, paragraph, [op.target.objectId], options.actor);
        paragraph.runs = paragraph.runs.filter(
          (run) => run.id !== op.target.objectId,
        );
        if (!paragraph.runs.length)
          paragraph.runs = [
            { id: fresh(op, "object-empty-run"), text: "", style: {} },
          ];
      }
      continue;
    }
    if (block?.type !== "table")
      fail(
        "DOCUMENT_PASSAGE_TARGET_PROTECTED",
        "Table operations require an exact table object.",
      );
    if (op.kind === "table-widths") {
      if (op.widths.length !== block.widths.length)
        fail(
          "DOCUMENT_PASSAGE_TABLE_INVALID",
          "Resize preserves column count.",
        );
      block.widths = [...op.widths];
    } else if (op.kind === "table-insert-row") {
      if (!options.window.rowIds?.includes(op.rowId))
        fail(
          "DOCUMENT_PASSAGE_TARGET_OUTSIDE_WINDOW",
          "The selected row is outside the passage.",
        );
      const row = block.rows.findIndex((row) => row.id === op.rowId);
      if (row < 0) fail("DOCUMENT_SOURCE_STALE", "Row disappeared.", 412);
      block.rows.splice(row + (op.side === "after" ? 1 : 0), 0, {
        id: fresh(op, "new-row"),
        cells: block.widths.map((_, column) => ({
          id: fresh(op, `new-cell-${column}`),
          paragraphs: [
            {
              type: "paragraph",
              id: fresh(op, `new-paragraph-${column}`),
              style: {},
              runs: [
                { id: fresh(op, `new-run-${column}`), text: "", style: {} },
              ],
            },
          ],
        })),
      });
    } else if (op.kind === "table-remove-row") {
      const row = block.rows.find((row) => row.id === op.rowId);
      if (
        !row ||
        !options.window.rowIds?.includes(row.id) ||
        passageTableRowHash(row) !== op.rowHash
      )
        fail("DOCUMENT_SOURCE_STALE", "Exact row payload changed.", 412);
      if (block.rows.length === 1)
        fail(
          "DOCUMENT_PASSAGE_TABLE_INVALID",
          "Use explicit whole-table removal for its final row.",
        );
      assertRemovedReview(
        next,
        row.cells.flatMap((cell) => cell.paragraphs),
      );
      block.rows = block.rows.filter((item) => item.id !== row.id);
    } else if (op.kind === "table-insert-column") {
      if (op.column > block.widths.length)
        fail(
          "DOCUMENT_PASSAGE_TABLE_INVALID",
          "Column position exceeds this table.",
        );
      block.widths.splice(op.column, 0, op.width);
      for (const [rowIndex, row] of block.rows.entries())
        row.cells.splice(op.column, 0, {
          id: fresh(op, `column-cell-${rowIndex}`),
          paragraphs: [
            {
              type: "paragraph",
              id: fresh(op, `column-paragraph-${rowIndex}`),
              style: {},
              runs: [
                {
                  id: fresh(op, `column-run-${rowIndex}`),
                  text: "",
                  style: {},
                },
              ],
            },
          ],
        });
    } else if (op.kind === "table-remove-column") {
      if (
        op.column >= block.widths.length ||
        passageTableColumnHash(block, op.column) !== op.columnHash
      )
        fail("DOCUMENT_SOURCE_STALE", "Exact column payload changed.", 412);
      if (block.widths.length === 1)
        fail(
          "DOCUMENT_PASSAGE_TABLE_INVALID",
          "Use explicit whole-table removal for its final column.",
        );
      assertRemovedReview(
        next,
        block.rows.flatMap((row) => row.cells[op.column].paragraphs),
      );
      block.widths.splice(op.column, 1);
      for (const row of block.rows) row.cells.splice(op.column, 1);
    }
  }
  if (Buffer.byteLength(canonicalDocument(next)) > MAX_DOCUMENT_BYTES)
    fail("DOCUMENT_COMMIT_TOO_LARGE", "Scene exceeds 2 MiB.", 413);
  if (options.styles) validateDocumentStyleReferences(next, options.styles);
  next = parseCommentCandidateDocument(next);
  for (const change of next.changes)
    if (!original.changes.some((before) => before.id === change.id))
      touched.changeIds.add(change.id);
  for (const entry of mappingDrafts)
    if (entry.target) {
      touched.blockIds.add(entry.target.blockId);
      touched.runIds.add(entry.target.runId);
    }
  const operationMappings = mappingDrafts.map((entry) => {
    const old = sourceRun(original, entry.source);
    const oldText = old.inlineImage ? "\uFFFC" : old.text;
    const target = entry.target
      ? passageOperationRunSource(
          next,
          entry.target.blockId,
          entry.target.runId,
          entry.target.from,
          entry.target.to,
        )
      : undefined;
    const newRun = target ? sourceRun(next, target) : undefined;
    const newText = newRun?.inlineImage ? "\uFFFC" : newRun?.text;
    return {
      operationId: entry.op.id,
      kind: entry.op.kind,
      relation: entry.relation,
      source: entry.source,
      ...(target
        ? {
            target,
            targetTextHash: operationSourceHash(
              newText!.slice(target.from, target.to),
            ),
          }
        : {}),
      sourceTextHash: operationSourceHash(
        oldText.slice(entry.source.from, entry.source.to),
      ),
    };
  });
  return {
    document: next,
    anchorLineage,
    operationMappings,
    introducedIds,
    touched: Object.fromEntries(
      Object.entries(touched).map(([key, values]) => [key, [...values]]),
    ) as DocumentPassageOperationResult["touched"],
  };
}
