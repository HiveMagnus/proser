import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  canonicalDocument,
  type DocumentManifest,
  type ProserDocument,
} from "./model";
import type { BookLayoutSnapshot } from "./scope-model";
import type { DocumentPassageOperation } from "./passage-operations-model";
import { readScope } from "./scopes";
import { DocumentError } from "./errors";
import { validateDocument } from "./validation";
import { applyPassageOperations } from "./passageOperations";
import { operationSourceHash } from "./passageOperationSources";
import { assertOwnedStyleReferences } from "./styleAuthority";
import { currentDocumentMutationContext } from "@/services/documentMutationContext";
export const storyDigest = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
type Client = PrismaClient | Prisma.TransactionClient;
export function exactLayoutStory(layout: BookLayoutSnapshot, storyId: string) {
  const choices = [
    ...(layout.headerFooterStories ?? []).map((story) => ({
      story,
      identity: {
        collection: "header-footer",
        id: story.id,
        kind: story.kind,
        owner: story.owner,
        chapterId: story.chapterId ?? null,
      },
    })),
    ...layout.frontMatter.map((story, ordinal) => ({
      story,
      identity: {
        collection: "front-matter",
        id: story.id,
        name: story.name,
        ordinal,
        chapterId: null,
      },
    })),
    ...layout.backMatter.map((story, ordinal) => ({
      story,
      identity: {
        collection: "back-matter",
        id: story.id,
        name: story.name,
        ordinal,
        chapterId: null,
      },
    })),
  ].filter((item) => item.story.id === storyId);
  if (!choices.length)
    throw new DocumentError(
      "DOCUMENT_STORY_NOT_FOUND",
      "Owned layout story not found.",
      404,
    );
  if (choices.length !== 1)
    throw new DocumentError(
      "DOCUMENT_STORY_SOURCE_AMBIGUOUS",
      "Story identity has multiple containers; reconcile its owned layout first.",
      409,
    );
  return choices[0];
}
export async function assertStoryBookOwner(
  tx: Client,
  userId: number,
  bookId: number,
) {
  if (
    (currentDocumentMutationContext()?.userId !== undefined &&
      currentDocumentMutationContext()!.userId !== userId) ||
    !(await tx.book.findFirst({
      where: { id: bookId, userId, deletedAt: null },
      select: { id: true },
    }))
  )
    throw new DocumentError("DOCUMENT_SCOPE_NOT_FOUND", "Book not found.", 404);
}
export async function ownedStorySource(
  tx: Client,
  userId: number,
  bookId: number,
  storyId: string,
  bookRevisionId?: string,
) {
  await assertStoryBookOwner(tx, userId, bookId);
  const head = await tx.bookDocumentHead.findUnique({ where: { bookId } });
  if (!head)
    throw new DocumentError(
      "DOCUMENT_NOT_MIGRATED",
      "Book document authority is not initialized.",
      503,
    );
  const revision = await tx.bookDocumentRevision.findFirst({
    where: { id: bookRevisionId ?? head.revisionId, bookId },
  });
  if (!revision || storyDigest(revision.manifest) !== revision.contentHash)
    throw new DocumentError(
      "DOCUMENT_MANIFEST_INVALID",
      "Owned source manifest is unavailable or checksum-invalid.",
      409,
    );
  const manifest = revision.manifest as unknown as DocumentManifest;
  if (!manifest.scopes)
    throw new DocumentError(
      "DOCUMENT_SCOPE_BACKFILL_REQUIRED",
      "Owned story source requires complete scope revisions.",
      409,
    );
  const layout = await readScope(tx, bookId, "layout", manifest.scopes.layout),
    structure = await readScope(
      tx,
      bookId,
      "structure",
      manifest.scopes.structure,
    );
  const item = exactLayoutStory(layout, storyId);
  const chapter =
    item.identity.chapterId === null
      ? undefined
      : structure.chapters.find(
          (entry) => entry.id === item.identity.chapterId && !entry.deletedAt,
        );
  const act = chapter
    ? structure.acts.find(
        (entry) => entry.id === chapter.actId && !entry.deletedAt,
      )
    : undefined;
  if (item.identity.chapterId !== null && (!chapter || !act))
    throw new DocumentError(
      "DOCUMENT_TARGET_STALE",
      "The owned story chapter/act container is no longer active.",
      409,
    );
  const document = validateDocument(item.story.document);
  assertOwnedStyleReferences(document, layout.styles);
  const ownerContextHash = storyDigest({
    bookId,
    story: item.identity,
    bookTitle: structure.book.title,
    chapter: chapter
      ? {
          id: chapter.id,
          actId: chapter.actId,
          chapterNumber: chapter.chapterNumber,
          title: chapter.title,
        }
      : null,
    act: act
      ? { id: act.id, actNumber: act.actNumber, title: act.title }
      : null,
    effectiveLayout: chapter
      ? (layout.chapters[String(chapter.id)] ?? layout.book)
      : layout.book,
    styles: layout.styles,
  });
  return {
    bookId,
    bookRevisionId: revision.id,
    bookContentHash: revision.contentHash,
    layoutRevisionId: manifest.scopes.layout.revisionId,
    layoutContentHash: manifest.scopes.layout.contentHash,
    contentHash: storyDigest(document),
    ownerContextHash,
    document,
    layout,
    manifest,
    storyId,
  };
}
export type OwnedStorySource = Awaited<ReturnType<typeof ownedStorySource>>;
export function deriveStoryDraft(
  source: OwnedStorySource,
  local: { operationId: string; operations: DocumentPassageOperation[] },
  userId: number,
): ProserDocument {
  if (Buffer.byteLength(JSON.stringify(local)) > 256 * 1024)
    throw new DocumentError(
      "DOCUMENT_DRAFT_TOO_LARGE",
      "Unsaved story context intentions exceed 256 KiB.",
      413,
    );
  if (
    local.operations.some(
      (operation) =>
        !["text", "run-format", "paragraph-format"].includes(operation.kind),
    )
  )
    throw new DocumentError(
      "DOCUMENT_DRAFT_REQUIRES_SAVE",
      "Save story structure, protected objects and review changes before preparing context.",
      409,
    );
  const result = applyPassageOperations(source.document, local.operations, {
    operationId: local.operationId,
    sourceFrame: {
      sourceKind: "layout-story",
      bookId: source.bookId,
      storyId: source.storyId,
      bookRevisionId: source.bookRevisionId,
      layoutRevisionId: source.layoutRevisionId,
      contentHash: source.contentHash,
      projection: "final",
    },
    actor: {
      id: userId,
      name: String(userId),
      createdAt: "2000-01-01T00:00:00.000Z",
      origin: "manual",
    },
    tracking: false,
    styles: source.layout.styles,
    window: {
      runs: local.operations.flatMap((operation) =>
        operation.kind === "text" || operation.kind === "run-format"
          ? [operation.target]
          : [],
      ),
      paragraphIds: local.operations.flatMap((operation) =>
        operation.kind === "paragraph-format" ? [operation.target.blockId] : [],
      ),
    },
  });
  if (
    operationSourceHash(result.document.changes) !==
      operationSourceHash(source.document.changes) ||
    operationSourceHash(result.document.comments) !==
      operationSourceHash(source.document.comments)
  )
    throw new DocumentError(
      "DOCUMENT_DRAFT_REQUIRES_SAVE",
      "Save story review changes before preparing unsaved context.",
      409,
    );
  return result.document;
}
export function replaceStoryDocument(
  layout: BookLayoutSnapshot,
  storyId: string,
  document: ProserDocument,
): BookLayoutSnapshot {
  const next = structuredClone(layout);
  exactLayoutStory(next, storyId).story.document = document;
  return next;
}
