import type { Prisma, PrismaClient } from "@prisma/client";
import { DocumentError } from "./errors";
import { readScope } from "./scopes";
import { passageHash } from "./passageProjection";
import type {
  DocumentManifest,
  DocumentLayout,
  SceneDocumentReference,
} from "./model";
import type { DocumentStyleDefinitions } from "./style-model";
import type { DocumentPassageSourceFrame } from "./passage-model";
export interface PassageOwnedContext {
  sourceFrame: DocumentPassageSourceFrame;
  layout: DocumentLayout;
  styles: DocumentStyleDefinitions;
}
/** Called only after owned-book authorization; all scope contents are immutable
 * and checksum-verified. Scene.layout is not the saved layout authority. */
export async function readPassageOwnedContext(
  tx: Prisma.TransactionClient | PrismaClient,
  bookId: number,
  bookRevisionId: string,
  manifest: DocumentManifest,
  reference: SceneDocumentReference,
): Promise<PassageOwnedContext> {
  if (!manifest.scopes)
    throw new DocumentError(
      "DOCUMENT_SCOPE_BACKFILL_REQUIRED",
      "Complete owned scopes are required for passage editing.",
      409,
    );
  const structure = await readScope(
    tx,
    bookId,
    "structure",
    manifest.scopes.structure,
  );
  const layout = await readScope(tx, bookId, "layout", manifest.scopes.layout);
  const scene = structure.scenes.find(
    (scene) => scene.id === reference.sceneId && !scene.deletedAt,
  );
  const chapter = structure.chapters.find(
    (chapter) => chapter.id === scene?.chapterId && !chapter.deletedAt,
  );
  const act = structure.acts.find(
    (act) => act.id === chapter?.actId && !act.deletedAt,
  );
  if (
    !scene ||
    !chapter ||
    !act ||
    reference.chapterId !== chapter.id ||
    reference.sceneNumber !== scene.sceneNumber
  )
    throw new DocumentError(
      "DOCUMENT_TARGET_STALE",
      "Passage source has no exact owned Book/Act/Chapter/Scene membership.",
      409,
    );
  const effective = layout.chapters[String(chapter.id)] ?? layout.book;
  const stories = ["header", "footer"].map(
    (kind) =>
      layout.headerFooterStories?.find(
        (story) =>
          story.owner === "chapter" &&
          story.chapterId === chapter.id &&
          story.kind === kind,
      ) ??
      layout.headerFooterStories?.find(
        (story) => story.owner === "book" && story.kind === kind,
      ) ??
      null,
  );
  return {
    sourceFrame: {
      bookId,
      actId: act.id,
      chapterId: chapter.id,
      sceneId: scene.id,
      bookRevisionId,
      bookContentHash: passageHash(manifest),
      sceneRevisionId: reference.revisionId,
      sceneContentHash: reference.contentHash,
      qualifiedMembershipHash: passageHash({
        bookId,
        actId: act.id,
        actNumber: act.actNumber,
        actTitle: act.title,
        chapterId: chapter.id,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title,
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        bookTitle: structure.book.title,
      }),
      structureScope: { ...manifest.scopes.structure },
      layoutScope: { ...manifest.scopes.layout },
      effectiveStyleLayoutHash: passageHash({
        layout: effective,
        styles: layout.styles,
        stories,
      }),
      projection: "final",
    },
    layout: effective,
    styles: layout.styles,
  };
}
