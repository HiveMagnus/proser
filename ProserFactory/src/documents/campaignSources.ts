import type { Prisma, PrismaClient } from "@prisma/client";
import { readScope } from "./scopes";
import { orderedSceneReferences } from "./scope-model";
import type { DocumentManifest } from "./model";
import { paragraphsOf, visibleParagraph } from "./model";
import { paragraphText, frozenTarget } from "./targets";
import { validateDocument } from "./validation";
import { storyDigest } from "./storyProposalSources";
import { DocumentError } from "./errors";
import type {
  CampaignCitation,
  CampaignConstraints,
  CampaignCoverage,
} from "./campaign-model";
export type CampaignClient = Prisma.TransactionClient | PrismaClient;
export interface CampaignSnapshot {
  bookRevisionId: string;
  scanScope?: "passage";
  manifest: DocumentManifest;
  threadHash: string;
  preset?: string;
  directions?: Array<{ decision: string; reason: string; stepId?: string }>;
  goal: string;
  constraints: CampaignConstraints;
  confirmed: boolean;
  boundaries: Array<{
    endingChapterId: number;
    openingChapterId: number;
    ending?: CampaignCitation;
    opening?: CampaignCitation;
  }>;
  threads: Array<{
    id: number;
    question: string | null;
    status: string;
    notes: string | null;
    version: number;
    evidence: Array<{
      id: string;
      stage: string;
      sceneId?: number;
      sceneRevisionId?: string;
      text?: string;
      blockIds: string[];
      stale: boolean;
    }>;
  }>;
  canon: Awaited<ReturnType<typeof readCanon>>;
  scenes: Array<{
    sceneId: number;
    chapterId: number;
    sceneRevisionId: string;
    contentHash: string;
  }>;
}
const readCanon = (
  tx: CampaignClient,
  bookId: number,
  manifest: DocumentManifest,
) => readScope(tx, bookId, "canon", manifest.scopes!.canon);
export async function campaignThreads(tx: CampaignClient, bookId: number) {
  const threads = await tx.plotThread.findMany({
    where: { bookId },
    orderBy: { id: "asc" },
  });
  const evidence = await tx.plotThreadEvidence.findMany({
    where: { bookId },
    orderBy: { id: "asc" },
  });
  return { threads, evidence };
}
export async function captureCampaignSource(
  tx: CampaignClient,
  bookId: number,
  goal: string,
  constraints: CampaignConstraints,
  confirmed: boolean,
): Promise<CampaignSnapshot> {
  const head = await tx.bookDocumentHead.findUniqueOrThrow({
    where: { bookId },
  });
  const row = await tx.bookDocumentRevision.findFirstOrThrow({
    where: { bookId, id: head.revisionId },
  });
  if (storyDigest(row.manifest) !== row.contentHash)
    throw new DocumentError(
      "DOCUMENT_MANIFEST_INVALID",
      "Campaign source checksum is invalid.",
      503,
    );
  const manifest = row.manifest as unknown as DocumentManifest;
  if (!manifest.scopes)
    throw new DocumentError(
      "DOCUMENT_SCOPE_BACKFILL_REQUIRED",
      "Campaigns require complete canonical scopes.",
      409,
    );
  const structure = await readScope(
    tx,
    bookId,
    "structure",
    manifest.scopes.structure,
  );
  const acts = new Set(
    structure.acts.filter((x) => !x.deletedAt).map((x) => x.id),
  );
  const chapters = new Set(
    structure.chapters
      .filter((x) => !x.deletedAt && acts.has(x.actId))
      .map((x) => x.id),
  );
  const threads = await campaignThreads(tx, bookId);
  const ordered = orderedSceneReferences(manifest.scenes, structure).filter(
    (x) => !x.deletedAt && chapters.has(x.chapterId),
  );
  const chapterOrder = structure.acts
    .filter((x) => !x.deletedAt)
    .sort((a, b) => a.actNumber - b.actNumber || a.id - b.id)
    .flatMap((act) =>
      structure.chapters
        .filter((x) => x.actId === act.id && !x.deletedAt)
        .sort((a, b) => a.chapterNumber - b.chapterNumber || a.id - b.id),
    );
  const edge = async (
    chapterId: number,
    last: boolean,
  ): Promise<CampaignCitation | undefined> => {
    const refs = ordered.filter((x) => x.chapterId === chapterId),
      ref = last ? refs.at(-1) : refs[0];
    if (!ref) return;
    const saved = await tx.sceneDocumentRevision.findFirst({
      where: { bookId, sceneId: ref.sceneId, id: ref.revisionId },
    });
    if (!saved || storyDigest(saved.document) !== ref.contentHash) return;
    const document = validateDocument(saved.document),
      paragraphs = paragraphsOf(document).filter(
        (x) =>
          visibleParagraph(x, document.changes, "final") &&
          paragraphText(x, document).trim(),
      );
    const paragraph = last ? paragraphs.at(-1) : paragraphs[0];
    if (!paragraph) return;
    const text = paragraphText(paragraph, document),
      segments = Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          text,
        ),
      );
    const quote = (last ? segments.slice(-400) : segments.slice(0, 400))
      .map((x) => x.segment)
      .join("");
    const from = last ? text.length - quote.length : 0;
    return {
      sceneId: ref.sceneId,
      sceneRevisionId: ref.revisionId,
      blockId: paragraph.id,
      from,
      to: from + quote.length,
      quote,
    };
  };
  const boundaries: CampaignSnapshot["boundaries"] = [];
  for (let index = 0; index < chapterOrder.length - 1; index++)
    boundaries.push({
      endingChapterId: chapterOrder[index].id,
      openingChapterId: chapterOrder[index + 1].id,
      ending: await edge(chapterOrder[index].id, true),
      opening: await edge(chapterOrder[index + 1].id, false),
    });
  return {
    bookRevisionId: row.id,
    scanScope: "passage",
    manifest,
    goal,
    constraints,
    confirmed,
    boundaries,
    canon: await readCanon(tx, bookId, manifest),
    threadHash: storyDigest(threads),
    threads: threads.threads
      .filter((x) => !x.archivedAt)
      .map((thread) => ({
        id: thread.id,
        question: thread.question,
        status: thread.status,
        notes: thread.notes,
        version: thread.version,
        evidence: threads.evidence
          .filter((x) => x.threadId === thread.id && !x.removedAt)
          .map((x) => {
            const source = x.source as {
              frame?: {
                sceneId?: number;
                sceneRevisionId?: string;
                layoutScope?: { contentHash: string };
                structureScope?: { contentHash: string };
              };
              text?: string;
              targets?: Array<{ blockId: string }>;
            };
            return {
              id: x.id,
              stage: x.stage,
              sceneId: source.frame?.sceneId,
              sceneRevisionId: source.frame?.sceneRevisionId,
              text: source.text,
              blockIds: (source.targets ?? []).map((target) => target.blockId),
              stale:
                ordered.find((ref) => ref.sceneId === source.frame?.sceneId)
                  ?.revisionId !== source.frame?.sceneRevisionId ||
                source.frame?.layoutScope?.contentHash !==
                  manifest.scopes!.layout.contentHash ||
                source.frame?.structureScope?.contentHash !==
                  manifest.scopes!.structure.contentHash,
            };
          }),
      })),
    scenes: orderedSceneReferences(manifest.scenes, structure)
      .filter((x) => !x.deletedAt && chapters.has(x.chapterId))
      .map((x) => ({
        sceneId: x.sceneId,
        chapterId: x.chapterId,
        sceneRevisionId: x.revisionId,
        contentHash: x.contentHash,
      })),
  };
}
export async function assertCampaignSource(
  tx: CampaignClient,
  bookId: number,
  snapshot: CampaignSnapshot,
) {
  const head = await tx.bookDocumentHead.findUniqueOrThrow({
    where: { bookId },
  });
  if (
    head.revisionId !== snapshot.bookRevisionId ||
    storyDigest(await campaignThreads(tx, bookId)) !== snapshot.threadHash
  )
    throw new DocumentError(
      "REVISION_CAMPAIGN_STALE",
      "The manuscript, canon, layout or plot evidence changed. Explicitly refresh and approve a new plan.",
      412,
    );
}
export async function verifyCampaignCitation(
  tx: CampaignClient,
  bookId: number,
  snapshot: CampaignSnapshot,
  citation: CampaignCitation,
) {
  let ref = snapshot.scenes.find(
    (x) =>
      x.sceneId === citation.sceneId &&
      x.sceneRevisionId === citation.sceneRevisionId,
  );
  if (
    !ref &&
    [...snapshot.constraints.facts, ...snapshot.constraints.voice].some(
      (rule) =>
        rule.citations.some(
          (saved) => storyDigest(saved) === storyDigest(citation),
        ),
    )
  ) {
    const historical = await tx.sceneDocumentRevision.findFirst({
      where: {
        bookId,
        sceneId: citation.sceneId,
        id: citation.sceneRevisionId,
      },
    });
    if (historical)
      ref = {
        sceneId: citation.sceneId,
        chapterId: 0,
        sceneRevisionId: historical.id,
        contentHash: historical.contentHash,
      };
  }
  if (!ref)
    throw new DocumentError(
      "REVISION_CAMPAIGN_CITATION_INVALID",
      "Citation is outside the frozen active manuscript.",
      422,
    );
  const row = await tx.sceneDocumentRevision.findFirst({
    where: { bookId, sceneId: ref.sceneId, id: ref.sceneRevisionId },
  });
  if (!row || storyDigest(row.document) !== ref.contentHash)
    throw new DocumentError(
      "REVISION_CAMPAIGN_CITATION_INVALID",
      "Citation source is unavailable or corrupt.",
      422,
    );
  const target = frozenTarget(validateDocument(row.document), {
    blockId: citation.blockId,
    from: citation.from,
    to: citation.to,
    sourceText: citation.quote,
  });
  return target;
}
export async function campaignChunks(
  tx: CampaignClient,
  bookId: number,
  snapshot: CampaignSnapshot,
  maxBytes = 8000,
) {
  const chunks: Array<{
    coverage: CampaignCoverage;
    citation?: CampaignCitation;
  }> = [];
  for (const ref of snapshot.scenes) {
    const base = { ...ref, blockId: "", from: 0, to: 0 };
    const row = await tx.sceneDocumentRevision.findFirst({
      where: { bookId, sceneId: ref.sceneId, id: ref.sceneRevisionId },
    });
    if (!row || storyDigest(row.document) !== ref.contentHash) {
      chunks.push({
        coverage: {
          ...base,
          status: "unavailable",
          reason: "Saved scene revision unavailable or corrupt.",
        },
      });
      continue;
    }
    const document = validateDocument(row.document);
    let nonempty = false;
    for (const paragraph of paragraphsOf(document).filter((x) =>
      visibleParagraph(x, document.changes, "final"),
    )) {
      const text = paragraphText(paragraph, document);
      if (!text.trim()) continue;
      nonempty = true;
      let from = 0,
        segment = "";
      const push = () => {
        const citation = {
          sceneId: ref.sceneId,
          sceneRevisionId: ref.sceneRevisionId,
          blockId: paragraph.id,
          from,
          to: from + segment.length,
          quote: segment,
        };
        chunks.push({
          coverage: {
            ...base,
            blockId: paragraph.id,
            from,
            to: citation.to,
            status: "reviewed",
          },
          citation,
        });
        from += segment.length;
        segment = "";
      };
      for (const { segment: grapheme } of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(text)) {
        if (Buffer.byteLength(grapheme) > maxBytes)
          throw new DocumentError(
            "REVISION_CAMPAIGN_GRAPHEME_TOO_LARGE",
            "A Unicode grapheme exceeds the scan budget; it was not split.",
            413,
          );
        if (Buffer.byteLength(segment + grapheme) > maxBytes) push();
        segment += grapheme;
      }
      if (segment) push();
    }
    if (!nonempty) chunks.push({ coverage: { ...base, status: "empty" } });
  }
  return chunks;
}
