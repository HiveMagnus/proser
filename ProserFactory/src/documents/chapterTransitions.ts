import { databaseService } from "@/lib/database";
import { documentService } from "./service";
import { assertStoryBookOwner, storyDigest } from "./storyProposalSources";
import { readScope } from "./scopes";
import { validateDocument } from "./validation";
import {
  paragraphsOf,
  projectDocument,
  visibleParagraph,
  visibleRun,
  canonicalDocument,
  minimalTextEdit,
} from "./model";
import { frozenTarget } from "./targets";
import { DocumentError } from "./errors";
import type {
  ChapterTransitionEdge,
  ChapterTransitions,
  DocumentDiscussionSnapshot,
  DocumentProposalOutput,
} from "./proposal-model";
import type { DocumentManifest } from "./model";

/** Read only the first three boundaries; never skip an empty chapter/edge scene. */
export async function readChapterTransitions(
  userId: number,
  bookId: number,
  revisionId?: string,
  endingChapterId?: number,
): Promise<ChapterTransitions> {
  const db = databaseService.client;
  await assertStoryBookOwner(db, userId, bookId);
  const current = await documentService.manifest(userId, bookId);
  const revision = await db.bookDocumentRevision.findFirst({
    where: { bookId, id: revisionId ?? current.revisionId },
  });
  if (!revision || storyDigest(revision.manifest) !== revision.contentHash)
    throw new DocumentError(
      "DOCUMENT_MANIFEST_INVALID",
      "Saved manuscript revision is unavailable or corrupt.",
      409,
    );
  const manifest = revision.manifest as unknown as DocumentManifest;
  if (!manifest.scopes)
    throw new DocumentError(
      "DOCUMENT_SCOPE_BACKFILL_REQUIRED",
      "Complete chapter structure is required.",
      409,
    );
  const structure = await readScope(
    db,
    bookId,
    "structure",
    manifest.scopes.structure,
  );
  const chapters = structure.acts
    .filter((act) => !act.deletedAt)
    .sort((a, b) => a.actNumber - b.actNumber || a.id - b.id)
    .flatMap((act) =>
      structure.chapters
        .filter((chapter) => chapter.actId === act.id && !chapter.deletedAt)
        .sort((a, b) => a.chapterNumber - b.chapterNumber || a.id - b.id)
        .map((chapter) => ({ ...chapter, actNumber: act.actNumber })),
    );
  const edge = async (
    chapter: (typeof chapters)[number],
    last: boolean,
  ): Promise<ChapterTransitionEdge> => {
    const result: ChapterTransitionEdge = {
      chapterId: chapter.id,
      label: `Act ${chapter.actNumber} · Chapter ${chapter.chapterNumber}${chapter.title ? ": " + chapter.title : ""}`,
      text: "",
      truncated: false,
    };
    const scenes = structure.scenes
      .filter((scene) => scene.chapterId === chapter.id && !scene.deletedAt)
      .sort((a, b) => a.sceneNumber - b.sceneNumber || a.id - b.id);
    const scene = last ? scenes.at(-1) : scenes[0];
    if (!scene) return result;
    const ref = manifest.scenes.find((item) => item.sceneId === scene.id);
    if (!ref)
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Chapter boundary is missing from the saved manifest.",
        409,
      );
    const row = await db.sceneDocumentRevision.findFirst({
      where: { bookId, sceneId: scene.id, id: ref.revisionId },
    });
    if (
      !row ||
      row.contentHash !== ref.contentHash ||
      storyDigest(row.document) !== ref.contentHash
    )
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Chapter boundary revision is unavailable or corrupt.",
        409,
      );
    const document = validateDocument(row.document),
      text = projectDocument(document).text;
    // Code point slices retain the literal terminal glyph and never split a surrogate pair.
    const points = Array.from(text),
      limit = 1800;
    Object.assign(result, {
      sceneId: scene.id,
      sceneRevisionId: ref.revisionId,
      contentHash: ref.contentHash,
      text: (last ? points.slice(-limit) : points.slice(0, limit)).join(""),
      truncated: points.length > limit,
    });
    if (!last) {
      const paragraph = paragraphsOf(document).find(
        (p) =>
          visibleParagraph(p, document.changes, "final") &&
          p.runs.some(
            (r) =>
              visibleRun(r, document.changes, "final") &&
              (r.text.trim() || r.inlineImage),
          ),
      );
      if (paragraph) {
        const sourceText = paragraph.runs
          .filter((r) => visibleRun(r, document.changes, "final"))
          .map((r) => (r.inlineImage ? "\ufffc" : r.text))
          .join("");
        // Legacy generated scenes may contain a whole scene in one paragraph.
        // Select its literal opening sentence while retaining the full frozen
        // paragraph identity; never invent paragraph breaks to enable review.
        let selectedText = sourceText.length <= 1200 ? sourceText : "";
        if (!selectedText) {
          let candidate = "";
          for (const segment of new Intl.Segmenter("en", {
            granularity: "sentence",
          }).segment(sourceText)) {
            candidate += segment.segment;
            const text = candidate.trimEnd();
            if (text.length > 1200) break;
            // ICU may split a proper name such as St. Jude's at its title.
            if (
              !/(?:\b(?:St|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Rev|Gen|Sen|Rep)|\b[ap]\.m|\b[A-Z])\.["”']?$/i.test(
                text,
              )
            ) {
              selectedText = text;
              break;
            }
          }
        }
        if (selectedText.length <= 1200 && selectedText.trim()) {
          const target = {
            blockId: paragraph.id,
            from: 0,
            to: selectedText.length,
            sourceText: selectedText,
          };
          const frozen = frozenTarget(document, target);
          if (frozen.editable) result.target = target;
        }
      }
    }
    return result;
  };
  const pairs = chapters
    .slice(0, -1)
    .map((chapter, index) => ({ chapter, next: chapters[index + 1]! }));
  const selected =
    endingChapterId === undefined
      ? pairs.slice(0, 3)
      : pairs.filter((pair) => pair.chapter.id === endingChapterId);
  const transitions = [];
  for (const { chapter, next } of selected)
    transitions.push({
      bookRevisionId: revision.id,
      ending: await edge(chapter, true),
      opening: await edge(next, false),
    });
  return {
    bookId,
    bookTitle: structure.book.title ?? `Book ${bookId}`,
    bookRevisionId: revision.id,
    chapterCount: chapters.length,
    transitions,
  };
}

export function assertTransitionRevision(
  snapshot: Pick<
    DocumentDiscussionSnapshot,
    "transition" | "sourceBookRevisionId"
  >,
  revisionId: string,
) {
  if (snapshot.transition && snapshot.sourceBookRevisionId !== revisionId)
    throw new DocumentError(
      "DOCUMENT_TARGET_STALE",
      "This transition changed. Refresh both chapter boundaries and prepare a new review.",
      409,
    );
}

export function verifyTransitionOutput(
  snapshot: Pick<DocumentDiscussionSnapshot, "transition" | "targets">,
  output: DocumentProposalOutput,
) {
  if (!snapshot.transition) return;
  if (
    !/Continuity/i.test(output.reply) ||
    !/Momentum/i.test(output.reply) ||
    !/Reason to keep reading/i.test(output.reply) ||
    output.edits.length !== 1
  )
    throw new DocumentError(
      "DOCUMENT_PROPOSAL_INVALID",
      "Transition review requires continuity, momentum, a reason to keep reading, and one small revision.",
      422,
    );
  const edit = output.edits[0]!,
    target = snapshot.targets[0];
  if (
    !target ||
    edit.targetId !== target.targetId ||
    edit.sourceText !== target.sourceText ||
    edit.replacement === edit.sourceText
  )
    throw new DocumentError(
      "DOCUMENT_PROPOSAL_INVALID",
      "Transition revision must preserve its exact source identity.",
      422,
    );
  const diff = minimalTextEdit(edit.sourceText, edit.replacement);
  if (
    diff.end - diff.start + diff.replacement.length > 600 ||
    edit.replacement.includes("\n") ||
    canonicalDocument(edit.replacement).length > 1800
  )
    throw new DocumentError(
      "DOCUMENT_PROPOSAL_INVALID",
      "Transition revision exceeds the small single-paragraph edit budget.",
      422,
    );
}
