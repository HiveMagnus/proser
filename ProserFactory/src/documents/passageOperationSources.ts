import { createHash } from "node:crypto";
import {
  canonicalDocument,
  type ProserDocument,
  type DocumentParagraph,
  type DocumentRun,
  type DocumentBlock,
  type DocumentChange,
} from "./model";
import { DocumentError } from "./errors";
import type {
  PassageParagraphSource,
  PassageRunSource,
  PassageObjectSource,
  PassageBodyPlacement,
  PassageChangeSummary,
} from "./passage-operations-model";
export const operationSourceHash = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
export interface PassageParagraphLocation {
  paragraph: DocumentParagraph;
  container: DocumentBlock[] | DocumentParagraph[];
  containerHash: string;
  kind: "body" | "table-cell";
  tableId?: string;
  rowId?: string;
  cellId?: string;
}
export function passageParagraphLocation(
  document: ProserDocument,
  blockId: string,
): PassageParagraphLocation {
  const body = document.blocks.find(
    (block) => block.type === "paragraph" && block.id === blockId,
  );
  if (body?.type === "paragraph")
    return {
      paragraph: body,
      container: document.blocks,
      containerHash: operationSourceHash({
        kind: "body",
        blocks: document.blocks.map((block) => ({
          id: block.id,
          type: block.type,
        })),
      }),
      kind: "body",
    };
  for (const table of document.blocks)
    if (table.type === "table")
      for (const row of table.rows)
        for (const cell of row.cells) {
          const paragraph = cell.paragraphs.find((item) => item.id === blockId);
          if (paragraph)
            return {
              paragraph,
              container: cell.paragraphs,
              containerHash: operationSourceHash({
                kind: "table-cell",
                tableId: table.id,
                widths: table.widths,
                rows: table.rows.map((row) => ({
                  id: row.id,
                  cells: row.cells.map((cell) => ({
                    id: cell.id,
                    paragraphIds: cell.paragraphs.map(
                      (paragraph) => paragraph.id,
                    ),
                  })),
                })),
                rowId: row.id,
                cellId: cell.id,
              }),
              kind: "table-cell",
              tableId: table.id,
              rowId: row.id,
              cellId: cell.id,
            };
        }
  throw new DocumentError(
    "DOCUMENT_PASSAGE_TARGET_INVALID",
    "Paragraph is not in the owned body/table container.",
    409,
  );
}
export function passageParagraphMetadataHash(paragraph: DocumentParagraph) {
  const { runs: _runs, ...metadata } = paragraph;
  return operationSourceHash(metadata);
}
export function passageOperationParagraphSource(
  document: ProserDocument,
  blockId: string,
): PassageParagraphSource {
  const located = passageParagraphLocation(document, blockId);
  return {
    blockId,
    paragraphHash: passageParagraphMetadataHash(located.paragraph),
    containerHash: located.containerHash,
  };
}
export function passageOperationRunSource(
  document: ProserDocument,
  blockId: string,
  runId: string,
  from = 0,
  to?: number,
): PassageRunSource {
  const paragraph = passageParagraphLocation(document, blockId).paragraph;
  const run = paragraph.runs.find((run) => run.id === runId);
  if (!run)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_TARGET_INVALID",
      "Stable run is not in this paragraph.",
      409,
    );
  return {
    ...passageOperationParagraphSource(document, blockId),
    runId,
    sourceHash: operationSourceHash(run),
    from,
    to: to ?? (run.inlineImage ? 1 : run.text.length),
  };
}
export function passageOperationObjectSource(
  document: ProserDocument,
  objectId: string,
): PassageObjectSource {
  const body = document.blocks.find((block) => block.id === objectId);
  if (body)
    return {
      objectId,
      sourceHash: operationSourceHash(body),
      containerHash: operationSourceHash({
        kind: "body",
        blocks: document.blocks.map((block) => ({
          id: block.id,
          type: block.type,
        })),
      }),
    };
  for (const paragraph of bodyParagraphs(document)) {
    const run = paragraph.runs.find(
      (run) => run.id === objectId && run.inlineImage,
    );
    if (run)
      return {
        objectId,
        sourceHash: operationSourceHash(run),
        containerHash: passageParagraphLocation(document, paragraph.id)
          .containerHash,
      };
  }
  throw new DocumentError(
    "DOCUMENT_PASSAGE_TARGET_INVALID",
    "Object identity is unavailable.",
    409,
  );
}
export function passageOperationPlacement(
  document: ProserDocument,
  neighborId: string,
  side: "before" | "after",
): PassageBodyPlacement {
  const neighbor = document.blocks.find((block) => block.id === neighborId);
  if (!neighbor)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_TARGET_INVALID",
      "Placement requires an exact body neighbor.",
      409,
    );
  return {
    neighborId,
    side,
    neighborHash: operationSourceHash(neighbor),
    containerHash: operationSourceHash({
      kind: "body",
      blocks: document.blocks.map((block) => ({
        id: block.id,
        type: block.type,
      })),
    }),
  };
}
export function bodyParagraphs(document: ProserDocument) {
  return document.blocks.flatMap((block) =>
    block.type === "paragraph"
      ? [block]
      : block.type === "table"
        ? block.rows.flatMap((row) =>
            row.cells.flatMap((cell) => cell.paragraphs),
          )
        : [],
  );
}
export function passageBoundaryHash(
  document: ProserDocument,
  left: string,
  right: string,
) {
  const location = passageParagraphLocation(document, left);
  const position = location.container.findIndex((block) => block.id === left);
  if (location.container[position + 1]?.id !== right)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_BOUNDARY_STALE",
      "Paragraphs are not adjacent in the same physical container.",
      409,
    );
  return operationSourceHash({
    left: passageOperationParagraphSource(document, left),
    right: passageOperationParagraphSource(document, right),
    marker: location.paragraph.boundaryChangeId,
    change: document.changes.find(
      (change) => change.id === location.paragraph.boundaryChangeId,
    ),
  });
}
export function passageReviewTargetHash(
  document: ProserDocument,
  change: DocumentChange,
) {
  return operationSourceHash({
    change,
    runs: bodyParagraphs(document).flatMap((paragraph) =>
      paragraph.runs
        .filter((run) => change.targetRunIds.includes(run.id))
        .map((run) => ({
          paragraphId: paragraph.id,
          paragraphHash: passageParagraphMetadataHash(paragraph),
          containerHash: passageParagraphLocation(document, paragraph.id)
            .containerHash,
          run,
        })),
    ),
    paragraphs: bodyParagraphs(document)
      .filter((paragraph) => change.targetBlockIds?.includes(paragraph.id))
      .map((paragraph) => ({
        paragraph,
        containerHash: passageParagraphLocation(document, paragraph.id)
          .containerHash,
      })),
  });
}
export function passageChangeSummary(
  document: ProserDocument,
  changeId: string,
  visibleRunIds: ReadonlySet<string>,
  visibleBlockIds: ReadonlySet<string>,
): PassageChangeSummary {
  const change = document.changes.find((change) => change.id === changeId);
  if (!change)
    throw new DocumentError(
      "DOCUMENT_REVIEW_TARGET_STALE",
      "Change not found.",
      409,
    );
  const runs = change.targetRunIds.filter((id) => visibleRunIds.has(id));
  const blocks = (change.targetBlockIds ?? []).filter((id) =>
    visibleBlockIds.has(id),
  );
  return {
    id: change.id,
    kind: change.kind,
    status: change.status,
    authorId: change.authorId,
    authorName: change.authorName,
    origin: change.origin,
    createdAt: change.createdAt,
    recordHash: operationSourceHash(change),
    targetHash: passageReviewTargetHash(document, change),
    targetRunCount: change.targetRunIds.length,
    targetBlockCount: change.targetBlockIds?.length ?? 0,
    resolutionCount: change.resolutionHistory?.length ?? 0,
    visibleRunIds: runs,
    visibleBlockIds: blocks,
    continuedOutsideWindow:
      runs.length < change.targetRunIds.length ||
      blocks.length < (change.targetBlockIds?.length ?? 0),
  };
}
export function passageTableRowHash(row: {
  id: string;
  cells: Array<{ id: string; paragraphs: DocumentParagraph[] }>;
}) {
  return operationSourceHash(row);
}
export function passageTableColumnHash(
  table: Extract<DocumentBlock, { type: "table" }>,
  column: number,
) {
  return operationSourceHash({
    column,
    width: table.widths[column],
    cells: table.rows.map((row) => ({
      rowId: row.id,
      cell: row.cells[column],
    })),
  });
}
export function sourceRun(
  document: ProserDocument,
  target: PassageRunSource,
): DocumentRun {
  const run = passageParagraphLocation(
    document,
    target.blockId,
  ).paragraph.runs.find((run) => run.id === target.runId);
  if (!run)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_TARGET_INVALID",
      "Stable run is unavailable.",
      409,
    );
  return run;
}

/** Refresh only exact output identities after authenticated server stamping.
 * A changed/missing output span is a conflict, never a quotation relocation. */
export function refreshPassageOperationMappings(
  document: ProserDocument,
  mappings: import("./passage-operations-model").PassageOperationMapping[],
): import("./passage-operations-model").PassageOperationMapping[] {
  return mappings.map((mapping) => {
    if (!mapping.target) return structuredClone(mapping);
    const target = passageOperationRunSource(
      document,
      mapping.target.blockId,
      mapping.target.runId,
      mapping.target.from,
      mapping.target.to,
    );
    const run = sourceRun(document, target);
    const text = run.inlineImage ? "\uFFFC" : run.text;
    if (
      target.from < 0 ||
      target.to < target.from ||
      target.to > text.length ||
      operationSourceHash(text.slice(target.from, target.to)) !==
        mapping.targetTextHash
    )
      throw new DocumentError(
        "DOCUMENT_PASSAGE_MAPPING_STALE",
        "Committed output no longer contains the exact operation span.",
        409,
      );
    return { ...mapping, target };
  });
}

/** The caller separately verifies the captured owned revision. Never return
 * unbounded authenticated resolution histories in a passage response. */
export function passageReviewHistoryPage(
  document: ProserDocument,
  request: import("./passage-operations-model").PassageReviewPageRequest,
): import("./passage-operations-model").PassageReviewPage {
  const record = document.changes.find(
    (change) => change.id === request.changeId,
  );
  if (!record || operationSourceHash(record) !== request.recordHash)
    throw new DocumentError(
      "DOCUMENT_REVIEW_TARGET_STALE",
      "Review record changed.",
      412,
    );
  const offset = request.offset ?? 0,
    limit = request.limit ?? 16;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 32
  )
    throw new DocumentError(
      "DOCUMENT_PASSAGE_PAGE_INVALID",
      "Invalid bounded history page.",
      422,
    );
  const history = record.resolutionHistory ?? [];
  if (offset > history.length)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_PAGE_INVALID",
      "History offset exceeds the immutable record.",
      422,
    );
  const items = structuredClone(history.slice(offset, offset + limit));
  if (Buffer.byteLength(canonicalDocument(items)) > 128 * 1024)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_PAGE_TOO_LARGE",
      "History page exceeds 128 KiB; reduce its limit.",
      413,
    );
  const nextOffset = offset + items.length;
  return {
    changeId: record.id,
    recordHash: request.recordHash,
    offset,
    total: history.length,
    items,
    ...(nextOffset < history.length ? { nextOffset } : {}),
  };
}

/** A transient placement token for an empty immutable body; never a canonical ID. */
export const EMPTY_BODY_NEIGHBOR = 'empty-body';
export function emptyPassageBodyPlacement():PassageBodyPlacement {
 return {neighborId:EMPTY_BODY_NEIGHBOR,side:'after',neighborHash:operationSourceHash([]),containerHash:operationSourceHash({kind:'body',blocks:[]})};
}
