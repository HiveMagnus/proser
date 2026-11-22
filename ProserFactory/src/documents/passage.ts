import {
  readPassageOwnedContext,
  type PassageOwnedContext,
} from "./passageSource";
import type { Prisma } from "@prisma/client";
import { databaseService } from "@/lib/database";
import { DocumentError } from "./errors";
import { documentService } from "./service";
import { type DocumentManifest } from "./model";
import { validateDocument } from "./validation";
import {
  documentPassage,
  applyPassageEdits,
  passageHash,
  committedPassageCursor,
} from "./passageProjection";
import type {
  DocumentPassageRequest,
  DocumentPassageCommit,
  DocumentPassageReceipt,
  DocumentPassageRestoreResult,
} from "./passage-model";
import {
  documentPassageCommitSchema,
  documentPassageRestoreSchema,
} from "./passageValidation";
async function ownedSource(
  userId: number,
  bookId: number,
  sceneId: number,
  bookRevisionId?: string,
) {
  const current = await documentService.manifest(userId, bookId);
  const revision = await databaseService.client.bookDocumentRevision.findFirst({
    where: { id: bookRevisionId ?? current.revisionId, bookId },
  });
  if (!revision)
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Pinned book revision is unavailable.",
      412,
    );
  const manifest = revision.manifest as unknown as DocumentManifest;
  if (passageHash(manifest) !== revision.contentHash)
    throw new DocumentError(
      "DOCUMENT_SOURCE_INVALID",
      "Pinned manifest checksum is invalid.",
      409,
    );
  const ref = manifest.scenes.find(
    (scene) => scene.sceneId === sceneId && !scene.deletedAt,
  );
  if (!ref)
    throw new DocumentError(
      "DOCUMENT_SCENE_NOT_FOUND",
      "Scene is not in the owned manifest.",
      404,
    );
  const row = await databaseService.client.sceneDocumentRevision.findFirst({
    where: { id: ref.revisionId, bookId, sceneId },
  });
  if (
    !row ||
    row.contentHash !== ref.contentHash ||
    passageHash(row.document) !== row.contentHash
  )
    throw new DocumentError(
      "DOCUMENT_SOURCE_INVALID",
      "Scene checksum differs from its manifest.",
      409,
    );
  return {
    document: validateDocument(row.document),
    owned: await readPassageOwnedContext(
      databaseService.client,
      bookId,
      revision?.id ?? current.revisionId,
      manifest,
      ref,
    ),
    source: {
      bookRevisionId: revision?.id ?? current.revisionId,
      sceneId,
      sceneRevisionId: ref.revisionId,
      contentHash: ref.contentHash,
    },
  };
}
export async function readDocumentPassage(
  userId: number,
  bookId: number,
  sceneId: number,
  input: DocumentPassageRequest,
) {
  const { document, source, owned } = await ownedSource(
    userId,
    bookId,
    sceneId,
    input.bookRevisionId,
  );
  return documentPassage(document, source, input, owned);
}
export async function passageContext(
  tx: Prisma.TransactionClient | import("@prisma/client").PrismaClient,
  bookId: number,
  bookRevisionId: string,
  sceneId: number,
  sceneRevisionId: string,
  contentHash: string,
) {
  const book = await tx.bookDocumentRevision.findFirst({
    where: { id: bookRevisionId, bookId },
  });
  if (!book || passageHash(book.manifest) !== book.contentHash)
    throw new DocumentError(
      "DOCUMENT_SOURCE_INVALID",
      "Pinned passage manifest is unavailable or checksum-invalid.",
      409,
    );
  const manifest = book.manifest as unknown as DocumentManifest;
  const reference = manifest.scenes.find(
    (scene) => scene.sceneId === sceneId && !scene.deletedAt,
  );
  if (
    !reference ||
    reference.revisionId !== sceneRevisionId ||
    reference.contentHash !== contentHash
  )
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Scene passage does not match the pinned book revision.",
      412,
    );
  return readPassageOwnedContext(
    tx,
    bookId,
    bookRevisionId,
    manifest,
    reference,
  );
}
export function committedContext(
  owned: PassageOwnedContext,
  revisionId: string,
  manifest: DocumentManifest,
  scene: { revisionId: string; contentHash: string },
): PassageOwnedContext {
  return {
    ...owned,
    sourceFrame: {
      ...owned.sourceFrame,
      bookRevisionId: revisionId,
      bookContentHash: passageHash(manifest),
      sceneRevisionId: scene.revisionId,
      sceneContentHash: scene.contentHash,
    },
  };
}
export async function commitDocumentPassage(
  userId: number,
  bookId: number,
  sceneId: number,
  input: DocumentPassageCommit,
): Promise<DocumentPassageReceipt> {
  if (
    !input.operationId ||
    !input.expectedRevisionId ||
    !input.expectedSceneRevisionId ||
    !input.windowHash
  )
    throw new DocumentError(
      "DOCUMENT_PRECONDITION_REQUIRED",
      "Book, scene, passage and operation preconditions are required.",
      428,
    );
  const parsed = documentPassageCommitSchema.safeParse(input);
  if (!parsed.success)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_INVALID",
      "Invalid bounded passage commit.",
      422,
    );
  input = parsed.data;
  return documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId,
      expectedScopes: {},
      payload: { kind: "scene-passage", sceneId, ...input },
    },
    async (tx) => {
      const row = await tx.sceneDocumentRevision.findFirst({
        where: { id: input.expectedSceneRevisionId, bookId, sceneId },
      });
      if (!row || passageHash(row.document) !== row.contentHash)
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "Scene passage source is unavailable.",
          412,
        );
      const document = validateDocument(row.document);
      const source = {
        bookRevisionId: input.expectedRevisionId,
        sceneId,
        sceneRevisionId: row.id,
        contentHash: row.contentHash,
      };
      const owned = await passageContext(
        tx,
        bookId,
        input.expectedRevisionId,
        sceneId,
        row.id,
        row.contentHash,
      );
      const window = documentPassage(document, source, input, owned);
      const actor = input.tracking
        ? await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: { username: true },
          })
        : undefined;
      const changed = applyPassageEdits(
        document,
        window,
        input,
        input.tracking
          ? {
              authorId: userId,
              authorName: actor?.username ?? String(userId),
              createdAt: new Date().toISOString(),
              status: "pending",
              origin: "manual",
            }
          : undefined,
      );
      return {
        result: window,
        changedDocuments: [
          { sceneId, expectedRevisionId: row.id, document: changed },
        ],
        receiptProjection: "references",
        projectCommitted: ({ revisionId, scenes, manifest }) => {
          const saved = scenes.find((scene) => scene.sceneId === sceneId)!;
          return documentPassage(
            saved.document,
            {
              bookRevisionId: revisionId,
              sceneId,
              sceneRevisionId: saved.revisionId,
              contentHash: saved.contentHash,
            },
            {
              ...input,
              cursor: committedPassageCursor(saved.document, input.cursor),
            },
            committedContext(owned, revisionId, manifest, saved),
          );
        },
      };
    },
  );
}
export async function restoreDocumentPassage(
  userId: number,
  bookId: number,
  sceneId: number,
  input: import("./passage-model").DocumentPassageRestore,
): Promise<DocumentPassageReceipt<DocumentPassageRestoreResult>> {
  if (
    !input.operationId ||
    !input.expectedRevisionId ||
    !input.expectedSceneRevisionId ||
    !input.windowHash
  )
    throw new DocumentError(
      "DOCUMENT_PRECONDITION_REQUIRED",
      "Book, scene, passage and operation preconditions are required.",
      428,
    );
  const parsed = documentPassageRestoreSchema.safeParse(input);
  if (!parsed.success)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_INVALID",
      "Invalid bounded restoration request.",
      422,
    );
  input = parsed.data;
  return documentService.mutateCatalog(
    userId,
    bookId,
    {
      operationId: input.operationId,
      expectedRevisionId: input.expectedRevisionId,
      expectedScopes: {},
      payload: { kind: "restore-scene-passage", sceneId, ...input },
    },
    async (tx) => {
      const current = await tx.sceneDocumentRevision.findFirst({
        where: { id: input.expectedSceneRevisionId, bookId, sceneId },
      });
      if (!current || passageHash(current.document) !== current.contentHash)
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "Current passage source is unavailable.",
          412,
        );
      const owned = await passageContext(
        tx,
        bookId,
        input.expectedRevisionId,
        sceneId,
        current.id,
        current.contentHash,
      );
      const window = documentPassage(
        validateDocument(current.document),
        {
          bookRevisionId: input.expectedRevisionId,
          sceneId,
          sceneRevisionId: current.id,
          contentHash: current.contentHash,
        },
        input,
        owned,
      );
      if (window.windowHash !== input.windowHash)
        throw new DocumentError(
          "DOCUMENT_SOURCE_STALE",
          "Current passage source changed.",
          412,
        );
      const restored = await tx.sceneDocumentRevision.findFirst({
        where: { id: input.restoreFromRevisionId, bookId, sceneId },
      });
      if (!restored || passageHash(restored.document) !== restored.contentHash)
        throw new DocumentError(
          "DOCUMENT_RESTORATION_INVALID",
          "Complete owned immutable scene restoration source is unavailable.",
          409,
        );
      const document = validateDocument(restored.document);
      const restoredCursor = input.restoreCursor ?? { paragraph: 0, offset: 0 };
      documentPassage(
        document,
        {
          bookRevisionId: input.expectedRevisionId,
          sceneId,
          sceneRevisionId: restored.id,
          contentHash: restored.contentHash,
        },
        { ...input, cursor: restoredCursor },
      );
      return {
        result: { restoredFromRevisionId: restored.id, passage: window },
        changedDocuments: [
          {
            sceneId,
            expectedRevisionId: current.id,
            document,
            restoreFromRevisionId: restored.id,
          },
        ],
        receiptProjection: "references",
        projectCommitted: ({ revisionId, scenes, manifest }) => {
          const saved = scenes.find((scene) => scene.sceneId === sceneId)!;
          return {
            restoredFromRevisionId: restored.id,
            passage: documentPassage(
              saved.document,
              {
                bookRevisionId: revisionId,
                sceneId,
                sceneRevisionId: saved.revisionId,
                contentHash: saved.contentHash,
              },
              { ...input, cursor: restoredCursor },
              committedContext(owned, revisionId, manifest, saved),
            ),
          };
        },
      };
    },
  );
}
