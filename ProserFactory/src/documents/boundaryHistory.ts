import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  canonicalDocument,
  paragraphsOf,
  type DocumentChange,
  type DocumentHistoricalBoundarySource,
  type ProserDocument,
} from "./model";
import { DocumentError } from "./errors";
import { validateDocument } from "./validation";
import { validateBookLayout } from "./scopeValidation";
import type { ReviewResolutionContext } from "./reviewResolution";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
const boundary = (change: DocumentChange) =>
  change.kind === "paragraphSplit" || change.kind === "paragraphJoin";
export const boundaryChangeHash = (change: DocumentChange) => {
  const { historicalBoundarySource: _source, ...record } = change;
  return hash(record);
};
/** The exact physical pair and container are proof, never matching quotations. */
export function boundaryTargetHash(
  document: ProserDocument,
  change: DocumentChange,
): string | undefined {
  const [left, right] = change.targetBlockIds ?? [];
  if (
    !boundary(change) ||
    !left ||
    !right ||
    change.targetBlockIds?.length !== 2
  )
    return undefined;
  const pair = (
    entries: Array<{ id: string; type?: string }>,
    place: unknown,
  ): string | undefined => {
    const index = entries.findIndex((entry) => entry.id === left);
    if (index < 0 || entries[index + 1]?.id !== right) return undefined;
    const paragraphs = new Map(
      paragraphsOf(document, true).map((paragraph) => [
        paragraph.id,
        paragraph,
      ]),
    );
    const a = paragraphs.get(left),
      b = paragraphs.get(right);
    return a?.boundaryChangeId === change.id && b
      ? hash({ place, paragraphs: [a, b] })
      : undefined;
  };
  const body = pair(document.blocks, "body");
  if (body) return body;
  const header = pair(document.layout.header, "header");
  if (header) return header;
  const footer = pair(document.layout.footer, "footer");
  if (footer) return footer;
  for (const block of document.blocks)
    if (block.type === "table")
      for (const row of block.rows)
        for (const cell of row.cells) {
          const target = pair(cell.paragraphs, {
            tableId: block.id,
            rowId: row.id,
            cellId: cell.id,
          });
          if (target) return target;
        }
  return undefined;
}
/** Called only after guarded source loading and existing attribution equality.
 * Historical source metadata is not an accept/reject decision or a new author. */
export function attestDetachedBoundary(
  next: ProserDocument,
  previous: ProserDocument | undefined,
  old: DocumentChange | undefined,
  change: DocumentChange,
  context?: ReviewResolutionContext,
) {
  if (
    canonicalDocument(change.historicalBoundarySource ?? null) !==
    canonicalDocument(old?.historicalBoundarySource ?? null)
  )
    throw new DocumentError(
      "DOCUMENT_BOUNDARY_HISTORY_INVALID",
      "Historical paragraph-boundary evidence is server-owned and cannot be supplied or rewritten.",
      422,
    );
  if (
    !old ||
    !boundary(old) ||
    old.status === "pending" ||
    old.historicalBoundarySource ||
    boundaryTargetHash(next, change)
  )
    return;
  const local =
    previous && boundaryTargetHash(previous, old)
      ? {
          document: previous,
          kind: context?.sourceKind,
          revisionId:
            context?.sourceKind === "scene"
              ? context.sourceSceneRevisionId
              : context?.sourceKind === "layout-story"
                ? context.sourceLayoutRevisionId
                : undefined,
          sceneId:
            context?.sourceKind === "scene" ? context.sourceSceneId : undefined,
          storyId:
            context?.sourceKind === "layout-story"
              ? context.sourceStoryId
              : undefined,
        }
      : undefined;
  const transfer = context?.sourceDocuments?.find(
    (source) =>
      source.document?.changes.some(
        (record) => canonicalDocument(record) === canonicalDocument(old),
      ) && boundaryTargetHash(source.document!, old),
  );
  const source =
    local ??
    (transfer?.document
      ? {
          document: transfer.document,
          kind: transfer.sourceKind ?? "scene",
          revisionId: transfer.revisionId,
          sceneId: "sceneId" in transfer ? transfer.sceneId : undefined,
          storyId: "storyId" in transfer ? transfer.storyId : undefined,
        }
      : undefined);
  if (
    !context ||
    !source?.revisionId ||
    !source.document ||
    (source.kind !== "scene" && source.kind !== "layout-story")
  )
    throw new DocumentError(
      "DOCUMENT_BOUNDARY_HISTORY_REQUIRED",
      "Re-editing a resolved paragraph mark requires its exact owned immutable source.",
      428,
    );
  const targetHash = boundaryTargetHash(source.document, old)!;
  const common = {
    sourceBookRevisionId: context.sourceBookRevisionId,
    sourceBookContentHash: context.sourceContentHash,
    sourceDocumentHash: hash(source.document),
    changeHash: boundaryChangeHash(old),
    targetHash,
  };
  const proof: DocumentHistoricalBoundarySource =
    source.kind === "scene"
      ? {
          ...common,
          sourceKind: "scene",
          sourceSceneId: source.sceneId!,
          sourceSceneRevisionId: source.revisionId,
        }
      : {
          ...common,
          sourceKind: "layout-story",
          sourceStoryId: source.storyId!,
          sourceLayoutRevisionId: source.revisionId,
        };
  change.historicalBoundarySource = proof;
}
/** Ownership and checksums are rechecked in the same guarded transaction. */
export async function assertOwnedBoundaryEvidence(
  tx: Prisma.TransactionClient,
  userId: number,
  bookId: number,
  documents: ProserDocument | ProserDocument[],
) {
  if (
    !(await tx.book.findFirst({
      where: { id: bookId, userId, deletedAt: {} },
      select: { id: true },
    }))
  )
    throw new DocumentError("DOCUMENT_SCOPE_NOT_FOUND", "Book not found.", 404);
  for (const document of Array.isArray(documents) ? documents : [documents])
    for (const change of document.changes) {
      const proof = change.historicalBoundarySource;
      if (!proof) continue;
      const invalid = () =>
        new DocumentError(
          "DOCUMENT_BOUNDARY_HISTORY_INVALID",
          "The exact owned historical paragraph-boundary source is unavailable or checksum-invalid.",
          409,
        );
      if (
        !boundary(change) ||
        change.status === "pending" ||
        boundaryChangeHash(change) !== proof.changeHash
      )
        throw invalid();
      const book = await tx.bookDocumentRevision.findFirst({
        where: { id: proof.sourceBookRevisionId, bookId },
      });
      if (
        !book ||
        book.contentHash !== proof.sourceBookContentHash ||
        hash(book.manifest) !== book.contentHash
      )
        throw invalid();
      const manifest = book.manifest as unknown as {
        scenes: Array<{ sceneId: number; revisionId: string }>;
        scopes: { layout: { revisionId: string } };
      };
      let source: ProserDocument;
      if (proof.sourceKind === "scene") {
        if (
          !manifest.scenes.some(
            (ref) =>
              ref.sceneId === proof.sourceSceneId &&
              ref.revisionId === proof.sourceSceneRevisionId,
          )
        )
          throw invalid();
        const row = await tx.sceneDocumentRevision.findFirst({
          where: {
            id: proof.sourceSceneRevisionId,
            sceneId: proof.sourceSceneId,
            bookId,
          },
        });
        if (
          !row ||
          row.contentHash !== proof.sourceDocumentHash ||
          hash(row.document) !== row.contentHash
        )
          throw invalid();
        source = validateDocument(row.document);
      } else {
        if (manifest.scopes.layout.revisionId !== proof.sourceLayoutRevisionId)
          throw invalid();
        const row = await tx.bookDocumentScopeRevision.findFirst({
          where: { id: proof.sourceLayoutRevisionId, bookId, kind: "layout" },
        });
        if (!row || hash(row.content) !== row.contentHash) throw invalid();
        const layout = validateBookLayout(row.content);
        const story = [
          ...layout.frontMatter,
          ...layout.backMatter,
          ...(layout.headerFooterStories ?? []),
        ].find((entry) => entry.id === proof.sourceStoryId);
        if (!story || hash(story.document) !== proof.sourceDocumentHash)
          throw invalid();
        source = validateDocument(story.document);
      }
      const original = source.changes.find((record) => record.id === change.id);
      if (
        !original ||
        original.historicalBoundarySource ||
        canonicalDocument(original) !==
          canonicalDocument(
            (({ historicalBoundarySource: _proof, ...record }) => record)(
              change,
            ),
          ) ||
        boundaryTargetHash(source, original) !== proof.targetHash
      )
        throw invalid();
    }
}
