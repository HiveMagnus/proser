import { randomUUID } from "node:crypto";
import { databaseService } from "@/lib/database";
import { documentService } from "@/documents/service";
import {
  documentFromText,
  projectDocument,
  resolveChange,
  canonicalDocument,
} from "@/documents/model";
import { stampDocumentReview } from "@/documents/reviewAttribution";
import {
  createPublicationJob,
  runPublicationJob,
  readPublicationArtifact,
  readPublicationJob,
  publicationCapabilities,
  cancelPublicationJob,
} from "@/documents/publication";
import { ExportArtifactService } from "@/services/exportArtifactService";
import { publicationDocx } from "@/documents/publicationDocx";
import * as publicationDocxModule from "@/documents/publicationDocx";
import {
  admitReleaseMutation,
  withReleaseAdmission,
} from "@/operations/releaseAdmission";
import {
  publicationEpub,
  publicationPdf,
  publicationHtml,
  publicationMarkdown,
  type PublicationInput,
} from "@/documents/publicationRender";
import {
  validateDocxPackage,
  readDocumentPackage,
  parseDocumentXml,
} from "@/documents/packageValidation";

describe("canonical publication codecs", () => {
  const input = (): PublicationInput => {
    const first = documentFromText(
      "Bold 😀 é & <script>bad</script>",
      randomUUID,
    );
    const second = documentFromText("Second chapter.", randomUUID);
    if (first.blocks[0].type === "paragraph")
      first.blocks[0].runs[0].style = { bold: true };
    return {
      title: "Fixture & title",
      author: "Fixture",
      revisionId: randomUUID(),
      sections: [
        { id: "s1", title: "First", document: first },
        { id: "s2", title: "Second", document: second },
      ],
      assets: new Map(),
    };
  };
  test("semantic final/original exports project paragraph formatting and boundaries without mutating physical identities", async () => {
    const source = input();
    const document = documentFromText("Left\n\nRight", randomUUID);
    const [left, right] = document.blocks;
    if (left.type !== "paragraph" || right.type !== "paragraph")
      throw new Error("fixture");
    left.style = { alignment: "center", heading: 2 };
    left.boundaryChangeId = "join";
    document.changes = [
      {
        id: "join",
        kind: "paragraphJoin",
        authorId: 1,
        authorName: "Editor",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "pending",
        origin: "manual",
        targetRunIds: [],
        targetBlockIds: [left.id, right.id],
      },
      {
        id: "format",
        kind: "paragraphFormat",
        authorId: 1,
        authorName: "Editor",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "pending",
        origin: "manual",
        targetRunIds: [],
        targetBlockIds: [left.id],
        beforeParagraphStyle: { alignment: "left" },
        afterParagraphStyle: left.style,
      },
    ];
    source.sections = [
      { id: "s", title: "Scene", document, startsChapter: false },
    ];
    const retained = JSON.stringify(document);
    const final = publicationHtml(source, "final");
    const original = publicationHtml(source, "original");
    expect(final).toContain("text-align:center");
    expect(final).toContain("Left</span><span");
    expect(final.match(/data-block-id=/g)).toHaveLength(1);
    expect(original).toContain("text-align:left");
    expect(original.match(/data-block-id=/g)).toHaveLength(2);
    expect(publicationMarkdown(source, "final")).toBe("## LeftRight");
    expect(publicationMarkdown(source, "original")).toBe("Left\n\nRight");
    const epub = await readDocumentPackage(
      await publicationEpub(source, "original"),
    );
    expect(
      epub.get("OEBPS/section-0.xhtml")?.toString() ??
        [...epub.values()].map((bytes) => bytes.toString()).join(""),
    ).toContain("text-align:left");
    expect(JSON.stringify(document)).toBe(retained);
  });
  test("authenticated change resolution history remains in Factory sidecars and cannot leak into neutral codec input", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const document = source.sections[0].document;
    const paragraph = document.blocks[0];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.runs[0].changeId = "accepted";
    document.changes = [
      {
        id: "accepted",
        kind: "insertion",
        authorId: 1,
        authorName: "Owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "accepted",
        origin: "manual",
        targetRunIds: [paragraph.runs[0].id],
        resolutionHistory: [
          {
            operationId: randomUUID(),
            actorId: 1,
            actorName: "Reviewer",
            createdAt: "2026-01-02T00:00:00.000Z",
            decision: "accepted",
            origin: "manual",
            phase: "resolved",
            sourceKind: "scene",
            sourceSceneId: 1,
            sourceSceneRevisionId: randomUUID(),
            sourceBookRevisionId: randomUUID(),
            sourceContentHash: "a".repeat(64),
          },
        ],
      },
    ];
    const { wordExchangeDocument } = await import("@/documents/wordExchange");
    expect(wordExchangeDocument(document).changes[0]).not.toHaveProperty(
      "resolutionHistory",
    );
    const files = await validateDocxPackage(
      await publicationDocx(source, "retain-review"),
    );
    expect(files.get("word/document.xml")!.toString()).toContain("Bold");
    expect(document.changes[0].resolutionHistory).toHaveLength(1);
    const { reviewSidecar } = await import("@/documents/publicationRender");
    expect(
      reviewSidecar(source).sections[0].changes[0].resolutionHistory![0]
        .actorName,
    ).toBe("Reviewer");
  });
  test("resolved historical boundary re-edit exports only the current native mark and retains exact old evidence in the review sidecar", async () => {
    const source = input();
    const before = documentFromText("A\n\nB", randomUUID);
    const [left, right] = before.blocks;
    if (left.type !== "paragraph" || right.type !== "paragraph")
      throw new Error("fixture");
    const oldId = randomUUID(),
      newId = randomUUID();
    left.boundaryChangeId = oldId;
    before.changes = [
      {
        id: oldId,
        kind: "paragraphSplit",
        status: "accepted",
        origin: "import",
        authorId: 4,
        authorName: "Imported editor",
        importedAuthor: "Original Word reviewer",
        createdAt: "2020-01-01T00:00:00.000Z",
        targetRunIds: [],
        targetBlockIds: [left.id, right.id],
        resolutionHistory: [
          {
            operationId: randomUUID(),
            actorId: 5,
            actorName: "Prior reviewer",
            createdAt: "2020-01-02T00:00:00.000Z",
            decision: "accepted",
            origin: "manual",
            phase: "resolved",
            sourceKind: "scene",
            sourceSceneId: 1,
            sourceSceneRevisionId: randomUUID(),
            sourceBookRevisionId: randomUUID(),
            sourceContentHash: "a".repeat(64),
          },
        ],
      },
    ];
    const document = structuredClone(before);
    const currentLeft = document.blocks[0],
      currentRight = document.blocks[1];
    if (currentLeft.type !== "paragraph" || currentRight.type !== "paragraph")
      throw new Error("fixture");
    // The old right paragraph has been replaced by an exact current descendant;
    // its original identity remains evidence rather than a guessed native target.
    currentRight.id = randomUUID();
    currentLeft.boundaryChangeId = newId;
    document.changes.push({
      id: newId,
      kind: "paragraphJoin",
      status: "pending",
      origin: "manual",
      authorId: 8,
      authorName: "Current editor",
      createdAt: "2026-10-06T00:00:00.000Z",
      targetRunIds: [],
      targetBlockIds: [currentLeft.id, currentRight.id],
    });
    stampDocumentReview(
      document,
      before,
      { id: 8, name: "Current editor" },
      "manual",
      false,
      {
        operationId: randomUUID(),
        sourceKind: "scene",
        sourceSceneId: 1,
        sourceSceneRevisionId: randomUUID(),
        sourceBookRevisionId: randomUUID(),
        sourceContentHash: "b".repeat(64),
      },
    );
    source.sections = [
      { id: "scene", title: "Scene", startsChapter: false, document },
    ];
    const retained = canonicalDocument(document);
    const { wordExchangeDocument } = await import("@/documents/wordExchange");
    const { reviewSidecar } = await import("@/documents/publicationRender");
    const neutral = wordExchangeDocument(document);
    expect(neutral.changes.map((change) => change.id)).toEqual([newId]);
    expect(neutral.changes[0]).not.toHaveProperty("historicalBoundarySource");
    expect(reviewSidecar(source).sections[0].changes[0]).toEqual(
      document.changes[0],
    );
    expect(document.changes[0].historicalBoundarySource).toMatchObject({
      sourceKind: "scene",
      changeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(document.changes[0].resolutionHistory).toEqual(
      before.changes[0].resolutionHistory,
    );
    const { convertDocx } = await import("@/documents/docxImport");
    for (const mode of ["final", "original", "retain-review"] as const) {
      const bytes = await publicationDocx(source, mode);
      const files = await validateDocxPackage(bytes);
      const xml = files.get("word/document.xml")!.toString();
      expect(xml).not.toContain("Original Word reviewer");
      expect(xml).not.toContain("historicalBoundarySource");
      if (mode === "retain-review") {
        expect(xml).toContain("Current editor");
        expect(xml.match(/<w:del /g)).toHaveLength(1);
      }
      const converted = await convertDocx(bytes);
      const imported = converted.documents[0];
      expect(
        projectDocument(imported, mode === "original" ? "original" : "final")
          .text,
      ).toBe(
        projectDocument(document, mode === "original" ? "original" : "final")
          .text,
      );
      if (mode === "retain-review") {
        expect(imported.changes).toHaveLength(1);
        expect(imported.changes[0].kind).toBe("paragraphJoin");
        expect(imported.changes[0].importedAuthor).toBe("Current editor");
      }
    }
    for (const decision of ["accepted", "rejected"] as const) {
      const resolved = resolveChange(document, newId, decision);
      source.sections[0].document = resolved;
      const converted = await convertDocx(
        await publicationDocx(source, "final"),
      );
      expect(projectDocument(converted.documents[0]).text).toBe(
        projectDocument(resolved).text,
      );
      expect(reviewSidecar(source).sections[0].changes[0]).toEqual(
        document.changes[0],
      );
    }
    expect(canonicalDocument(document)).toBe(retained);
  });
  test("JSON final/original exports retain declared source identity and project review without accepting saved changes", async () => {
    const { publicationJson } = await import("@/documents/publicationRender");
    const source = input();
    const document = source.sections[0].document;
    const paragraph = document.blocks[0];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.runs = [
      { id: "old", text: "Before", style: { italic: true }, changeId: "del" },
      { id: "new", text: "After", style: { bold: true }, changeId: "ins" },
    ];
    document.changes = [
      {
        id: "del",
        kind: "deletion",
        status: "pending",
        origin: "manual",
        authorId: 1,
        authorName: "Owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        targetRunIds: ["old"],
      },
      {
        id: "ins",
        kind: "insertion",
        status: "pending",
        origin: "manual",
        authorId: 1,
        authorName: "Owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        targetRunIds: ["new"],
      },
    ];
    const saved = JSON.stringify(document);
    const final = JSON.parse(
      publicationJson(source, "final", { revisionId: source.revisionId }),
    );
    const original = JSON.parse(
      publicationJson(source, "original", { revisionId: source.revisionId }),
    );
    expect(final).toMatchObject({
      projection: "final",
      sourceManifest: { revisionId: source.revisionId },
    });
    expect(
      final.sections[0].document.blocks[0].runs
        .map((run: { text: string }) => run.text)
        .join(""),
    ).toBe("After");
    expect(
      original.sections[0].document.blocks[0].runs
        .map((run: { text: string }) => run.text)
        .join(""),
    ).toBe("Before");
    expect(final.sections[0].document.changes).toEqual([]);
    expect(JSON.stringify(document)).toBe(saved);
    expect(
      JSON.parse(publicationJson(source, "retain-review", {})).sections[0]
        .document.changes,
    ).toHaveLength(2);
  });
  test("inline images in table cells and body preserve placement in all semantic packages", async () => {
    const { createHash } = await import("node:crypto");
    const source = input();
    const document = source.sections[0].document;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    const image = {
      assetId: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      alt: "Inline fixture",
      width: 12,
      height: 12,
    };
    const paragraph = document.blocks[0];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.runs = [
      { id: "before", text: "Before ", style: {} },
      { id: "image", text: "", style: {}, inlineImage: image },
      { id: "after", text: " after", style: {} },
    ];
    document.blocks.push({
      type: "table",
      id: "table",
      widths: [120],
      rows: [
        {
          id: "row",
          cells: [
            {
              id: "cell",
              paragraphs: [
                {
                  ...structuredClone(paragraph),
                  id: "cell-p",
                  runs: paragraph.runs.map((run) => ({
                    ...run,
                    id: "cell-" + run.id,
                  })),
                },
              ],
            },
          ],
        },
      ],
    });
    source.assets.set(1, { bytes, mediaType: "image/png" });
    source.sections = source.sections.slice(0, 1);
    const html = publicationHtml(source, "final");
    expect(html.indexOf("Before")).toBeLessThan(
      html.indexOf('alt="Inline fixture"'),
    );
    expect(html.indexOf('alt="Inline fixture"')).toBeLessThan(
      html.indexOf(" after"),
    );
    expect(html.match(/alt="Inline fixture"/g)).toHaveLength(2);
    const epub = await readDocumentPackage(
      await publicationEpub(source, "final"),
    );
    expect(
      [...epub.keys()].filter((name) => name === "OEBPS/assets/1.png"),
    ).toHaveLength(1);
    expect(publicationMarkdown(source, "final")).toContain(
      "Before ![Inline fixture](asset:1@",
    );
    const { convertDocx } = await import("@/documents/docxImport");
    const conversion = await convertDocx(
      await publicationDocx(source, "final"),
    );
    const converted = conversion.documents[0].blocks[0];
    expect(
      converted.type === "paragraph" && converted.runs[1].inlineImage?.sha256,
    ).toBe(image.sha256);
  });
  test("detached comment source evidence stays in sidecars and never becomes a guessed native Word range", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const document = source.sections[0].document;
    const block = document.blocks[0];
    if (block.type !== "paragraph") throw new Error("fixture");
    const anchor = {
      blockId: block.id,
      runId: block.runs[0].id,
      start: 0,
      end: 5,
      sourceText: "Older",
    };
    document.comments = [
      {
        id: "detached",
        authorId: 1,
        authorName: "Reviewer",
        createdAt: "2026-01-01T00:00:00.000Z",
        text: "Retain detached evidence",
        resolved: false,
        anchors: [anchor],
        anchorStates: [
          {
            anchorIndex: 0,
            status: "stale",
            reason: "target-text-changed",
            sourceSceneId: 1,
            sourceSceneRevisionId: randomUUID(),
            sourceContentHash: "a".repeat(64),
            sourceAnchor: anchor,
          },
        ],
      },
    ];
    const files = await validateDocxPackage(
      await publicationDocx(source, "retain-review"),
    );
    expect(files.has("word/comments.xml")).toBe(false);
    expect(files.get("word/document.xml")!.toString()).not.toContain(
      "commentRangeStart",
    );
    const html = publicationHtml(source, "retain-review");
    expect(html).toContain('data-comment-status="detached"');
    expect(html).toContain("stale: target-text-changed");
    const { reviewSidecar } = await import("@/documents/publicationRender");
    expect(
      reviewSidecar(source).sections[0].comments[0].anchorStates![0]
        .sourceAnchor,
    ).toEqual(anchor);
  });
  // These integration cases launch real Chromium and load the pinned font corpus.
  // Cold CI launches can exceed Jest's five-second unit-test default.
  test("PDF rejects undecodable bitmap bytes instead of completing with missing assets", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const bytes = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080600000000000000",
      "hex",
    );
    source.assets.set(1, { bytes, mediaType: "image/png" });
    source.sections[0].document.blocks.push({
      type: "image",
      id: "malformed-image",
      assetId: 1,
      sha256: "a".repeat(64),
      alt: "Must not disappear",
      width: 12,
      height: 12,
    });
    await expect(publicationPdf(source, "final")).rejects.toMatchObject({
      code: "EXPORT_ASSET_UNAVAILABLE",
      status: 409,
    });
  }, 30_000);
  test("PDF records actual pinned faces for emoji/combining and visibly rejects missing CJK glyph fallback", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    source.sections[0].startsChapter = false;
    source.sections[0].document.layout.font = "Liberation Serif";
    expect(publicationHtml(source, "final")).toContain("Liberation Serif");
    const rendered = await publicationPdf(source, "final");
    const usage = rendered.fontUsage.find((value) => value.context === "body")!;
    expect(usage.sourceTextNodes).toBeGreaterThan(0);
    expect(
      usage.faces.every(
        (font) => font.sha256.length === 64 && font.version.length > 0,
      ),
    ).toBe(true);
    expect(
      usage.faces.some((font) => font.postScriptName.startsWith("DejaVuSans")),
    ).toBe(true);
    source.sections[0].document = documentFromText(
      "漢字 must not silently become missing glyph boxes.",
      randomUUID,
    );
    source.sections[0].document.layout.font = "Liberation Serif";
    await expect(publicationPdf(source, "final")).rejects.toMatchObject({
      status: 422,
      code: expect.stringMatching(
        /^PUBLICATION_GLYPH_(UNAVAILABLE|FONT_UNPINNED)$/,
      ),
    });
  }, 30_000);
  test("unavailable requested fonts use disclosed pinned PDF substitutes across named styles and runs", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const document = source.sections[0].document;
    document.layout.font = "Calibri";
    if (document.blocks[0].type !== "paragraph") throw new Error("fixture");
    document.blocks[0].style.name = "calibri";
    document.blocks[0].runs[0].style.font = "Calibri";
    source.styles = {
      text: { calibri: { font: "Calibri" } },
      paragraph: { calibri: {} },
    };
    const retained = JSON.stringify(source.sections);
    const rendered = await publicationPdf(source, "final");
    expect(rendered.substitutions).toEqual([
      { requested: "Calibri", actual: "Liberation Serif" },
    ]);
    expect(
      rendered.fonts.some(
        (font) =>
          font.name === "Liberation Serif" &&
          font.version === "2.1.5" &&
          font.sha256.length === 64,
      ),
    ).toBe(true);
    expect(JSON.stringify(source.sections)).toBe(retained);
  });
  test("owned story default typography uses its canonical layout while page geometry remains book-owned", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const section = source.sections[0];
    section.document.layout.font = "Liberation Serif";
    section.document.layout.fontSize = 14;
    section.document.layout.margins = [100, 60, 100, 60];
    const header = documentFromText("Owned typography 😀 é", randomUUID);
    header.layout.font = "Liberation Mono";
    header.layout.fontSize = 24;
    header.layout.width = 200;
    header.layout.margins = [1, 1, 1, 1];
    section.headerStory = { id: "typed-header", document: header };
    const footer = documentFromText("Calibri footer", randomUUID);
    footer.layout.font = "Calibri";
    footer.layout.fontSize = 18;
    section.footerStory = { id: "typed-footer", document: footer };
    const retained = JSON.stringify(source.sections);
    const html = publicationHtml(source, "final");
    expect(html).toContain("Liberation Mono");
    expect(html).toContain("font-size:24px");
    expect(html).toContain(
      `size:${section.document.layout.width}px ${section.document.layout.height}px`,
    );
    const rendered = await publicationPdf(source, "final");
    const headerUsage = rendered.fontUsage.find(
      (value) => value.context === "header:s1",
    )!;
    expect(
      headerUsage.faces.some((font) =>
        font.postScriptName.startsWith("LiberationMono"),
      ),
    ).toBe(true);
    expect(
      headerUsage.faces.some((font) =>
        font.postScriptName.startsWith("DejaVuSans"),
      ),
    ).toBe(true);
    expect(rendered.substitutions).toEqual([
      { requested: "Calibri", actual: "Liberation Serif" },
    ]);
    expect(JSON.stringify(source.sections)).toBe(retained);
    header.blocks[0] = documentFromText("漢字", randomUUID).blocks[0];
    await expect(publicationPdf(source, "final")).rejects.toMatchObject({
      status: 422,
      code: expect.stringMatching(
        /^PUBLICATION_GLYPH_(UNAVAILABLE|FONT_UNPINNED)$/,
      ),
      details: expect.objectContaining({ context: "header:s1" }),
    });
  }, 20_000);
  test("intentional empty body, cell and owned margin paragraphs retain semantic line boxes", async () => {
    const { chromium } = await import("playwright");
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const document = documentFromText("", randomUUID);
    const empty = document.blocks[0];
    if (empty.type !== "paragraph") throw new Error("fixture");
    const second = structuredClone(empty);
    second.id = "second";
    second.runs = second.runs.map((run) => ({
      ...run,
      id: run.id + "-second",
    }));
    document.blocks.push(second);
    document.blocks.push({
      type: "table",
      id: "table",
      widths: [200],
      rows: [
        {
          id: "row",
          cells: [
            {
              id: "cell",
              paragraphs: [
                {
                  ...structuredClone(empty),
                  id: "cell-p",
                  runs: empty.runs.map((run) => ({
                    ...run,
                    id: run.id + "-cell",
                  })),
                },
              ],
            },
          ],
        },
      ],
    });
    source.sections[0].document = document;
    source.sections[0].headerStory = {
      id: "header",
      document: structuredClone(document),
    };
    source.sections[0].footerStory = {
      id: "footer",
      document: structuredClone(document),
    };
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(publicationHtml(source, "final"));
      const boxes = await page.evaluate<number[]>(
        "Array.from(document.querySelectorAll('p'),paragraph=>paragraph.getBoundingClientRect().height)",
      );
      expect(boxes).toHaveLength(9);
      expect(boxes.every((height) => height >= 16)).toBe(true);
      const breaks = await page.locator("p>br").count();
      expect(breaks).toBe(9);
      document.changes = [
        {
          id: "delete-blank",
          kind: "paragraphDeletion",
          status: "pending",
          origin: "manual",
          authorId: 1,
          authorName: "Reviewer",
          createdAt: "2026-01-01T00:00:00.000Z",
          targetRunIds: [],
          targetBlockIds: [second.id],
        },
      ];
      second.changeId = "delete-blank";
      source.sections[0].headerStory!.document = structuredClone(document);
      source.sections[0].footerStory!.document = structuredClone(document);
      await page.setContent(publicationHtml(source, "final"));
      expect(await page.locator("p>br").count()).toBe(6);
      await page.setContent(publicationHtml(source, "original"));
      expect(await page.locator("p>br").count()).toBe(9);
    } finally {
      await browser.close();
    }
  });
  test("empty line boxes resolve named chains, empty-run overrides, review views and owned story defaults", async () => {
    const { chromium } = await import("playwright");
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const document = documentFromText("", randomUUID);
    document.layout.font = "Liberation Serif";
    document.layout.fontSize = 16;
    const body = document.blocks[0];
    if (body.type !== "paragraph") throw new Error("fixture");
    body.id = "empty-body";
    body.style.name = "box";
    body.runs[0].id = "empty-run";
    body.runs[0].style = { characterStyleId: "child", size: 36 };
    document.changes = [
      {
        id: "size-change",
        kind: "format",
        status: "pending",
        origin: "manual",
        authorId: 1,
        authorName: "Reviewer",
        createdAt: "2026-01-01T00:00:00.000Z",
        targetRunIds: ["empty-run"],
        beforeStyle: { characterStyleId: "child", size: 24 },
        afterStyle: body.runs[0].style,
      },
    ];
    const cell = documentFromText("", randomUUID).blocks[0];
    if (cell.type !== "paragraph") throw new Error("fixture");
    cell.id = "empty-cell";
    cell.style.name = "box";
    document.blocks.push({
      type: "table",
      id: "empty-table",
      widths: [200],
      rows: [
        { id: "empty-row", cells: [{ id: "empty-c", paragraphs: [cell] }] },
      ],
    });
    source.sections[0].document = document;
    source.styles = {
      paragraph: { box: {} },
      text: {
        box: { font: "Liberation Sans", size: 28 },
        child: { characterStyleId: "parent" },
        parent: { font: "Liberation Mono", bold: true },
      },
    };
    const header = documentFromText("", randomUUID);
    header.layout.font = "Liberation Mono";
    header.layout.fontSize = 20;
    header.blocks[0].id = "empty-header";
    source.sections[0].headerStory = { id: "h", document: header };
    const footer = documentFromText("", randomUUID);
    footer.layout.font = "Liberation Serif";
    footer.layout.fontSize = 22;
    footer.blocks[0].id = "empty-footer";
    source.sections[0].footerStory = { id: "f", document: footer };
    const retained = JSON.stringify(source.sections);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      for (const [view, size] of [
        ["final", 36],
        ["original", 24],
        ["retain-review", 36],
      ] as const) {
        await page.setContent(publicationHtml(source, view));
        for (const [id, wanted, family] of [
          ["empty-body", size, "Liberation Mono"],
          ["empty-cell", 28, "Liberation Sans"],
          ["empty-header", 20, "Liberation Mono"],
          ["empty-footer", 22, "Liberation Serif"],
        ] as const) {
          const metrics = await page
            .locator('[data-block-id="' + id + '"]')
            .evaluate(
              (element: {
                getBoundingClientRect: () => { height: number };
              }) => {
                const style = (
                  globalThis as unknown as {
                    getComputedStyle: (element: unknown) => {
                      fontSize: string;
                      fontFamily: string;
                    };
                  }
                ).getComputedStyle(element);
                return {
                  size: style.fontSize,
                  font: style.fontFamily,
                  height: element.getBoundingClientRect().height,
                };
              },
            );
          expect(metrics.size).toBe(wanted + "px");
          expect(metrics.font).toContain(family);
          expect(metrics.height).toBeGreaterThanOrEqual(wanted);
        }
      }
    } finally {
      await browser.close();
    }
    expect(JSON.stringify(source.sections)).toBe(retained);
  });
  test("empty preserved header/footer paragraphs do not stall PDF margin rendering", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    const empty = documentFromText("", randomUUID);
    source.sections[0].document.layout.header = empty.blocks.filter(
      (block) => block.type === "paragraph",
    );
    source.sections[0].footerStory = {
      id: "blank-owned-footer",
      document: empty,
    };
    expect(
      (await publicationPdf(source, "final")).bytes.subarray(0, 5).toString(),
    ).toBe("%PDF-");
  }, 30_000);
  test("DOCX keeps section styles and valid remapped native relationships", async () => {
    const files = await validateDocxPackage(
      await publicationDocx(input(), "final"),
    );
    const xml = files.get("word/document.xml")!.toString();
    expect(xml).toContain("Bold 😀 é");
    expect(xml).toContain("Second chapter.");
    expect(xml.match(/<w:sectPr/g)).toHaveLength(2);
    expect(files.get("word/styles.xml")!.toString()).toContain(
      "section-1-Normal",
    );
  });
  test("owned generated chapter titles bind explicit typography and covers suppress headings without mutating source", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    source.sections[0].startsChapter = true;
    source.sections[0].document.layout.font = "Liberation Serif";
    source.sections[0].document.layout.fontSize = 18;
    const retained = JSON.stringify(source.sections[0].document);
    const files = await validateDocxPackage(
      await publicationDocx(source, "final"),
    );
    const xml = files.get("word/document.xml")!.toString();
    const title = xml.slice(0, xml.indexOf("First") + 5);
    expect(title).toContain('w:sz w:val="54"');
    expect(title).toContain("<w:b/>");
    expect(title).toContain("Liberation Serif");
    expect(JSON.stringify(source.sections[0].document)).toBe(retained);
    source.sections[0].isCover = true;
    const coverFiles = await validateDocxPackage(
      await publicationDocx(source, "final"),
    );
    expect(coverFiles.get("word/document.xml")!.toString()).not.toContain(
      ">First<",
    );
  });
  test("two scenes in one chapter share print pages and one EPUB chapter navigation entry", async () => {
    const source = input();
    source.sections[0].startsChapter = true;
    source.sections[0].chapterId = 1;
    source.sections[1].startsChapter = false;
    source.sections[1].chapterId = 1;
    const files = await validateDocxPackage(
      await publicationDocx(source, "final"),
    );
    expect(files.get("word/document.xml")!.toString()).toContain(
      'w:val="continuous"',
    );
    const epub = await readDocumentPackage(
      await publicationEpub(source, "final"),
    );
    expect(epub.get("OEBPS/nav.xhtml")!.toString().match(/<li>/g)).toHaveLength(
      1,
    );
    const html = publicationHtml(source, "final");
    expect(html.match(/class="section-0/g)).toHaveLength(2);
    expect(html.match(/class="section-0 chapter-start/g)).toHaveLength(1);
  });
  test("highly compressible generated manuscripts export while import ZIP ratio limits remain enforced", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    source.sections[0].startsChapter = false;
    const text = "word ".repeat(300_000);
    source.sections[0].document = documentFromText(text, randomUUID);
    const started = performance.now();
    const bytes = await publicationDocx(source, "final");
    expect((await validateDocxPackage(bytes)).has("word/document.xml")).toBe(
      true,
    );
    const { convertDocx } = await import("@/documents/docxImport");
    const conversion = await convertDocx(bytes);
    const paragraph = conversion.documents[0].blocks[0];
    expect(
      paragraph.type === "paragraph" &&
        paragraph.runs.map((run) => run.text).join(""),
    ).toBe(text);
    expect(bytes.length).toBeGreaterThan(text.length);
    expect(performance.now() - started).toBeLessThan(30_000);
  });
  test("standalone scene EPUB retains a navigation entry when it has no chapter-start section", async () => {
    const source = input();
    source.sections = source.sections.slice(0, 1);
    source.sections[0].startsChapter = false;
    const files = await readDocumentPackage(
      await publicationEpub(source, "final"),
    );
    expect(files.get("OEBPS/nav.xhtml")!.toString()).toContain(
      '<li><a href="section-0.xhtml">First</a></li>',
    );
    source.sections = [];
    await expect(publicationEpub(source, "final")).rejects.toMatchObject({
      code: "PUBLICATION_CONTENT_EMPTY",
      status: 422,
    });
  });
  test("EPUB3 packages semantic XHTML and a review sidecar with navigation", async () => {
    const files = await readDocumentPackage(
      await publicationEpub(input(), "retain-review"),
    );
    expect(files.get("mimetype")!.toString()).toBe("application/epub+zip");
    expect(files.has("OEBPS/review.json")).toBe(true);
    const opf = parseDocumentXml(files.get("OEBPS/content.opf")!);
    expect(opf.documentElement!.getAttribute("version")).toBe("3.0");
    expect(files.get("OEBPS/section-0.xhtml")!.toString()).toContain(
      "&lt;script&gt;",
    );
  });
  test("HTML sanitizes text while Markdown retains deterministic supported formatting", () => {
    const source = input();
    expect(publicationHtml(source, "final")).not.toContain(
      "<script>bad</script>",
    );
    expect(publicationHtml(source, "final")).toContain("font-weight:bold");
    expect(publicationMarkdown(source, "final")).toContain("**Bold 😀 é");
  });
  test("pinned Chromium produces genuine PDF bytes from self-contained canonical HTML", async () => {
    const output = await publicationPdf(input(), "final");
    expect(output.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(output.version).toMatch(/^\d+\./);
  }, 60_000);
});

describe("durable revision-bound publication jobs", () => {
  const db = () => databaseService.client;
  let userId: number;
  let otherUserId: number;
  let bookId: number;
  let sceneId: number;
  beforeAll(async () => {
    userId = (
      await db().user.create({
        data: {
          githubId: `publication-${randomUUID()}`,
          username: "Publication fixture",
        },
      })
    ).id;
    otherUserId = (
      await db().user.create({
        data: {
          githubId: `publication-other-${randomUUID()}`,
          username: "Other fixture",
        },
      })
    ).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({
      data: {
        userId,
        title: "Publication source",
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: {
                chapterNumber: 1,
                scenes: {
                  create: { sceneNumber: 1, prose: "Retained exact text 😀." },
                },
              },
            },
          },
        },
      },
      include: {
        acts: { include: { chapters: { include: { scenes: true } } } },
      },
    });
    bookId = book.id;
    sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
  });
  afterEach(async () => {
    const admissions = await db().releaseAdmissionBinding.findMany({
      where: { sourceBookId: bookId },
      select: { admissionId: true },
    });
    await db().releaseAdmissionBinding.deleteMany({
      where: { sourceBookId: bookId },
    });
    await db().releaseMutationAdmission.deleteMany({
      where: { id: { in: admissions.map((row) => row.admissionId) } },
    });
    await db().documentPublicationArtifact.deleteMany({ where: { bookId } });
    await db().documentPublication.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    await db().user.deleteMany({
      where: { id: { in: [userId, otherUserId] } },
    });
  });
  const create = async (
    format:
      "docx" | "epub" | "html" | "markdown" | "text" | "json" | "pdf" = "docx",
  ) => {
    const head = await documentService.manifest(userId, bookId);
    const request = {
      operationId: randomUUID(),
      expectedRevisionId: head.revisionId,
      options: { format, mode: "retain-review", preset: "saved" },
    };
    return {
      request,
      job: await createPublicationJob(userId, bookId, request),
    };
  };
  test("actual pinned renderer faces are durable and unavailable glyphs leave an owned recoverable failed job", async () => {
    const good = await create("pdf");
    const completed = await runPublicationJob(userId, bookId, good.job.id);
    const artifact = await readPublicationArtifact(
      userId,
      bookId,
      completed.artifactId!,
    );
    expect(artifact.provenance).toMatchObject({
      rendererFontUsage: expect.arrayContaining([
        expect.objectContaining({
          context: "body",
          faces: expect.arrayContaining([
            expect.objectContaining({
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              version: expect.any(String),
            }),
          ]),
        }),
      ]),
    });
    const source = await documentService.read(userId, bookId, sceneId);
    const document = documentFromText(
      "漢字 must not vanish into missing glyphs.",
      randomUUID,
    );
    document.layout = structuredClone(source.document.layout);
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      scenes: [{ sceneId, expectedRevisionId: source.revisionId, document }],
    });
    const failed = await create("pdf");
    await expect(
      runPublicationJob(userId, bookId, failed.job.id),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: expect.stringMatching(
        /^PUBLICATION_GLYPH_(UNAVAILABLE|FONT_UNPINNED)$/,
      ),
    });
    const recovered = await readPublicationJob(userId, bookId, failed.job.id);
    expect(recovered).toMatchObject({
      status: "failed",
      artifactId: null,
      errorCode: expect.stringMatching(
        /^PUBLICATION_GLYPH_(UNAVAILABLE|FONT_UNPINNED)$/,
      ),
    });
    expect(recovered.errorMessage).toMatch(/glyph|pinned/i);
    expect(await createPublicationJob(userId, bookId, failed.request)).toEqual(
      recovered,
    );
    await expect(
      readPublicationJob(otherUserId, bookId, failed.job.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await documentService.read(userId, bookId, sceneId)).projection.text,
    ).toBe("漢字 must not vanish into missing glyphs.");
  }, 20_000);
  test("owned historical re-edit publication persists exact source evidence in its downloadable review sidecar", async () => {
    const initial = await documentService.read(userId, bookId, sceneId);
    const split = documentFromText("A\n\nB", randomUUID);
    split.layout = initial.document.layout;
    const [left, right] = split.blocks;
    if (left.type !== "paragraph" || right.type !== "paragraph")
      throw new Error("fixture");
    const oldId = randomUUID();
    left.boundaryChangeId = oldId;
    split.changes = [
      {
        id: oldId,
        kind: "paragraphSplit",
        status: "pending",
        origin: "manual",
        authorId: userId,
        authorName: "Owner",
        createdAt: new Date().toISOString(),
        targetRunIds: [],
        targetBlockIds: [left.id, right.id],
      },
    ];
    const save = async (
      document: import("@/documents/model").ProserDocument,
    ) => {
      const source = await documentService.read(userId, bookId, sceneId);
      return documentService.commit(userId, bookId, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: source.bookRevisionId,
        scenes: [{ sceneId, expectedRevisionId: source.revisionId, document }],
      });
    };
    await save(split);
    const pending = await documentService.read(userId, bookId, sceneId);
    await save(resolveChange(pending.document, oldId, "accepted"));
    const resolved = await documentService.read(userId, bookId, sceneId);
    const repeated = structuredClone(resolved.document);
    const currentLeft = repeated.blocks[0],
      currentRight = repeated.blocks[1];
    if (currentLeft.type !== "paragraph" || currentRight.type !== "paragraph")
      throw new Error("fixture");
    const currentId = randomUUID();
    currentLeft.boundaryChangeId = currentId;
    repeated.changes.push({
      id: currentId,
      kind: "paragraphJoin",
      status: "pending",
      origin: "manual",
      authorId: userId,
      authorName: "Owner",
      createdAt: new Date().toISOString(),
      targetRunIds: [],
      targetBlockIds: [currentLeft.id, currentRight.id],
    });
    await save(repeated);
    const source = await documentService.read(userId, bookId, sceneId);
    const old = source.document.changes[0];
    expect(old.historicalBoundarySource).toMatchObject({
      sourceSceneRevisionId: resolved.revisionId,
    });
    expect(old.resolutionHistory).toHaveLength(1);
    const { job } = await create("docx");
    const completed = await runPublicationJob(userId, bookId, job.id);
    expect(completed.status).toBe("completed");
    expect(completed.fidelity?.losses.join(" ")).toContain(
      "resolved historical paragraph boundaries",
    );
    const artifact = await readPublicationArtifact(
      userId,
      bookId,
      completed.artifactId!,
    );
    const provenance = artifact.provenance as unknown as {
      fidelity: {
        reviewSidecar: {
          sections: Array<{
            changes: import("@/documents/model").DocumentChange[];
          }>;
        };
      };
    };
    expect(provenance.fidelity.reviewSidecar.sections[0].changes[0]).toEqual(
      old,
    );
    const files = await validateDocxPackage(Buffer.from(artifact.bytes));
    expect(
      files
        .get("word/document.xml")!
        .toString()
        .match(/<w:del /g),
    ).toHaveLength(1);
    await expect(
      readPublicationArtifact(otherUserId, bookId, completed.artifactId!),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await documentService.read(userId, bookId, sceneId)).document,
    ).toEqual(source.document);
  });
  test("lost acknowledgements recover one immutable artifact after newer manuscript edits", async () => {
    const { request, job } = await create();
    expect(job.status).toBe("pending");
    const body = await documentService.read(userId, bookId, sceneId);
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: body.bookRevisionId,
      scenes: [
        {
          sceneId,
          expectedRevisionId: body.revisionId,
          document: documentFromText("New manuscript text.", randomUUID),
        },
      ],
    });
    const completed = await runPublicationJob(userId, bookId, job.id);
    expect(completed.status).toBe("completed");
    expect(completed.fidelity).toMatchObject({
      fontSubstitutions: [],
      wordAcceptance: "unverified",
      losses: [],
    });
    const artifact = await readPublicationArtifact(
      userId,
      bookId,
      completed.artifactId!,
    );
    const files = await validateDocxPackage(Buffer.from(artifact.bytes));
    expect(files.get("word/document.xml")!.toString()).toContain(
      "Retained exact text",
    );
    expect(files.get("word/document.xml")!.toString()).not.toContain(
      "New manuscript text",
    );
    expect(await createPublicationJob(userId, bookId, request)).toEqual(
      completed,
    );
    expect(await runPublicationJob(userId, bookId, job.id)).toEqual(completed);
    expect(
      await db().documentPublicationArtifact.count({ where: { bookId } }),
    ).toBe(1);
    expect(
      (await documentService.read(userId, bookId, sceneId)).projection.text,
    ).toBe("New manuscript text.");
  });
  test("selected book cover uses exact manifested assets after reselection; submission preset discloses omission", async () => {
    const { mkdir, writeFile, unlink } = await import("node:fs/promises");
    const path = await import("node:path");
    const { imageAssetService } = await import("@/services/imageAssetService");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    const name = "publication-cover-" + randomUUID() + ".png";
    const file = path.resolve("public/images", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    try {
      const [asset] = await imageAssetService.persistAssets({
        userId,
        bookId,
        urls: ["/images/" + name],
        source: "forge",
      });
      const select = async (selectedImageId: number) => {
        const head = await documentService.manifest(userId, bookId);
        return documentService.mutateCatalog(
          userId,
          bookId,
          {
            operationId: randomUUID(),
            expectedRevisionId: head.revisionId,
            expectedScopes: { structure: head.scopes!.structure.revisionId },
            payload: { selectedImageId },
          },
          async (tx) => {
            await tx.book.update({
              where: { id: bookId },
              data: { selectedImageId },
            });
            return { result: null };
          },
        );
      };
      await select(asset.id);
      const head = await documentService.manifest(userId, bookId);
      const coverJob = await createPublicationJob(userId, bookId, {
        operationId: randomUUID(),
        expectedRevisionId: head.revisionId,
        options: { format: "epub", mode: "final", preset: "saved" },
      });
      const submissionJob = await createPublicationJob(userId, bookId, {
        operationId: randomUUID(),
        expectedRevisionId: head.revisionId,
        options: {
          format: "html",
          mode: "final",
          preset: "submission-manuscript",
        },
      });
      await select(0);
      const finished = await runPublicationJob(userId, bookId, coverJob.id);
      expect(finished.status).toBe("completed");
      const artifact = await readPublicationArtifact(
        userId,
        bookId,
        finished.artifactId!,
      );
      const files = await readDocumentPackage(Buffer.from(artifact.bytes));
      expect(files.get("OEBPS/content.opf")!.toString()).toContain(
        'properties="cover-image"',
      );
      expect(files.get("OEBPS/assets/" + asset.id + ".png")).toEqual(bytes);
      expect(files.get("OEBPS/nav.xhtml")!.toString()).toContain(
        'epub:type="cover"',
      );
      expect(files.get("OEBPS/section-0.xhtml")!.toString()).toContain(
        "assets/" + asset.id + ".png",
      );
      const omitted = await runPublicationJob(userId, bookId, submissionJob.id);
      expect(omitted.status).toBe("completed");
      expect(omitted.fidelity?.losses.join(" ")).toContain(
        "omits the selected book cover",
      );
      expect(
        Buffer.from(
          (await readPublicationArtifact(userId, bookId, omitted.artifactId!))
            .bytes,
        ).toString(),
      ).not.toContain("book-cover-image");
    } finally {
      await unlink(file).catch(() => undefined);
      await db().imageAsset.deleteMany({ where: { bookId } });
    }
  });
  test("inherited fractional named font sizes disclose Word half-point rounding", async () => {
    const layout = await documentService.scope(userId, bookId, "layout");
    layout.content.styles.text["fractional"] = { size: 20.1 };
    layout.content.styles.paragraph["fractional"] = {};
    const head = await documentService.manifest(userId, bookId);
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: head.revisionId,
        expectedScopes: { layout: layout.revisionId },
        payload: { layout: layout.content },
      },
      async () => ({ result: null, layout: layout.content }),
    );
    const body = await documentService.read(userId, bookId, sceneId);
    if (body.document.blocks[0].type !== "paragraph")
      throw new Error("fixture");
    body.document.blocks[0].style.name = "fractional";
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: body.bookRevisionId,
      scenes: [
        {
          sceneId,
          expectedRevisionId: body.revisionId,
          document: body.document,
        },
      ],
    });
    const { job } = await create();
    const completed = await runPublicationJob(userId, bookId, job.id);
    expect(completed.status).toBe("completed");
    expect(completed.fidelity?.losses.join(" ")).toContain(
      "Font size 20.1px is represented as 20px",
    );
  });
  test("WebP native exports persist source-bound renderer derivation without overwriting originals", async () => {
    const { chromium } = await import("playwright");
    const { mkdir, writeFile, readFile, unlink } =
      await import("node:fs/promises");
    const path = await import("node:path");
    const { createHash } = await import("node:crypto");
    const { imageAssetService } = await import("@/services/imageAssetService");
    const browser = await chromium.launch({ headless: true });
    let bytes: Buffer;
    try {
      const page = await browser.newPage();
      const uri = await page.evaluate<string>(
        "(()=>{const c=document.createElement('canvas');c.width=16;c.height=12;const x=c.getContext('2d');x.fillStyle='#1e64b4';x.fillRect(0,0,16,12);return c.toDataURL('image/webp',1);})()",
      );
      bytes = Buffer.from(uri.split(",")[1], "base64");
    } finally {
      await browser.close();
    }
    const name = "publication-webp-" + randomUUID() + ".webp";
    const file = path.resolve("public/images", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes!);
    try {
      const [asset] = await imageAssetService.persistAssets({
        userId,
        bookId,
        urls: ["/images/" + name],
        source: "forge",
      });
      const sha = createHash("sha256").update(bytes!).digest("hex");
      const body = await documentService.read(userId, bookId, sceneId);
      body.document.blocks.push({
        type: "image",
        id: randomUUID(),
        assetId: asset.id,
        sha256: sha,
        alt: "WebP provenance",
        width: 16,
        height: 12,
      });
      await documentService.commit(userId, bookId, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: body.bookRevisionId,
        scenes: [
          {
            sceneId,
            expectedRevisionId: body.revisionId,
            document: body.document,
          },
        ],
      });
      const { job } = await create();
      const completed = await runPublicationJob(userId, bookId, job.id);
      expect(completed.status).toBe("completed");
      expect(completed.fidelity?.losses.join(" ")).toContain("PNG derivative");
      const artifact = await readPublicationArtifact(
        userId,
        bookId,
        completed.artifactId!,
      );
      expect(artifact.provenance).toMatchObject({
        sourceRevisionId: job.sourceRevisionId,
        imageDerivations: [
          {
            assetId: asset.id,
            originalSha256: sha,
            originalMediaType: "image/webp",
            derivedMediaType: "image/png",
            width: 16,
            height: 12,
            method: "chromium-static-webp-to-png",
          },
        ],
      });
      expect(await readFile(file)).toEqual(bytes!);
      expect(
        JSON.parse(
          (await db().imageAsset.findUniqueOrThrow({ where: { id: asset.id } }))
            .configJson!,
        ).sha256,
      ).toBe(sha);
    } finally {
      await unlink(file).catch(() => undefined);
      await db().imageAsset.deleteMany({ where: { bookId } });
    }
  });
  test("release fences hold new jobs/renders while exact completed artifacts and accepted in-flight renders recover", async () => {
    const priorFence = await db().releaseAdmissionFence.findUniqueOrThrow({
      where: { id: 1 },
    });
    const head = await documentService.manifest(userId, bookId);
    const request = {
      operationId: randomUUID(),
      expectedRevisionId: head.revisionId,
      options: { format: "docx", mode: "final", preset: "saved" },
    };
    const admission = await admitReleaseMutation(
      "publication-test",
      "fixture",
      request,
      userId,
    );
    const job = await withReleaseAdmission(admission.id, () =>
      createPublicationJob(userId, bookId, request),
    );
    expect(
      await db().releaseAdmissionBinding.findFirst({
        where: {
          admissionId: admission.id,
          domainKind: "publication",
          domainId: job.id,
        },
      }),
    ).toMatchObject({
      sourceBookId: bookId,
      sourceRevisionId: head.revisionId,
      sourceHash: job.sourceHash,
    });
    const close = () =>
      db().releaseAdmissionFence.update({
        where: { id: 1 },
        data: {
          phase: "fenced",
          generation: priorFence.generation + 1,
          cutoff: new Date(),
        },
      });
    try {
      await close();
      await expect(
        createPublicationJob(userId, bookId, {
          ...request,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "DOCUMENT_ADMISSIONS_FENCED",
        status: 503,
      });
      expect(await createPublicationJob(userId, bookId, request)).toEqual(job);
      await expect(
        runPublicationJob(userId, bookId, job.id),
      ).rejects.toMatchObject({
        code: "DOCUMENT_ADMISSIONS_FENCED",
        status: 503,
      });
      expect((await readPublicationJob(userId, bookId, job.id)).status).toBe(
        "pending",
      );
      await db().releaseAdmissionFence.update({
        where: { id: 1 },
        data: priorFence,
      });
      const original = publicationDocxModule.publicationDocxDetailed;
      const render = jest
        .spyOn(publicationDocxModule, "publicationDocxDetailed")
        .mockImplementationOnce(async (...args) => {
          await close();
          return original(...args);
        });
      const completed = await runPublicationJob(userId, bookId, job.id);
      render.mockRestore();
      expect(completed.status).toBe("completed");
      expect(
        await db().releaseAdmissionBinding.findFirst({
          where: { domainKind: "publication-render", domainId: job.id },
        }),
      ).toMatchObject({
        sourceBookId: bookId,
        sourceRevisionId: head.revisionId,
        sourceHash: job.sourceHash,
      });
      expect(await runPublicationJob(userId, bookId, job.id)).toEqual(
        completed,
      );
      expect(await createPublicationJob(userId, bookId, request)).toEqual(
        completed,
      );
      expect(
        Buffer.from(
          (await readPublicationArtifact(userId, bookId, completed.artifactId!))
            .bytes,
        )
          .subarray(0, 2)
          .toString(),
      ).toBe("PK");
    } finally {
      jest.restoreAllMocks();
      await db().releaseAdmissionFence.update({
        where: { id: 1 },
        data: priorFence,
      });
    }
  });
  test("stale admission and operation ID reuse fail while ownership protects jobs and bytes", async () => {
    const { request, job } = await create();
    await expect(
      createPublicationJob(userId, bookId, {
        ...request,
        options: { ...request.options, format: "epub" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createPublicationJob(userId, bookId, {
        ...request,
        operationId: randomUUID(),
        expectedRevisionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      readPublicationJob(otherUserId, bookId, job.id),
    ).rejects.toMatchObject({
      status: 404,
    });
    const complete = await runPublicationJob(userId, bookId, job.id);
    await expect(
      readPublicationArtifact(otherUserId, bookId, complete.artifactId!),
    ).rejects.toMatchObject({ status: 404 });
  });
  test("cancelled jobs never complete and capabilities disclose real renderer availability", async () => {
    const { job } = await create();
    await cancelPublicationJob(userId, bookId, job.id);
    expect((await runPublicationJob(userId, bookId, job.id)).status).toBe(
      "cancelled",
    );
    expect(
      await db().documentPublicationArtifact.count({ where: { bookId } }),
    ).toBe(0);
    expect(
      (await publicationCapabilities(userId, bookId)).formats.find(
        (format) => format.format === "pdf",
      )!.available,
    ).toBe(true);
  });
  test.each(["epub", "html", "markdown", "text", "json"] as const)(
    "persists genuine %s artifacts and provenance",
    async (format) => {
      const { job } = await create(format);
      const result = await runPublicationJob(userId, bookId, job.id);
      expect(result.status).toBe("completed");
      const artifact = await readPublicationArtifact(
        userId,
        bookId,
        result.artifactId!,
      );
      expect(artifact.sha256).toHaveLength(64);
      expect(artifact.provenance).toMatchObject({
        sourceRevisionId: job.sourceRevisionId,
        options: { format },
        fidelity: { wordAcceptance: "unverified" },
      });
    },
  );
  test("activation retains original checksum-addressed Markdown history after canonical edits without rewriting old manifests", async () => {
    const fs = await import("node:fs/promises"),
      os = await import("node:os"),
      path = await import("node:path");
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "proser-original-export-"),
      ),
      priorRoot = process.env.EXPORT_ARTIFACT_DIR,
      priorAuthority = process.env.DOCUMENT_AUTHORITY_ENABLED;
    try {
      process.env.EXPORT_ARTIFACT_DIR = directory;
      process.env.DOCUMENT_AUTHORITY_ENABLED = "false";
      const original = await ExportArtifactService.create(userId, bookId);
      const manifestPath = path.join(
          directory,
          String(userId),
          String(bookId),
          original.artifactId + ".json",
        ),
        bytesPath = path.join(
          directory,
          String(userId),
          String(bookId),
          original.artifactId + ".md",
        );
      const beforeManifest = await fs.readFile(manifestPath),
        beforeBytes = await fs.readFile(bytesPath);
      process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
      const source = await documentService.read(userId, bookId, sceneId),
        p = source.document.blocks[0];
      if (p.type !== "paragraph") throw new Error("fixture");
      p.runs[0].text = "Newer complete canonical scene.";
      await documentService.commit(userId, bookId, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: source.bookRevisionId,
        scenes: [
          {
            sceneId,
            expectedRevisionId: source.revisionId,
            document: source.document,
          },
        ],
      });
      expect(
        await ExportArtifactService.get(userId, bookId, original.artifactId),
      ).toEqual(original);
      expect(
        (
          await ExportArtifactService.read(
            userId,
            bookId,
            original.artifactId,
            { scope: "book", offset: 0, maxChars: 500 },
          )
        ).content,
      ).toBe(beforeBytes.toString());
      expect(
        (
          await ExportArtifactService.download(
            userId,
            bookId,
            original.artifactId,
          )
        ).path,
      ).toBe(bytesPath);
      expect(await fs.readFile(manifestPath)).toEqual(beforeManifest);
      expect(await fs.readFile(bytesPath)).toEqual(beforeBytes);
      await expect(
        ExportArtifactService.get(otherUserId, bookId, original.artifactId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        ExportArtifactService.delete(userId, bookId, original.artifactId),
      ).rejects.toMatchObject({ code: "PUBLICATION_ARTIFACT_IMMUTABLE" });
      await fs.writeFile(bytesPath, "corrupt fixture");
      await expect(
        ExportArtifactService.get(userId, bookId, original.artifactId),
      ).rejects.toMatchObject({ code: "PUBLICATION_ARTIFACT_INVALID" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      if (priorRoot === undefined) delete process.env.EXPORT_ARTIFACT_DIR;
      else process.env.EXPORT_ARTIFACT_DIR = priorRoot;
      if (priorAuthority === undefined)
        delete process.env.DOCUMENT_AUTHORITY_ENABLED;
      else process.env.DOCUMENT_AUTHORITY_ENABLED = priorAuthority;
    }
  });
  test("checksum aliases cannot guess between distinct immutable publication provenance; exact canonical UUID remains readable", async () => {
    const prior = process.env.DOCUMENT_AUTHORITY_ENABLED;
    process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
    try {
      const one = await create("markdown"),
        two = await create("markdown");
      const first = await runPublicationJob(userId, bookId, one.job.id),
        second = await runPublicationJob(userId, bookId, two.job.id);
      const a = await readPublicationArtifact(
          userId,
          bookId,
          first.artifactId!,
        ),
        b = await readPublicationArtifact(userId, bookId, second.artifactId!);
      expect(a.sha256).toBe(b.sha256);
      await expect(
        ExportArtifactService.get(userId, bookId, a.sha256),
      ).rejects.toMatchObject({ code: "PUBLICATION_ARTIFACT_ALIAS_AMBIGUOUS" });
      expect(
        await ExportArtifactService.get(userId, bookId, a.id),
      ).toMatchObject({ artifactId: a.id, sha256: a.sha256 });
    } finally {
      if (prior === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED;
      else process.env.DOCUMENT_AUTHORITY_ENABLED = prior;
    }
  });
  test("compatibility Markdown artifact readers use retained canonical bytes and preserve rich formatting after newer edits", async () => {
    const previous = process.env.DOCUMENT_AUTHORITY_ENABLED;
    process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
    try {
      const original = await documentService.read(userId, bookId, sceneId);
      const block = original.document.blocks[0];
      if (block.type !== "paragraph") throw new Error("fixture");
      block.runs[0].style.bold = true;
      await documentService.commit(userId, bookId, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: original.bookRevisionId,
        scenes: [
          {
            sceneId,
            expectedRevisionId: original.revisionId,
            document: original.document,
          },
        ],
      });
      await expect(
        ExportArtifactService.create(userId, bookId),
      ).rejects.toMatchObject({ status: 428 });
      const manifest = await documentService.manifest(userId, bookId);
      const options = {
        operationId: randomUUID(),
        expectedRevisionId: manifest.revisionId,
      };
      const created = await ExportArtifactService.create(
        userId,
        bookId,
        options,
      );
      expect(
        await ExportArtifactService.create(userId, bookId, options),
      ).toEqual(created);
      expect(created.fidelity?.losses.join(" ")).toContain(
        "reduced formatting",
      );
      expect(created.operationId).toBe(options.operationId);
      expect(created.sourceRevisionId).toBe(manifest.revisionId);
      expect(created.artifactId).toMatch(/^[a-f0-9]{64}$/);
      expect(created.artifactId).toBe(created.sha256);
      expect(created.tableOfContents[0].scenes[0].id).toBe(sceneId);
      const current = await documentService.read(userId, bookId, sceneId);
      await documentService.commit(userId, bookId, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: current.bookRevisionId,
        scenes: [
          {
            sceneId,
            expectedRevisionId: current.revisionId,
            document: documentFromText("Later edited text.", randomUUID),
          },
        ],
      });
      const read = await ExportArtifactService.read(
        userId,
        bookId,
        created.artifactId,
        {
          scope: "scene",
          sceneId,
        },
      );
      expect(read.content).toContain("**Retained exact text 😀.**");
      expect(read.content).not.toContain("Later edited text.");
      expect(
        await ExportArtifactService.get(userId, bookId, created.artifactId),
      ).toEqual(created);
      await expect(
        ExportArtifactService.get(otherUserId, bookId, created.artifactId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        ExportArtifactService.delete(userId, bookId, created.artifactId),
      ).rejects.toMatchObject({ code: "PUBLICATION_ARTIFACT_IMMUTABLE" });
    } finally {
      if (previous === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED;
      else process.env.DOCUMENT_AUTHORITY_ENABLED = previous;
    }
  });
});
