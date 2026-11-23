import { documentAuthorityEnabled } from "@/documents/capabilities";
import {
  exportCanonicalBook,
  readPublicationArtifact,
} from "@/documents/publication";
import { DocumentError } from "@/documents/errors";
import type { DocumentPublicationFidelity } from "@/documents/publication-model";
import { requirePublicationPreconditions } from "@/documents/publicationValidation";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { databaseService } from "@/lib/database";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizeFilename } from "@/services/exportService";
import { resolveInside } from "@/lib/safePath";

export type ExportArtifactScope = "book" | "chapter" | "scene";

export interface CreateExportArtifactOptions {
  format?: "markdown";
  includeCodex?: boolean;
  includeMetadata?: boolean;
  includeSummaries?: boolean;
}

export interface CanonicalExportArtifactOptions extends CreateExportArtifactOptions {
  operationId?: string;
  expectedRevisionId?: string;
  mode?: "retain-review" | "final" | "original";
  preset?: "saved" | "submission-manuscript" | "print-book";
}
interface ArtifactRange {
  start: number;
  end: number;
}

interface SceneRange extends ArtifactRange {
  id: number;
  sceneNumber: number;
  title: string | null;
  wordCount: number;
}

interface ChapterRange extends ArtifactRange {
  id: number;
  actNumber: number;
  chapterNumber: number;
  title: string | null;
  wordCount: number;
  scenes: SceneRange[];
}

interface ExportArtifactManifest {
  artifactId: string;
  bookId: number;
  userId: number;
  bookTitle: string;
  format: "markdown";
  filename: string;
  byteSize: number;
  charCount: number;
  wordCount: number;
  sha256: string;
  sourceFingerprint: string;
  createdAt: string;
  options: Required<CreateExportArtifactOptions>;
  fidelity?: DocumentPublicationFidelity;
  sourceRevisionId?: string;
  operationId?: string;
  reviewSidecarPath?: string;
  chapters: ChapterRange[];
}

export interface ExportArtifactSummary {
  artifactId: string;
  bookId: number;
  bookTitle: string;
  format: "markdown";
  filename: string;
  byteSize: number;
  charCount: number;
  wordCount: number;
  sha256: string;
  createdAt: string;
  options: Required<CreateExportArtifactOptions>;
  fidelity?: DocumentPublicationFidelity;
  sourceRevisionId?: string;
  operationId?: string;
  reviewSidecarPath?: string;
  downloadPath: string;
  readPath: string;
  tableOfContents: Array<{
    id: number;
    actNumber: number;
    chapterNumber: number;
    title: string | null;
    wordCount: number;
    scenes: Array<{
      id: number;
      sceneNumber: number;
      title: string | null;
      wordCount: number;
    }>;
  }>;
}

export interface ReadExportArtifactOptions {
  scope: ExportArtifactScope;
  actNumber?: number;
  chapterId?: number;
  chapterNumber?: number;
  sceneId?: number;
  sceneNumber?: number;
  offset?: number;
  maxChars?: number;
}

export interface ExportArtifactReadResult {
  artifactId: string;
  scope: ExportArtifactScope;
  selection: {
    bookId: number;
    bookTitle: string;
    actNumber?: number;
    chapterId?: number;
    chapterNumber?: number;
    chapterTitle?: string | null;
    sceneId?: number;
    sceneNumber?: number;
    sceneTitle?: string | null;
  };
  content: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
  truncated: boolean;
  nextOffset: number | null;
}

interface StoredArtifact {
  manifest: ExportArtifactManifest;
  markdownPath: string;
  manifestPath: string;
}

interface RevisionRecord {
  id: number;
  updatedAt: Date | null;
}

interface RevisionSource extends RevisionRecord {
  acts: Array<
    RevisionRecord & {
      chapters: Array<RevisionRecord & { scenes: RevisionRecord[] }>;
    }
  >;
  codexEntries: RevisionRecord[];
}

const countWords = (value: string): number =>
  value.trim().split(/\s+/).filter(Boolean).length;

function artifactRoot(): string {
  return path.resolve(
    process.env.EXPORT_ARTIFACT_DIR ||
      path.join(process.cwd(), "data", "exports"),
  );
}

function artifactDirectory(userId: number, bookId: number): string {
  return resolveInside(artifactRoot(), String(userId), String(bookId));
}

function revisionFingerprint(
  source: RevisionSource,
  includeCodex: boolean,
): string {
  const revision = {
    book: [source.id, source.updatedAt?.toISOString() || null],
    acts: source.acts.map((act) => [
      act.id,
      act.updatedAt?.toISOString() || null,
      act.chapters.map((chapter) => [
        chapter.id,
        chapter.updatedAt?.toISOString() || null,
        chapter.scenes.map((scene) => [
          scene.id,
          scene.updatedAt?.toISOString() || null,
        ]),
      ]),
    ]),
    codex: includeCodex
      ? source.codexEntries.map((entry) => [
          entry.id,
          entry.updatedAt?.toISOString() || null,
        ])
      : [],
  };
  return createHash("sha256").update(JSON.stringify(revision)).digest("hex");
}

async function currentSourceFingerprint(
  userId: number,
  bookId: number,
  includeCodex: boolean,
): Promise<string> {
  const source = await databaseService.client.book.findFirst({
    where: { id: bookId, userId, deletedAt: null },
    select: {
      id: true,
      updatedAt: true,
      acts: {
        orderBy: { actNumber: "asc" },
        select: {
          id: true,
          updatedAt: true,
          chapters: {
            orderBy: { chapterNumber: "asc" },
            select: {
              id: true,
              updatedAt: true,
              scenes: {
                where: { deletedAt: null },
                orderBy: { sceneNumber: "asc" },
                select: { id: true, updatedAt: true },
              },
            },
          },
        },
      },
      codexEntries: {
        where: includeCodex ? { deletedAt: null } : { id: -1 },
        orderBy: [{ entryType: "asc" }, { entryName: "asc" }],
        select: { id: true, updatedAt: true },
      },
    },
  });
  if (!source) throw new NotFoundError("Book not found");
  return revisionFingerprint(source, includeCodex);
}

function assertArtifactId(artifactId: string): void {
  if (!/^[a-f0-9]{64}$/.test(artifactId))
    throw new ValidationError("Invalid export artifact ID");
}

function summary(manifest: ExportArtifactManifest): ExportArtifactSummary {
  const base = `/api/books/${manifest.bookId}/export-artifacts/${manifest.artifactId}`;
  return {
    artifactId: manifest.artifactId,
    ...(manifest.fidelity ? { fidelity: manifest.fidelity } : {}),
    ...(manifest.sourceRevisionId
      ? { sourceRevisionId: manifest.sourceRevisionId }
      : {}),
    ...(manifest.operationId ? { operationId: manifest.operationId } : {}),
    ...(manifest.reviewSidecarPath
      ? { reviewSidecarPath: manifest.reviewSidecarPath }
      : {}),
    bookId: manifest.bookId,
    bookTitle: manifest.bookTitle,
    format: manifest.format,
    filename: manifest.filename,
    byteSize: manifest.byteSize,
    charCount: manifest.charCount,
    wordCount: manifest.wordCount,
    sha256: manifest.sha256,
    createdAt: manifest.createdAt,
    options: manifest.options,
    downloadPath: `${base}/download`,
    readPath: `${base}/read`,
    tableOfContents: manifest.chapters.map((chapter) => ({
      id: chapter.id,
      actNumber: chapter.actNumber,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      wordCount: chapter.wordCount,
      scenes: chapter.scenes.map((scene) => ({
        id: scene.id,
        sceneNumber: scene.sceneNumber,
        title: scene.title,
        wordCount: scene.wordCount,
      })),
    })),
  };
}

async function loadStoredArtifact(
  userId: number,
  bookId: number,
  artifactId: string,
  preservedHistory = false,
): Promise<StoredArtifact> {
  assertArtifactId(artifactId);
  const directory = artifactDirectory(userId, bookId);
  const manifestPath = resolveInside(directory, `${artifactId}.json`);
  const markdownPath = resolveInside(directory, `${artifactId}.md`);
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as ExportArtifactManifest;
    if (
      parsed.userId !== userId ||
      parsed.bookId !== bookId ||
      parsed.artifactId !== artifactId
    ) {
      throw new NotFoundError("Export artifact not found");
    }
    const bytes = await fs.readFile(markdownPath);
    if (
      parsed.sha256 !== artifactId ||
      parsed.format !== "markdown" ||
      parsed.byteSize !== bytes.length ||
      createHash("sha256").update(bytes).digest("hex") !== artifactId
    )
      throw new DocumentError(
        "PUBLICATION_ARTIFACT_INVALID",
        "Preserved original export checksum is invalid.",
        503,
      );
    if (preservedHistory) {
      if (
        !(await databaseService.client.book.findFirst({
          where: { id: bookId, userId, deletedAt: {} },
          select: { id: true },
        }))
      )
        throw new NotFoundError("Export artifact not found");
      return { manifest: parsed, markdownPath, manifestPath };
    }
    const currentFingerprint = await currentSourceFingerprint(
      userId,
      bookId,
      parsed.options.includeCodex,
    );
    if (parsed.sourceFingerprint !== currentFingerprint) {
      throw new NotFoundError(
        "Export artifact is stale; create a fresh export",
      );
    }
    return { manifest: parsed, markdownPath, manifestPath };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof DocumentError)
      throw error;
    throw new NotFoundError("Export artifact not found");
  }
}

function pickChapter(
  manifest: ExportArtifactManifest,
  options: ReadExportArtifactOptions,
): ChapterRange {
  let matches = manifest.chapters;
  if (options.chapterId !== undefined)
    matches = matches.filter((item) => item.id === options.chapterId);
  if (options.chapterNumber !== undefined)
    matches = matches.filter(
      (item) => item.chapterNumber === options.chapterNumber,
    );
  if (options.actNumber !== undefined)
    matches = matches.filter((item) => item.actNumber === options.actNumber);
  if (!matches.length)
    throw new NotFoundError("Chapter not found in export artifact");
  if (matches.length > 1)
    throw new ValidationError(
      "Chapter selector is ambiguous; provide chapterId or actNumber",
    );
  return matches[0];
}

function pickScene(
  manifest: ExportArtifactManifest,
  options: ReadExportArtifactOptions,
): { chapter: ChapterRange; scene: SceneRange } {
  const candidates = manifest.chapters.flatMap((chapter) =>
    chapter.scenes.map((scene) => ({ chapter, scene })),
  );
  let matches = candidates;
  if (options.sceneId !== undefined)
    matches = matches.filter((item) => item.scene.id === options.sceneId);
  if (options.sceneNumber !== undefined)
    matches = matches.filter(
      (item) => item.scene.sceneNumber === options.sceneNumber,
    );
  if (options.chapterId !== undefined)
    matches = matches.filter((item) => item.chapter.id === options.chapterId);
  if (options.chapterNumber !== undefined)
    matches = matches.filter(
      (item) => item.chapter.chapterNumber === options.chapterNumber,
    );
  if (options.actNumber !== undefined)
    matches = matches.filter(
      (item) => item.chapter.actNumber === options.actNumber,
    );
  if (!matches.length)
    throw new NotFoundError("Scene not found in export artifact");
  if (matches.length > 1)
    throw new ValidationError(
      "Scene selector is ambiguous; provide sceneId or chapter and act selectors",
    );
  return matches[0];
}

async function activeStoredArtifact(
  userId: number,
  bookId: number,
  artifactId: string,
) {
  const checksumAddress = /^[a-f0-9]{64}$/.test(artifactId);
  if (!checksumAddress && !/^[a-f0-9-]{36}$/.test(artifactId))
    throw new DocumentError(
      "PUBLICATION_NOT_FOUND",
      "Export artifact not found.",
      404,
    );
  if (checksumAddress) {
    // Preserve an existing immutable checksum-addressed original first. Its
    // metadata is historical evidence, independent of the current manuscript.
    try {
      const legacy = await loadStoredArtifact(userId, bookId, artifactId, true);
      const bytes = await fs.readFile(legacy.markdownPath);
      return {
        manifest: legacy.manifest,
        content: bytes.toString("utf8"),
        bytes,
      };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  let publicationId = artifactId;
  if (checksumAddress) {
    const candidates =
      await databaseService.client.documentPublicationArtifact.findMany({
        where: {
          bookId,
          userId,
          sha256: artifactId,
          provenance: { path: ["options", "format"], equals: "markdown" },
        },
        select: { id: true },
        take: 2,
      });
    if (!candidates.length)
      throw new DocumentError(
        "PUBLICATION_NOT_FOUND",
        "Export artifact not found.",
        404,
      );
    if (candidates.length !== 1)
      throw new DocumentError(
        "PUBLICATION_ARTIFACT_ALIAS_AMBIGUOUS",
        "Multiple immutable publication revisions share these bytes. Use the exact publication artifact UUID to inspect provenance.",
        409,
      );
    publicationId = candidates[0].id;
  }
  const row = await readPublicationArtifact(userId, bookId, publicationId);
  const provenance = row.provenance as {
    sourceRevisionId?: string;
    fidelity?: { losses?: string[]; wordAcceptance?: string };
    fontSubstitutions?: Array<{ requested: string; actual: string }>;
    title: string;
    options: { format: string };
    markdownIndex: Array<{
      sceneId?: number;
      sceneNumber?: number;
      chapterId?: number;
      chapterNumber?: number;
      actNumber?: number;
      title: string;
      start: number;
      end: number;
      wordCount: number;
    }>;
  };
  if (provenance.options.format !== "markdown")
    throw new DocumentError(
      "PUBLICATION_NOT_FOUND",
      "Markdown artifact not found.",
      404,
    );
  const content = Buffer.from(row.bytes).toString("utf8");
  const chapters: ChapterRange[] = [];
  for (const section of provenance.markdownIndex) {
    if (section.sceneId === undefined || section.chapterId === undefined)
      continue;
    let chapter = chapters.find((item) => item.id === section.chapterId);
    if (!chapter) {
      chapter = {
        id: section.chapterId,
        actNumber: section.actNumber ?? 1,
        chapterNumber: section.chapterNumber ?? 1,
        title: section.title,
        wordCount: 0,
        start: section.start,
        end: section.end,
        scenes: [],
      };
      chapters.push(chapter);
    }
    chapter.end = section.end;
    chapter.wordCount += section.wordCount;
    chapter.scenes.push({
      id: section.sceneId,
      sceneNumber: section.sceneNumber ?? 1,
      title: null,
      wordCount: section.wordCount,
      start: section.start,
      end: section.end,
    });
  }
  const manifest: ExportArtifactManifest = {
    artifactId: checksumAddress ? row.sha256 : row.id,
    bookId,
    userId,
    bookTitle: provenance.title,
    format: "markdown",
    filename: row.filename,
    byteSize: row.byteLength,
    charCount: content.length,
    wordCount: chapters.reduce(
      (count, chapter) => count + chapter.wordCount,
      0,
    ),
    sha256: row.sha256,
    sourceFingerprint: (row.provenance as { sourceHash: string }).sourceHash,
    createdAt: row.createdAt.toISOString(),
    options: {
      format: "markdown",
      includeCodex: false,
      includeMetadata: false,
      includeSummaries: false,
    },
    chapters,
  };
  manifest.operationId = row.publicationId;
  manifest.sourceRevisionId = provenance.sourceRevisionId;
  manifest.reviewSidecarPath = `/api/books/${bookId}/document-publication-artifacts/${row.id}/review`;
  if (provenance.fidelity)
    manifest.fidelity = {
      losses: provenance.fidelity.losses ?? [],
      fontSubstitutions: provenance.fontSubstitutions ?? [],
      wordAcceptance: provenance.fidelity.wordAcceptance ?? "unverified",
    };
  return { row, content, manifest, bytes: row.bytes };
}
export class ExportArtifactService {
  static async create(
    userId: number,
    bookId: number,
    rawOptions: CanonicalExportArtifactOptions = {},
    operationSignal?: AbortSignal,
  ): Promise<ExportArtifactSummary> {
    operationSignal?.throwIfAborted();
    if (documentAuthorityEnabled()) {
      if (
        rawOptions.includeCodex ||
        rawOptions.includeMetadata ||
        rawOptions.includeSummaries
      )
        throw new DocumentError(
          "PUBLICATION_OPTIONS_UNSUPPORTED",
          "Use saved front/back matter for canonical export extras.",
          409,
        );
      requirePublicationPreconditions(rawOptions);
      const { artifact } = await exportCanonicalBook(
        userId,
        bookId,
        "markdown",
        {
          operationId: rawOptions.operationId,
          expectedRevisionId: rawOptions.expectedRevisionId,
          mode: rawOptions.mode,
          preset: rawOptions.preset,
        },
      );
      const stored = await activeStoredArtifact(userId, bookId, artifact.id);
      return summary({ ...stored.manifest, artifactId: artifact.sha256 });
    }
    const options: Required<CreateExportArtifactOptions> = {
      format: rawOptions.format || "markdown",
      includeCodex: rawOptions.includeCodex === true,
      includeMetadata: rawOptions.includeMetadata === true,
      includeSummaries: rawOptions.includeSummaries === true,
    };
    const book = await databaseService.client.book.findFirst({
      where: { id: bookId, userId, deletedAt: null },
      include: {
        acts: {
          orderBy: { actNumber: "asc" },
          include: {
            chapters: {
              orderBy: { chapterNumber: "asc" },
              include: {
                scenes: {
                  where: { deletedAt: null },
                  orderBy: { sceneNumber: "asc" },
                },
              },
            },
          },
        },
        codexEntries: {
          where: options.includeCodex ? { deletedAt: null } : { id: -1 },
          orderBy: [{ entryType: "asc" }, { entryName: "asc" }],
        },
      },
    });
    if (!book) throw new NotFoundError("Book not found");
    operationSignal?.throwIfAborted();

    let content = "";
    const chapters: ChapterRange[] = [];
    const append = (value: string): void => {
      content += value;
    };
    append(`# ${book.title || "Untitled Book"}\n\n`);
    if (options.includeMetadata) {
      if (book.genre) append(`**Genre:** ${book.genre}\n\n`);
      if (book.targetAudience)
        append(`**Target Audience:** ${book.targetAudience}\n\n`);
      if (book.summary) append(`**Summary:** ${book.summary}\n\n`);
      append("---\n\n");
    }

    for (const act of book.acts) {
      append(`# Act ${act.actNumber}${act.title ? `: ${act.title}` : ""}\n\n`);
      if (options.includeSummaries && act.summary)
        append(`*${act.summary}*\n\n`);
      for (const chapter of act.chapters) {
        const chapterStart = content.length;
        append(
          `## Chapter ${chapter.chapterNumber}${chapter.title ? `: ${chapter.title}` : ""}\n\n`,
        );
        if (options.includeSummaries && chapter.summary)
          append(`*${chapter.summary}*\n\n`);
        const scenes: SceneRange[] = [];
        for (const scene of chapter.scenes) {
          const sceneStart = content.length;
          append(`### Scene ${chapter.chapterNumber}.${scene.sceneNumber}\n\n`);
          if (options.includeSummaries && scene.summary)
            append(`> ${scene.summary}\n\n`);
          if (scene.prose) append(`${scene.prose}\n\n`);
          scenes.push({
            id: scene.id,
            sceneNumber: scene.sceneNumber,
            title: null,
            wordCount: scene.wordCount || countWords(scene.prose || ""),
            start: sceneStart,
            end: content.length,
          });
        }
        chapters.push({
          id: chapter.id,
          actNumber: act.actNumber,
          chapterNumber: chapter.chapterNumber,
          title: chapter.title,
          wordCount: scenes.reduce((total, item) => total + item.wordCount, 0),
          scenes,
          start: chapterStart,
          end: content.length,
        });
      }
    }

    if (
      options.includeCodex &&
      Array.isArray(book.codexEntries) &&
      book.codexEntries.length
    ) {
      append("---\n\n# Codex\n\n");
      let type = "";
      for (const entry of book.codexEntries) {
        if (entry.entryType !== type) {
          type = entry.entryType;
          append(`## ${type.charAt(0).toUpperCase()}${type.slice(1)}s\n\n`);
        }
        append(
          `**${entry.entryName}**${entry.entryDescription ? `: ${entry.entryDescription}` : ""}\n\n`,
        );
      }
    }

    const bytes = Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sourceFingerprint = revisionFingerprint(book, options.includeCodex);
    const artifactId = sha256;
    const filename = `${sanitizeFilename(book.title || "book")}-${artifactId.slice(0, 12)}.md`;
    const manifest: ExportArtifactManifest = {
      artifactId,
      bookId,
      userId,
      bookTitle: book.title || "Untitled Book",
      format: "markdown",
      filename,
      byteSize: bytes.byteLength,
      charCount: content.length,
      wordCount: chapters.reduce((total, item) => total + item.wordCount, 0),
      sha256,
      sourceFingerprint,
      createdAt: new Date().toISOString(),
      options,
      chapters,
    };

    const directory = artifactDirectory(userId, bookId);
    operationSignal?.throwIfAborted();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const markdownPath = resolveInside(directory, `${artifactId}.md`);
    const manifestPath = resolveInside(directory, `${artifactId}.json`);
    const tempMarkdown = resolveInside(directory, `.${artifactId}.${nonce}.md.tmp`);
    const tempManifest = resolveInside(directory, `.${artifactId}.${nonce}.json.tmp`,
    );
    await Promise.all([
      fs.writeFile(tempMarkdown, bytes, { mode: 0o600 }),
      fs.writeFile(tempManifest, JSON.stringify(manifest, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);
    operationSignal?.throwIfAborted();
    await Promise.all([
      fs.rename(tempMarkdown, markdownPath),
      fs.rename(tempManifest, manifestPath),
    ]);
    operationSignal?.throwIfAborted();
    const obsolete = (await fs.readdir(directory)).filter((name) => {
      const match = name.match(/^([a-f0-9]{64})\.(md|json)$/);
      return match !== null && match[1] !== artifactId;
    });
    await Promise.allSettled(
      obsolete.map((name) => fs.unlink(resolveInside(directory, name))),
    );
    operationSignal?.throwIfAborted();
    return summary(manifest);
  }

  static async get(
    userId: number,
    bookId: number,
    artifactId: string,
  ): Promise<ExportArtifactSummary> {
    if (documentAuthorityEnabled())
      return summary(
        (await activeStoredArtifact(userId, bookId, artifactId)).manifest,
      );
    const stored = await loadStoredArtifact(userId, bookId, artifactId);
    return summary(stored.manifest);
  }

  static async read(
    userId: number,
    bookId: number,
    artifactId: string,
    options: ReadExportArtifactOptions,
  ): Promise<ExportArtifactReadResult> {
    const active = documentAuthorityEnabled()
      ? await activeStoredArtifact(userId, bookId, artifactId)
      : null;
    const stored =
      active ?? (await loadStoredArtifact(userId, bookId, artifactId));
    const markdown = active
      ? active.content
      : await fs.readFile((stored as StoredArtifact).markdownPath, "utf8");
    let range: ArtifactRange = { start: 0, end: markdown.length };
    const selection: ExportArtifactReadResult["selection"] = {
      bookId,
      bookTitle: stored.manifest.bookTitle,
    };
    if (options.scope === "chapter") {
      const chapter = pickChapter(stored.manifest, options);
      range = chapter;
      Object.assign(selection, {
        actNumber: chapter.actNumber,
        chapterId: chapter.id,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title,
      });
    } else if (options.scope === "scene") {
      const { chapter, scene } = pickScene(stored.manifest, options);
      range = scene;
      Object.assign(selection, {
        actNumber: chapter.actNumber,
        chapterId: chapter.id,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title,
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        sceneTitle: scene.title,
      });
    }

    const selected = markdown.slice(range.start, range.end);
    const offset = Math.min(options.offset || 0, selected.length);
    const maxChars = options.maxChars || 60000;
    const content = selected.slice(offset, offset + maxChars);
    const nextOffset =
      offset + content.length < selected.length
        ? offset + content.length
        : null;
    return {
      artifactId,
      scope: options.scope,
      selection,
      content,
      offset,
      returnedChars: content.length,
      totalChars: selected.length,
      truncated: nextOffset !== null,
      nextOffset,
    };
  }

  static async download(
    userId: number,
    bookId: number,
    artifactId: string,
  ): Promise<{ path: string; manifest: ExportArtifactManifest }> {
    if (documentAuthorityEnabled()) {
      const stored = await activeStoredArtifact(userId, bookId, artifactId);
      const directory = artifactDirectory(userId, bookId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = resolveInside(directory, `${artifactId}.md`);
      try {
        await fs.writeFile(filename, stored.bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
      if (
        createHash("sha256")
          .update(await fs.readFile(filename))
          .digest("hex") !== stored.manifest.sha256
      )
        throw new DocumentError(
          "PUBLICATION_ARTIFACT_INVALID",
          "Download cache checksum changed.",
          503,
        );
      return { path: filename, manifest: stored.manifest };
    }
    const stored = await loadStoredArtifact(userId, bookId, artifactId);
    return { path: stored.markdownPath, manifest: stored.manifest };
  }

  static async delete(
    userId: number,
    bookId: number,
    artifactId: string,
  ): Promise<{ artifactId: string; deleted: true }> {
    if (documentAuthorityEnabled()) {
      await activeStoredArtifact(userId, bookId, artifactId);
      throw new DocumentError(
        "PUBLICATION_ARTIFACT_IMMUTABLE",
        "Publication history is immutable and cannot be deleted.",
        409,
      );
    }
    const stored = await loadStoredArtifact(userId, bookId, artifactId);
    await Promise.all([
      fs.unlink(stored.markdownPath),
      fs.unlink(stored.manifestPath),
    ]);
    return { artifactId, deleted: true };
  }
}
