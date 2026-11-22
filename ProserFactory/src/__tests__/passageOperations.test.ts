import type {DocumentPassageSourceFrame} from '@/documents/passage-model';
import { randomUUID } from "node:crypto";
import {
  documentFromText,
  projectDocument,
  resolveChange,
  canonicalDocument,
  type ProserDocument,
  type DocumentParagraph,
  type DocumentChange,
  type DocumentTable,
} from "@/documents/model";
import {
  applyPassageOperations,
  type PassageOperationOptions,
} from "@/documents/passageOperations";
import {
  operationSourceHash,
  bodyParagraphs,
  passageOperationRunSource,
  passageOperationParagraphSource,
  passageOperationObjectSource,
  passageOperationPlacement,
  passageBoundaryHash,
  passageReviewTargetHash,
  passageChangeSummary,
  passageTableRowHash,
  passageTableColumnHash,
  refreshPassageOperationMappings,
  passageReviewHistoryPage,
  emptyPassageBodyPlacement,
} from "@/documents/passageOperationSources";
import {
  passageRunSpan,
  rebasePassageRunSource,
  type DocumentPassageOperation,
} from "@/documents/passage-operations-model";
import { stampDocumentReview } from "@/documents/reviewAttribution";
import { validateAnchorLineage } from "@/documents/lineage";
import { validateDocument } from "@/documents/validation";
const paragraph = (doc: ProserDocument, index = 0) => {
  const item = doc.blocks[index];
  if (item.type !== "paragraph") throw new Error("fixture");
  return item;
};
function options(
  document: ProserDocument,
  tracking = false,
): PassageOperationOptions & {sourceFrame:DocumentPassageSourceFrame} {
  return {
    operationId: randomUUID(),
    sourceFrame: {
      bookId: 1,
      actId: 1,
      chapterId: 1,
      sceneId: 1,
      bookRevisionId: randomUUID(),
      bookContentHash: "a".repeat(64),
      sceneRevisionId: randomUUID(),
      sceneContentHash: operationSourceHash(document),
      qualifiedMembershipHash: "b".repeat(64),
      structureScope: { revisionId: randomUUID(), contentHash: "c".repeat(64) },
      layoutScope: { revisionId: randomUUID(), contentHash: "d".repeat(64) },
      effectiveStyleLayoutHash: "e".repeat(64),
      projection: "final",
    },
    actor: {
      id: 8,
      name: "Owned author",
      createdAt: "2026-10-06T00:00:00.000Z",
      origin: "manual",
    },
    tracking,
    window: {
      runs: bodyParagraphs(document).flatMap((p) =>
        p.runs.map((r) => passageOperationRunSource(document, p.id, r.id)),
      ),
      paragraphIds: bodyParagraphs(document).map((p) => p.id),
      objectIds: document.blocks
        .filter((block) => block.type !== "paragraph")
        .map((block) => block.id)
        .concat(
          bodyParagraphs(document).flatMap((p) =>
            p.runs.filter((r) => r.inlineImage).map((r) => r.id),
          ),
        ),
      neighborIds: document.blocks.map((block) => block.id),
      changeIds: document.changes.map((change) => change.id),
      rowIds: document.blocks.flatMap((block) =>
        block.type === "table" ? block.rows.map((row) => row.id) : [],
      ),
    },
  };
}
const edit = (
  document: ProserDocument,
  from: number,
  to: number,
  replacement: string,
): DocumentPassageOperation => {
  const p = paragraph(document);
  return {
    id: randomUUID(),
    kind: "text",
    target: passageOperationRunSource(document, p.id, p.runs[0].id, from, to),
    expectedText: p.runs[0].text.slice(from, to),
    replacement,
  };
};
const apply = (
  document: ProserDocument,
  op: DocumentPassageOperation,
  tracking = false,
) => applyPassageOperations(document, [op], options(document, tracking));
function tableFixture() {
  const doc = documentFromText("Outside styles.", randomUUID);
  const table: DocumentTable = {
    type: "table",
    id: randomUUID(),
    widths: [80, 120],
    rows: Array.from({ length: 2 }, () => ({
      id: randomUUID(),
      cells: Array.from({ length: 2 }, () => ({
        id: randomUUID(),
        paragraphs: documentFromText("Cell 😀 text", randomUUID)
          .blocks as DocumentParagraph[],
      })),
    })),
  };
  doc.blocks.push(table);
  return { doc, table };
}

describe("bounded exact canonical passage operations", () => {
  test("image-only and empty bodies gain exact deterministic editable paragraphs with genuine optional insertion review",()=>{
    const doc=documentFromText("",randomUUID);doc.blocks=[{type:"pageBreak",id:randomUUID()}];
    const op:DocumentPassageOperation={id:randomUUID(),kind:"insert-paragraph",placement:passageOperationPlacement(doc,doc.blocks[0].id,"after"),style:{alignment:"center"}};
    const config=options(doc,true),first=applyPassageOperations(doc,[op],config),second=applyPassageOperations(doc,[op],config);expect(first).toEqual(second);const p=paragraph(first.document,1);expect(p.style).toEqual({alignment:"center"});expect(p.runs[0]).toMatchObject({text:"",style:{}});expect(first.document.changes[0]).toMatchObject({kind:"paragraphInsertion",status:"pending",targetBlockIds:[p.id]});expect(projectDocument(first.document,"original").spans.some(span=>span.blockId===p.id)).toBe(false);expect(first.introducedIds.map(item=>item.role)).toEqual(["paragraph","paragraph-run","paragraph-insertion"]);
    const direct=apply(doc,op,false);expect(direct.document.changes).toEqual([]);expect(paragraph(direct.document,1).changeId).toBeUndefined();
    const empty=documentFromText("",randomUUID);empty.blocks=[];const emptyOp:DocumentPassageOperation={id:randomUUID(),kind:"insert-paragraph",placement:emptyPassageBodyPlacement()};const emptyConfig=options(empty);emptyConfig.window.neighborIds=[emptyOp.placement.neighborId];const inserted=applyPassageOperations(empty,[emptyOp],emptyConfig);expect(projectDocument(inserted.document).text).toBe("");expect(inserted.document.blocks).toHaveLength(1);expect(paragraph(inserted.document).runs).toHaveLength(1);
    expect(()=>applyPassageOperations(empty,[emptyOp],options(empty))).toThrow("outside");expect(()=>applyPassageOperations(empty,[{...emptyOp,placement:{...emptyOp.placement,neighborHash:"a".repeat(64)}}],emptyConfig)).toThrow();expect(()=>applyPassageOperations(doc,[{...op,style:{name:"undefined-style"}}],{...options(doc),styles:{paragraph:{},text:{}}})).toThrow("style");
  });
  test("tracked text is exact, attributed from server and stable on lost-ack replay, untouched paragraphs/layout survive", () => {
    const doc = documentFromText("ABCD\n\nUntouched.", randomUUID);
    paragraph(doc).runs[0].style = { bold: true };
    const op = edit(doc, 1, 2, "X");
    const config = options(doc, true);
    const next = applyPassageOperations(doc, [op], config);
    expect(projectDocument(next.document).text).toBe("AXCD\n\nUntouched.");
    expect(projectDocument(next.document, "original").text).toBe(
      "ABCD\n\nUntouched.",
    );
    expect(next.document.blocks[1]).toEqual(doc.blocks[1]);
    expect(next.document.layout).toEqual(doc.layout);
    expect(next.document.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "manual",
          authorId: 8,
          status: "pending",
        }),
      ]),
    );
    expect(applyPassageOperations(doc, [op], config)).toEqual(next);
    expect(doc.changes).toEqual([]);
  });
  test("formatting preserves exact untouched segments and produces before/after revisions; unmodified source lineage validates", () => {
    const doc = documentFromText("ABCD", randomUUID);
    const p = paragraph(doc);
    const source = passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 3);
    const next = apply(
      doc,
      {
        id: randomUUID(),
        kind: "run-format",
        target: source,
        expectedText: "BC",
        patch: { set: { bold: true, color: "#123456" } },
      },
      true,
    );
    expect(
      paragraph(next.document).runs.map((run) => [run.text, run.style]),
    ).toEqual([
      ["A", {}],
      ["BC", { bold: true, color: "#123456" }],
      ["D", {}],
    ]);
    expect(next.document.changes[0]).toMatchObject({
      kind: "format",
      beforeStyle: {},
      afterStyle: { bold: true, color: "#123456" },
      status: "pending",
    });
    expect(projectDocument(next.document, "original").text).toBe("ABCD");
    expect(() =>
      validateAnchorLineage(next.anchorLineage, [
        { sceneId: 1, previous: doc, next: next.document },
      ]),
    ).not.toThrow();
  });
  test("paragraph style set/unset preserves raw values and tracking reverses only requested supported properties", () => {
    const doc = documentFromText("Preserve.", randomUUID);
    const p = paragraph(doc);
    p.style = { name: "Normal", indent: 40, alignment: "left" };
    const next = apply(
      doc,
      {
        id: randomUUID(),
        kind: "paragraph-format",
        target: passageOperationParagraphSource(doc, p.id),
        patch: { set: { alignment: "right", heading: 2 }, unset: ["indent"] },
      },
      true,
    );
    expect(paragraph(next.document).style).toEqual({
      name: "Normal",
      alignment: "right",
      heading: 2,
    });
    expect(
      paragraph(
        resolveChange(next.document, next.document.changes[0].id, "rejected"),
      ).style,
    ).toEqual(p.style);
  });
  test("split carries stable run/image identities, native mark history, exact original text and verified comment lineage", () => {
    const doc = documentFromText("ABCD", randomUUID);
    const p = paragraph(doc);
    const run = p.runs[0];
    doc.comments = [
      {
        id: randomUUID(),
        authorId: 8,
        authorName: "Author",
        createdAt: "2026-10-06T00:00:00.000Z",
        text: "Cross split.",
        anchors: [
          { blockId: p.id, runId: run.id, start: 1, end: 3, sourceText: "BC" },
        ],
        resolved: false,
      },
    ];
    const next = apply(
      doc,
      {
        id: randomUUID(),
        kind: "paragraph-split",
        target: passageOperationRunSource(doc, p.id, run.id, 2, 2),
        expectedText: "",
      },
      true,
    );
    expect(projectDocument(next.document).text).toBe("AB\n\nCD");
    expect(projectDocument(next.document, "original").text).toBe("ABCD");
    expect(paragraph(next.document).id).toBe(p.id);
    expect(next.document.comments).toEqual(doc.comments);
    expect(() =>
      validateAnchorLineage(next.anchorLineage, [
        { sceneId: 1, previous: doc, next: next.document },
      ]),
    ).not.toThrow();
    expect(next.document.changes[0]).toMatchObject({
      kind: "paragraphSplit",
      origin: "manual",
      authorId: 8,
    });
  });
  test("join retains both physical paragraphs/styles and pending mark resolution restores separator", () => {
    const doc = documentFromText("A\n\nB", randomUUID);
    const left = paragraph(doc);
    const right = paragraph(doc, 1);
    const next = apply(
      doc,
      {
        id: randomUUID(),
        kind: "paragraph-join",
        left: passageOperationParagraphSource(doc, left.id),
        right: passageOperationParagraphSource(doc, right.id),
        boundaryHash: passageBoundaryHash(doc, left.id, right.id),
      },
      true,
    );
    expect(next.document.blocks.map((block) => block.id)).toEqual(
      doc.blocks.map((block) => block.id),
    );
    expect(projectDocument(next.document).text).toBe("AB");
    expect(projectDocument(next.document, "original").text).toBe("A\n\nB");
    expect(
      projectDocument(
        resolveChange(next.document, next.document.changes[0].id, "rejected"),
      ).text,
    ).toBe("A\n\nB");
  });
  test("resolved boundary re-edit derives a candidate requiring server-attested immutable history, while pending boundaries remain protected", () => {
    const doc = documentFromText("A\n\nB", randomUUID),
      left = paragraph(doc),
      right = paragraph(doc, 1);
    const id = randomUUID();
    left.boundaryChangeId = id;
    doc.changes.push({
      id,
      kind: "paragraphSplit",
      status: "accepted",
      origin: "manual",
      authorId: 8,
      authorName: "Owned author",
      createdAt: "2026-10-06T00:00:00.000Z",
      targetRunIds: [],
      targetBlockIds: [left.id, right.id],
    });
    const op: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "paragraph-join",
      left: passageOperationParagraphSource(doc, left.id),
      right: passageOperationParagraphSource(doc, right.id),
      boundaryHash: passageBoundaryHash(doc, left.id, right.id),
    };
    const config = options(doc, true),
      result = applyPassageOperations(doc, [op], config);
    expect(result.document.changes[0]).toEqual(doc.changes[0]);
    expect(() => validateDocument(result.document)).toThrow("linked adjacent");
    stampDocumentReview(
      result.document,
      doc,
      { id: 8, name: "Owned author" },
      "manual",
      false,
      {
        operationId: config.operationId,
        sourceKind: "scene",
        sourceSceneId: 1,
        sourceSceneRevisionId: config.sourceFrame.sceneRevisionId,
        sourceBookRevisionId: config.sourceFrame.bookRevisionId,
        sourceContentHash: config.sourceFrame.bookContentHash,
      },
    );
    expect(
      validateDocument(result.document).changes[0].historicalBoundarySource,
    ).toMatchObject({
      sourceSceneRevisionId: config.sourceFrame.sceneRevisionId,
    });
    const pending = structuredClone(doc);
    pending.changes[0].status = "pending";
    const pendingOp = {
      ...op,
      left: passageOperationParagraphSource(pending, left.id),
      right: passageOperationParagraphSource(pending, right.id),
      boundaryHash: passageBoundaryHash(pending, left.id, right.id),
    };
    expect(() =>
      applyPassageOperations(pending, [pendingOp], options(pending, true)),
    ).toThrow("history");
  });
  test("hyperlink target edits require explicit direct mode; genuine supported formatting and text retain existing hyperlinks", () => {
    const doc = documentFromText("Linked text", randomUUID),
      p = paragraph(doc);
    p.runs[0].style = { hyperlink: "https://example.com/original" };
    const target = passageOperationRunSource(doc, p.id, p.runs[0].id),
      op: DocumentPassageOperation = {
        id: randomUUID(),
        kind: "run-format",
        target,
        expectedText: "Linked text",
        patch: { set: { hyperlink: "https://example.com/new" } },
      };
    expect(() => apply(doc, op, true)).toThrow("hyperlink-target");
    expect(() =>
      apply(doc, { ...op, patch: { unset: ["hyperlink"] } }, true),
    ).toThrow("hyperlink-target");
    const direct = apply(doc, op, false);
    expect(paragraph(direct.document).runs[0].style.hyperlink).toBe(
      "https://example.com/new",
    );
    expect(direct.document.changes).toEqual([]);
    const formatted = apply(
      doc,
      { ...op, patch: { set: { bold: true } } },
      true,
    );
    expect(formatted.document.changes[0]).toMatchObject({
      kind: "format",
      beforeStyle: { hyperlink: "https://example.com/original" },
      afterStyle: { hyperlink: "https://example.com/original", bold: true },
    });
    const inserted = apply(doc, edit(doc, 0, 0, "New "), true);
    expect(paragraph(inserted.document).runs[0].style.hyperlink).toBe(
      "https://example.com/original",
    );
  });
  test("own pending manual insertion continuation retains immutable attribution and original view; imported/AI/deletions remain protected", () => {
    const doc = documentFromText("NEW", randomUUID);
    const p = paragraph(doc);
    const id = randomUUID();
    p.runs[0].changeId = id;
    doc.changes = [
      {
        id,
        kind: "insertion",
        targetRunIds: [p.runs[0].id],
        authorId: 8,
        authorName: "Original actor",
        createdAt: "2026-10-05T00:00:00.000Z",
        origin: "manual",
        status: "pending",
      },
    ];
    const next = apply(doc, edit(doc, 3, 3, "X"), true);
    expect(doc.changes).toEqual(next.document.changes);
    expect(projectDocument(next.document).text).toBe("NEWX");
    expect(projectDocument(next.document, "original").text).toBe("");
    expect(() =>
      stampDocumentReview(next.document, doc, { id: 8, name: "Author" }),
    ).not.toThrow();
    doc.changes[0].importedAuthor = "Word author";
    expect(() => apply(doc, edit(doc, 3, 3, "X"), true)).toThrow("pending");
    doc.changes[0].importedAuthor = undefined;
    doc.changes[0].origin = "ai";
    expect(() => apply(doc, edit(doc, 3, 3, "X"), true)).toThrow("pending");
  });
  test("Unicode boundaries across style runs and clipped window bounds reject before mutation; stale style/object hashes cannot relocate", () => {
    const doc = documentFromText("A👩🏽‍🚀B", randomUUID);
    const p = paragraph(doc);
    const op = edit(doc, 3, 3, "X");
    expect(() => apply(doc, op)).toThrow("Unicode");
    const valid = edit(doc, 1, 8, "X");
    const config = options(doc);
    config.window.runs[0].to = 1;
    expect(() => applyPassageOperations(doc, [valid], config)).toThrow(
      "outside",
    );
    const stale = structuredClone(valid);
    if (stale.kind !== "text") throw new Error("fixture");
    stale.target.sourceHash = "a".repeat(64);
    expect(() => apply(doc, stale)).toThrow();
    p.runs = [
      { id: randomUUID(), text: "e", style: {} },
      { id: randomUUID(), text: "́", style: { bold: true } },
    ];
    const split: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "paragraph-split",
      target: passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 1),
      expectedText: "",
    };
    expect(() => apply(doc, split)).toThrow("grapheme");
  });
  test("typing/formatting requests cannot forge attribution/history, malformed URLs, duplicate IDs or actor publication authority", () => {
    const doc = documentFromText("ABC", randomUUID);
    const op = edit(doc, 0, 1, "X");
    expect(() =>
      applyPassageOperations(doc, [{ ...op, authorId: 999 }], options(doc)),
    ).toThrow("typed operations");
    expect(() => applyPassageOperations(doc, [op, op], options(doc))).toThrow(
      "typed operations",
    );
    const p = paragraph(doc);
    expect(() =>
      apply(doc, {
        id: randomUUID(),
        kind: "run-format",
        target: passageOperationRunSource(doc, p.id, p.runs[0].id),
        expectedText: "ABC",
        patch: { set: { hyperlink: "file:///secret" } },
      }),
    ).toThrow("typed operations");
    const config = options(doc);
    config.actor.origin = "ai";
    expect(() =>
      applyPassageOperations(
        doc,
        [
          {
            id: randomUUID(),
            kind: "paragraph-format",
            target: passageOperationParagraphSource(doc, p.id),
            patch: { set: { heading: 1 } },
          },
        ],
        config,
      ),
    ).toThrow("only exact text");
  });
  test("bounded review summary retains full-record/target hashes and out-of-window count without returning long authenticated history", () => {
    const doc = documentFromText("A\n\nB", randomUUID);
    const left = paragraph(doc);
    const right = paragraph(doc, 1);
    const id = randomUUID();
    const record: DocumentChange = {
      id,
      kind: "format",
      targetRunIds: [left.runs[0].id, right.runs[0].id],
      authorId: 8,
      authorName: "Author",
      createdAt: "2026-10-06T00:00:00.000Z",
      origin: "manual",
      status: "pending",
      beforeStyle: {},
      afterStyle: { bold: true },
    };
    left.runs[0].style = { bold: true };
    right.runs[0].style = { bold: true };
    doc.changes = [record];
    const summary = passageChangeSummary(
      doc,
      id,
      new Set([left.runs[0].id]),
      new Set([left.id]),
    );
    expect(summary).toMatchObject({
      targetRunCount: 2,
      visibleRunIds: [left.runs[0].id],
      continuedOutsideWindow: true,
      recordHash: operationSourceHash(record),
      targetHash: passageReviewTargetHash(doc, record),
    });
    expect(summary).not.toHaveProperty("resolutionHistory");
    const next = apply(doc, {
      id: randomUUID(),
      kind: "resolve-change",
      changeId: id,
      changeHash: summary.recordHash,
      targetHash: summary.targetHash,
      decision: "rejected",
    });
    expect(paragraph(next.document).runs[0].style).toEqual({});
    expect(paragraph(next.document, 1).runs[0].style).toEqual({});
    expect(next.document.changes[0].authorName).toBe("Author");
  });
  test("owned image insertion preserves unrelated style; arbitrary assets/unsupported tracked object edits visibly fail", () => {
    const doc = documentFromText("AB", randomUUID);
    const p = paragraph(doc);
    const image = {
      assetId: 7,
      sha256: "a".repeat(64),
      alt: "Owned image",
      width: 20,
      height: 10,
    };
    const op: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "insert-inline-image",
      target: passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 1),
      image,
    };
    expect(() => apply(doc, op)).toThrow("verified");
    const config = options(doc);
    config.verifiedAssets = new Map([[7, image.sha256]]);
    const next = applyPassageOperations(doc, [op], config);
    expect(projectDocument(next.document).text).toBe("A\uFFFCB");
    expect(paragraph(next.document).runs[1].inlineImage).toEqual(image);
    expect(() =>
      applyPassageOperations(doc, [op], { ...config, tracking: true }),
    ).toThrow("native text revision");
  });
  test("table cell edits preserve table structure, other cells, images and exact UTF16 style/run identity", () => {
    const { doc, table } = tableFixture();
    const p = table.rows[0].cells[0].paragraphs[0];
    const op: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "text",
      target: passageOperationRunSource(doc, p.id, p.runs[0].id, 0, 4),
      expectedText: "Cell",
      replacement: "Edited",
    };
    const next = apply(doc, op, true);
    const saved = next.document.blocks[1];
    if (saved.type !== "table") throw new Error("fixture");
    expect(saved.id).toBe(table.id);
    expect(saved.rows[1]).toEqual(table.rows[1]);
    expect(saved.rows[0].cells[1]).toEqual(table.rows[0].cells[1]);
    expect(
      saved.rows[0].cells[0].paragraphs[0].runs.map((r) => r.text).join(""),
    ).toBe("CellEdited 😀 text");
    expect(projectDocument(next.document).text).toContain("Edited 😀 text");
    expect(validateDocument(next.document).blocks).toEqual(
      next.document.blocks,
    );
  });
  test("table width/row/column operations retain unchanged IDs, require exact hashes and cannot pretend native tracked revisions", () => {
    const { doc, table } = tableFixture();
    const target = passageOperationObjectSource(doc, table.id);
    const resized = apply(doc, {
      id: randomUUID(),
      kind: "table-widths",
      target,
      widths: [100, 100],
    });
    const resizedTable = resized.document.blocks[1];
    if (resizedTable.type !== "table") throw new Error("fixture");
    expect(resizedTable.rows).toEqual(table.rows);
    const removed = apply(doc, {
      id: randomUUID(),
      kind: "table-remove-row",
      target,
      rowId: table.rows[0].id,
      rowHash: passageTableRowHash(table.rows[0]),
    });
    const removedTable = removed.document.blocks[1];
    if (removedTable.type !== "table") throw new Error("fixture");
    expect(removedTable.rows).toEqual([table.rows[1]]);
    const column = apply(doc, {
      id: randomUUID(),
      kind: "table-remove-column",
      target,
      column: 0,
      columnHash: passageTableColumnHash(table, 0),
    }).document.blocks[1];
    if (column.type !== "table") throw new Error("fixture");
    expect(column.rows.map((row) => row.cells[0].id)).toEqual(
      table.rows.map((row) => row.cells[1].id),
    );
    expect(() =>
      apply(
        doc,
        { id: randomUUID(), kind: "table-widths", target, widths: [100, 100] },
        true,
      ),
    ).toThrow("native Word");
  });
  test("direct image update/removal is asset-bound and preserves exact surrounding content", () => {
    const doc = documentFromText("Text", randomUUID),
      p = paragraph(doc);
    const image = {
      assetId: 7,
      sha256: "a".repeat(64),
      alt: "First",
      width: 20,
      height: 10,
    };
    const config = options(doc);
    config.verifiedAssets = new Map([[7, image.sha256]]);
    const inserted = applyPassageOperations(
      doc,
      [
        {
          id: randomUUID(),
          kind: "insert-image",
          placement: passageOperationPlacement(doc, p.id, "after"),
          image,
        },
      ],
      config,
    ).document;
    const picture = inserted.blocks[1];
    if (picture.type !== "image") throw new Error("fixture");
    const updateConfig = options(inserted);
    updateConfig.verifiedAssets = config.verifiedAssets;
    const updated = applyPassageOperations(
      inserted,
      [
        {
          id: randomUUID(),
          kind: "update-image",
          target: passageOperationObjectSource(inserted, picture.id),
          image: { ...image, alt: "Changed caption", width: 40 },
        },
      ],
      updateConfig,
    ).document;
    expect(updated.blocks[0]).toEqual(doc.blocks[0]);
    expect(updated.blocks[1]).toMatchObject({
      id: picture.id,
      alt: "Changed caption",
      width: 40,
    });
    const removed = apply(updated, {
      id: randomUUID(),
      kind: "remove-object",
      target: passageOperationObjectSource(updated, picture.id),
    }).document;
    expect(removed.blocks).toEqual(doc.blocks);
  });
  test("table row/column insertion uses deterministic owned IDs without rewriting existing cells", () => {
    const { doc, table } = tableFixture(),
      target = passageOperationObjectSource(doc, table.id);
    const rowOp: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "table-insert-row",
      target,
      rowId: table.rows[0].id,
      side: "after",
    };
    const config = options(doc),
      rowResult = applyPassageOperations(doc, [rowOp], config),
      rowTable = rowResult.document.blocks[1];
    if (rowTable.type !== "table") throw new Error("fixture");
    expect(rowTable.rows).toHaveLength(3);
    expect(rowTable.rows[0]).toEqual(table.rows[0]);
    expect(rowTable.rows[2]).toEqual(table.rows[1]);
    expect(
      rowTable.rows[1].cells.map((cell) => cell.paragraphs[0].runs[0].text),
    ).toEqual(["", ""]);
    expect(applyPassageOperations(doc, [rowOp], config)).toEqual(rowResult);
    const column = apply(doc, {
      id: randomUUID(),
      kind: "table-insert-column",
      target,
      column: 1,
      width: 50,
    }).document.blocks[1];
    if (column.type !== "table") throw new Error("fixture");
    expect(column.widths).toEqual([80, 50, 120]);
    for (const [index, row] of column.rows.entries()) {
      expect(row.cells[0]).toEqual(table.rows[index].cells[0]);
      expect(row.cells[2]).toEqual(table.rows[index].cells[1]);
    }
  });
  test("no-op text/style intents preserve canonical identity and create no manufactured review records", () => {
    const doc = documentFromText("AB", randomUUID),
      p = paragraph(doc);
    const same = apply(doc, edit(doc, 0, 2, "AB"), true);
    expect(same.document).toEqual(doc);
    expect(same.introducedIds).toEqual([]);
    expect(same.operationMappings).toHaveLength(1);
    const style = apply(
      doc,
      {
        id: randomUUID(),
        kind: "run-format",
        target: passageOperationRunSource(doc, p.id, p.runs[0].id),
        expectedText: "AB",
        patch: { unset: ["italic"] },
      },
      true,
    );
    expect(style.document).toEqual(doc);
    expect(style.introducedIds).toEqual([]);
  });
  test("page break placement and small table creation preserve exact neighboring content; stale neighbors fail", () => {
    const doc = documentFromText("A\n\nB", randomUUID);
    const p = paragraph(doc);
    const placement = passageOperationPlacement(doc, p.id, "after");
    const next = apply(doc, {
      id: randomUUID(),
      kind: "insert-break",
      placement,
    });
    expect(next.document.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
    expect(next.document.blocks[2]).toEqual(doc.blocks[1]);
    const table = apply(doc, {
      id: randomUUID(),
      kind: "insert-table",
      placement,
      widths: [80, 120],
      rows: 2,
    }).document.blocks[1];
    if (table.type !== "table") throw new Error("fixture");
    expect(table.rows).toHaveLength(2);
    expect(
      new Set(table.rows.flatMap((row) => row.cells.map((cell) => cell.id)))
        .size,
    ).toBe(4);
    expect(() =>
      apply(doc, {
        id: randomUUID(),
        kind: "insert-break",
        placement: { ...placement, neighborHash: "a".repeat(64) },
      }),
    ).toThrow("changed");
  });
  test("operation mappings qualify changed formatting descendants and clipped source fragments without guessing", () => {
    const doc = documentFromText("PREFIX-ABCD-SUFFIX", randomUUID);
    const p = paragraph(doc);
    const op: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "run-format",
      target: passageOperationRunSource(doc, p.id, p.runs[0].id, 8, 10),
      expectedText: "BC",
      patch: { set: { italic: true } },
    };
    const config = options(doc, true);
    config.window.runs[0].from = 7;
    config.window.runs[0].to = 11;
    const result = applyPassageOperations(doc, [op], config);
    expect(
      result.operationMappings.map((map) => [
        map.relation,
        map.source.from,
        map.source.to,
        map.target?.from,
        map.target?.to,
      ]),
    ).toEqual([
      ["unchanged", 7, 8, 7, 8],
      ["formatted", 8, 10, 0, 2],
      ["unchanged", 10, 11, 0, 1],
    ]);
    const selected = result.operationMappings.find(
      (map) => map.relation === "formatted",
    )!;
    expect(selected.target!.runId).not.toBe(p.runs[0].id);
    expect(selected.sourceTextHash).toBe(selected.targetTextHash);
    expect(selected.source.sourceHash).not.toBe(selected.target!.sourceHash);
    expect(
      refreshPassageOperationMappings(
        result.document,
        result.operationMappings,
      ),
    ).toEqual(result.operationMappings);
    const forged = structuredClone(result.document);
    paragraph(forged).runs[1].text = "ZZ";
    expect(() =>
      refreshPassageOperationMappings(forged, result.operationMappings),
    ).toThrow("exact operation span");
  });
  test("inserted/replacement/deleted output mappings retain distinct exact spans and deterministic IDs", () => {
    const doc = documentFromText("ABCD", randomUUID);
    const op = edit(doc, 1, 2, "XY");
    const result = apply(doc, op, true);
    expect(result.operationMappings.map((map) => map.relation)).toEqual([
      "unchanged",
      "deleted",
      "replacement",
      "unchanged",
    ]);
    const insertion = result.operationMappings.find(
      (map) => map.relation === "replacement",
    )!;
    const deletion = result.operationMappings.find(
      (map) => map.relation === "deleted",
    )!;
    expect(insertion.target!.runId).not.toBe(deletion.target!.runId);
    expect(insertion.targetTextHash).toBe(operationSourceHash("XY"));
    expect(deletion.targetTextHash).toBe(operationSourceHash("B"));
    expect(result.operationMappings[3]).toMatchObject({
      source: { from: 2, to: 4 },
      target: { from: 0, to: 2 },
    });
  });
  test("review decisions cannot duplicate a record or modify its target earlier in an atomic batch", () => {
    const doc = documentFromText("ABC", randomUUID);
    const p = paragraph(doc);
    p.runs[0].style = { bold: true };
    const change: DocumentChange = {
      id: randomUUID(),
      kind: "format",
      targetRunIds: [p.runs[0].id],
      authorId: 8,
      authorName: "Author",
      createdAt: "2026-10-06T00:00:00.000Z",
      origin: "manual",
      status: "pending",
      beforeStyle: {},
      afterStyle: { bold: true },
    };
    doc.changes = [change];
    const decision: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "resolve-change",
      changeId: change.id,
      changeHash: operationSourceHash(change),
      targetHash: passageReviewTargetHash(doc, change),
      decision: "accepted",
    };
    expect(() =>
      applyPassageOperations(
        doc,
        [decision, { ...decision, id: randomUUID() }],
        options(doc),
      ),
    ).toThrow("Overlapping");
    const format: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "paragraph-format",
      target: passageOperationParagraphSource(doc, p.id),
      patch: { set: { alignment: "right" } },
    };
    expect(() =>
      applyPassageOperations(doc, [format, decision], options(doc)),
    ).toThrow("pending");
  });
  test("exact in-flight span rebasing follows formatted output IDs and refuses ambiguous boundary carets", () => {
    const doc = documentFromText("ABCD", randomUUID),
      p = paragraph(doc);
    const op: DocumentPassageOperation = {
      id: randomUUID(),
      kind: "run-format",
      target: passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 3),
      expectedText: "BC",
      patch: { set: { italic: true } },
    };
    const result = apply(doc, op);
    const rebased = rebasePassageRunSource(
      passageOperationRunSource(doc, p.id, p.runs[0].id, 2, 3),
      result.operationMappings,
    );
    expect(rebased).toMatchObject({
      from: 1,
      to: 2,
      runId: paragraph(result.document).runs[1].id,
    });
    expect(() =>
      rebasePassageRunSource(
        passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 1),
        result.operationMappings,
      ),
    ).toThrow("unique");
    const replaced = apply(doc, edit(doc, 1, 3, "X"));
    expect(() =>
      rebasePassageRunSource(
        passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 3),
        replaced.operationMappings,
      ),
    ).toThrow("unique");
  });
  test("manual tracked split followed by separately saved typing preserves text provenance through boundary decisions", () => {
    const doc = documentFromText("AB", randomUUID),
      p = paragraph(doc);
    const split = apply(
      doc,
      {
        id: randomUUID(),
        kind: "paragraph-split",
        target: passageOperationRunSource(doc, p.id, p.runs[0].id, 1, 1),
        expectedText: "",
      },
      true,
    ).document;
    const right = paragraph(split, 1);
    const typing = apply(
      split,
      {
        id: randomUUID(),
        kind: "text",
        target: passageOperationRunSource(
          split,
          right.id,
          right.runs[0].id,
          0,
          0,
        ),
        expectedText: "",
        replacement: "X",
      },
      true,
    ).document;
    expect(projectDocument(typing).text).toBe("A\n\nXB");
    expect(projectDocument(typing, "original").text).toBe("AB");
    const boundary = typing.changes.find(
      (change) => change.kind === "paragraphSplit",
    )!;
    const insertion = typing.changes.find(
      (change) => change.kind === "insertion",
    )!;
    for (const decision of ["accepted", "rejected"] as const) {
      const resolved = apply(typing, {
        id: randomUUID(),
        kind: "resolve-change",
        changeId: boundary.id,
        changeHash: operationSourceHash(boundary),
        targetHash: passageReviewTargetHash(typing, boundary),
        decision,
      }).document;
      expect(
        resolved.changes.find((change) => change.id === insertion.id),
      ).toEqual(insertion);
      expect(projectDocument(resolved).text).toBe(
        decision === "accepted" ? "A\n\nXB" : "AXB",
      );
      expect(
        projectDocument(resolveChange(resolved, insertion.id, "rejected")).text,
      ).toBe(decision === "accepted" ? "A\n\nB" : "AB");
    }
  });
  test("resolution detail paging is bounded and pinned to the complete immutable review record", () => {
    const doc = documentFromText("ABC", randomUUID);
    const record: DocumentChange = {
      id: randomUUID(),
      kind: "format",
      targetRunIds: [paragraph(doc).runs[0].id],
      authorId: 8,
      authorName: "Author",
      createdAt: "2026-10-06T00:00:00.000Z",
      origin: "manual",
      status: "pending",
      beforeStyle: {},
      afterStyle: {},
    };
    doc.changes = [record];
    const request = {
      expectedSceneRevisionId: randomUUID(),
      changeId: record.id,
      recordHash: operationSourceHash(record),
    };
    expect(passageReviewHistoryPage(doc, request)).toMatchObject({
      total: 0,
      items: [],
    });
    expect(() =>
      passageReviewHistoryPage(doc, { ...request, limit: 33 }),
    ).toThrow("bounded");
    expect(() =>
      passageReviewHistoryPage(doc, { ...request, recordHash: "a".repeat(64) }),
    ).toThrow("changed");
  });
  test("generated fragment offset helper uses supplied canonical source offset and rejects grapheme splits without whole-run loading", () => {
    const doc = documentFromText("PREFIX-A👩🏽‍🚀B-SUFFIX", randomUUID);
    const p = paragraph(doc);
    const source = passageOperationRunSource(doc, p.id, p.runs[0].id, 7, 16);
    expect(passageRunSpan(source, "A👩🏽‍🚀B", 1, 8)).toMatchObject({
      from: 8,
      to: 15,
    });
    expect(() => passageRunSpan(source, "A👩🏽‍🚀B", 3, 3)).toThrow("grapheme");
  });
});
