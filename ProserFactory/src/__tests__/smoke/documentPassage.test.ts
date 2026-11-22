import type { DocumentPassageSourceFrame } from "@/documents/passage-model";
import { randomUUID } from "node:crypto";
import {
  documentFromText,
  projectDocument,
  canonicalDocument,
} from "@/documents/model";
import {
  documentPassage,
  applyPassageEdits,
  passageHash,
} from "@/documents/passageProjection";
import type { DocumentPassageCommit } from "@/documents/passage-model";
const source = {
  bookRevisionId: randomUUID(),
  sceneId: 1,
  sceneRevisionId: randomUUID(),
  contentHash: "a".repeat(64),
};
describe("bounded immutable giant-scene passages", () => {
  test("last-edge and stable anchors return qualified Unicode-safe tail carets", () => {
    const document = documentFromText("word ".repeat(300000) + "👩🏽‍🚀e\u0301", randomUUID);
    const last = documentPassage(document, source, {edge:"last",maxCharacters:128});
    expect(last.paragraphs[0]!.paragraph.runs[0]!.text.endsWith("👩🏽‍🚀e\u0301")).toBe(true);
    expect(last.paragraphs[0]!.paragraph.runs[0]!.text.length).toBeLessThanOrEqual(128);
    expect(last.next).toBeUndefined();
    expect(documentPassage(document,source,{cursor:last.cursor,maxCharacters:128})).toEqual(last);
    const paragraph=last.paragraphs[0]!,run=paragraph.runs[0]!;
    const caret=documentPassage(document,source,{anchorBlockId:paragraph.paragraph.id,anchorRunId:run.runId,anchorSourceHash:run.sourceHash,anchorOffset:run.sourceLength,maxCharacters:128});
    expect(caret.paragraphs[0]!.runs[0]!.from).toBe(run.sourceLength);
    expect(caret.paragraphs[0]!.runs[0]!.to).toBe(run.sourceLength);
    expect(caret.paragraphs[0]!.paragraph.runs[0]!.text).toBe("");
    expect(()=>documentPassage(document,source,{anchorBlockId:paragraph.paragraph.id,anchorRunId:run.runId,anchorSourceHash:"f".repeat(64)})).toThrow("changed");
  });
  test("orphan comments remain discoverable in the first bounded review page",()=>{
    const document=documentFromText("New stable paragraph",randomUUID),anchor={blockId:randomUUID(),runId:randomUUID(),start:0,end:3,sourceText:"Old"};
    document.comments.push({id:randomUUID(),authorId:1,authorName:"Owner",createdAt:new Date().toISOString(),text:"Orphaned finding",resolved:false,anchors:[anchor],anchorStates:[{anchorIndex:0,status:"orphaned",reason:"target-removed",sourceSceneId:1,sourceSceneRevisionId:randomUUID(),sourceContentHash:"a".repeat(64),sourceAnchor:anchor}]});
    const window=documentPassage(document,source);
    expect(window.commentSummaries).toHaveLength(1);
    expect(window.commentSummaries![0]!.staleAnchorCount).toBe(1);
    expect(window.commentSummaries![0]!.visibleRunIds).toEqual([]);
  });
  test("only empty canonical bodies advertise an exact insertion placement",()=>{
    const document=documentFromText("",randomUUID); document.blocks=[];
    const empty=documentPassage(document,source);
    expect(empty.emptyPlacement?.neighborId).toBe("empty-body");
    document.blocks.push({id:randomUUID(),type:"pageBreak"});
    expect(documentPassage(document,source).emptyPlacement).toBeUndefined();
  });
  test("style identifiers never read or overwrite prototype members while projecting owned ancestors", () => {
    const document = documentFromText("Safe named style.", randomUUID);
    const paragraph = document.blocks[0];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.runs[0].style.characterStyleId = "constructor";
    const frame: DocumentPassageSourceFrame = {
      bookId: 1,
      actId: 2,
      chapterId: 3,
      sceneId: 1,
      bookRevisionId: source.bookRevisionId,
      bookContentHash: "a".repeat(64),
      sceneRevisionId: source.sceneRevisionId,
      sceneContentHash: source.contentHash,
      qualifiedMembershipHash: "a".repeat(64),
      structureScope: { revisionId: randomUUID(), contentHash: "b".repeat(64) },
      layoutScope: { revisionId: randomUUID(), contentHash: "c".repeat(64) },
      effectiveStyleLayoutHash: "d".repeat(64),
      projection: "final",
    };
    const definitions = JSON.parse(
      '{"text":{"constructor":{"font":"Liberation Serif"},"__proto__":{"font":"DejaVu Sans Mono"}},"paragraph":{},"labels":{"constructor":"Constructor","__proto__":"Prototype"}}',
    );
    const first = documentPassage(
      document,
      source,
      {},
      { layout: document.layout, styles: definitions, sourceFrame: frame },
    );
    expect(first.styles?.text.constructor).toEqual({
      font: "Liberation Serif",
    });
    expect(Object.hasOwn(first.styles!.paragraph, "constructor")).toBe(false);
    paragraph.runs[0].style.characterStyleId = "__proto__";
    const second = documentPassage(
      document,
      source,
      {},
      { layout: document.layout, styles: definitions, sourceFrame: frame },
    );
    expect(Object.hasOwn(second.styles!.text, "__proto__")).toBe(true);
    expect(second.styles!.text["__proto__"]).toEqual({
      font: "DejaVu Sans Mono",
    });
    expect(Object.getPrototypeOf(second.styles!.text)).toBeNull();
  });
  test("unrepresentable graphemes and invalid numeric bounds fail explicitly", () => {
    const document = documentFromText("a" + "\u0301".repeat(1000), randomUUID);
    expect(() =>
      documentPassage(document, source, { maxCharacters: 128 }),
    ).toThrow("single grapheme");
    expect(() =>
      documentPassage(document, source, { maxCharacters: Number.NaN }),
    ).toThrow("bounds are invalid");
    expect(() =>
      documentPassage(document, source, { maxParagraphs: 1.5 }),
    ).toThrow("bounds are invalid");
  });
  test("300k words never appear in a response; stable offsets page without losing whitespace or Unicode", () => {
    const text = "word  ".repeat(299998) + "👩🏽‍🚀 e\u0301  ";
    const document = documentFromText(text, randomUUID);
    let cursor = { paragraph: 0, offset: 0 };
    let actual = "";
    let pages = 0;
    do {
      const window = documentPassage(document, source, {
        cursor,
        maxCharacters: 32768,
      });
      expect(Buffer.byteLength(canonicalDocument(window))).toBeLessThan(
        256 * 1024,
      );
      expect(
        window.paragraphs[0]!.paragraph.runs[0]!.text.length,
      ).toBeLessThanOrEqual(32768);
      actual += window.paragraphs
        .map((item) => item.paragraph.runs.map((run) => run.text).join(""))
        .join("");
      pages++;
      if (!window.next) break;
      cursor = window.next;
    } while (pages < 500);
    expect(actual).toBe(text);
    expect(pages).toBeGreaterThan(50);
  });
  test("qualified boundary edits retain the exact adjacent run and styling, with clipped source run preconditions", () => {
    const document = documentFromText("A".repeat(1000), randomUUID);
    const paragraph = document.blocks[0]!;
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.runs[0]!.style = { bold: true };
    paragraph.runs.push({
      id: randomUUID(),
      text: "right",
      style: { italic: true },
    });
    const cursor = { paragraph: 0, offset: 1000 };
    const window = documentPassage(document, source, { cursor });
    const run = window.paragraphs[0]!.runs.find(
      (run) => run.runId === paragraph.runs[1]!.id,
    )!;
    const input: DocumentPassageCommit = {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      expectedSceneRevisionId: source.sceneRevisionId,
      windowHash: window.windowHash,
      cursor,
      edits: [
        {
          blockId: paragraph.id,
          runId: run.runId,
          sourceHash: run.sourceHash,
          from: 0,
          to: 0,
          expectedText: "",
          replacement: "NEW",
        },
      ],
    };
    const changed = applyPassageEdits(document, window, input);
    expect(projectDocument(changed).text).toBe("A".repeat(1000) + "NEWright");
    const block = changed.blocks[0]!;
    if (block.type !== "paragraph") throw new Error("fixture");
    expect(block.runs.find((run) => run.text === "NEW")!.style).toEqual({
      italic: true,
    });
    expect(canonicalDocument(document)).toContain("right");
    expect(() =>
      applyPassageEdits(document, window, {
        ...input,
        windowHash: "b".repeat(64),
      }),
    ).toThrow("Passage source changed");
    expect(() =>
      applyPassageEdits(document, window, {
        ...input,
        edits: [{ ...input.edits[0]!, sourceHash: "b".repeat(64) }],
      }),
    ).toThrow("exact visible source run");
  });
  test("table passages retain only selected cell identity, and partial graphemes/protected images fail", () => {
    const document = documentFromText("safe 👩🏽‍🚀 tail", randomUUID);
    const paragraph = document.blocks[0]!;
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    document.blocks = [
      {
        type: "table",
        id: "table",
        widths: [100, 100],
        rows: [
          {
            id: "row",
            cells: [
              { id: "left", paragraphs: [paragraph] },
              {
                id: "right",
                paragraphs: [
                  {
                    ...paragraph,
                    id: "other",
                    runs: [{ id: "other-run", text: "untouched", style: {} }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const window = documentPassage(document, source, { maxParagraphs: 1 });
    expect(window.paragraphs[0]!.container).toEqual({
      tableId: "table",
      rowId: "row",
      cellId: "left",
      widths: [100, 100],
      rowOrdinal: 0, columnIndex: 0, cellParagraphOrdinal: 0,
    });
    expect(JSON.stringify(window)).not.toContain("untouched");
    expect(window.next).toEqual({ item:2, paragraph: 1, offset: 0 });
    expect(() =>
      documentPassage(document, source, {
        cursor: { paragraph: 0, offset: 6 },
      }),
    ).toThrow("grapheme");
    const run = paragraph.runs[0]!;
    const input: DocumentPassageCommit = {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      expectedSceneRevisionId: source.sceneRevisionId,
      windowHash: window.windowHash,
      cursor: { paragraph: 0, offset: 0 },
      maxParagraphs: 1,
      edits: [
        {
          blockId: paragraph.id,
          runId: run.id,
          sourceHash: passageHash(run),
          from: 6,
          to: 7,
          expectedText: run.text.slice(6, 7),
          replacement: "x",
        },
      ],
    };
    expect(() => applyPassageEdits(document, window, input)).toThrow(
      "Unicode target changed",
    );
  });
  test("ordered object-only and mixed table windows preserve identities and never return neighbours' text",()=>{
    const document=documentFromText("left\n\nright",randomUUID);
    const left=document.blocks[0],right=document.blocks[1];if(left.type!=="paragraph"||right.type!=="paragraph")throw new Error("fixture");
    document.blocks=[{type:"image",id:"image",assetId:1,sha256:"a".repeat(64),alt:"Owned",width:20,height:30},{type:"pageBreak",id:"break"},{type:"table",id:"table",widths:[80,120],rows:[{id:"row",cells:[{id:"a",paragraphs:[left]},{id:"b",paragraphs:[right]}]}]}];
    const first=documentPassage(document,source,{maxParagraphs:1});expect(first.items!.map(item=>item.type)).toEqual(["image"]);expect(first.next).toEqual({item:1,paragraph:0,offset:0});
    const second=documentPassage(document,source,{cursor:first.next,maxParagraphs:1});expect(second.items![0]!.type).toBe("pageBreak");
    const third=documentPassage(document,source,{cursor:second.next,maxParagraphs:1});const item=third.items![0]!;if(item.type!=="tableSlice")throw new Error("fixture");expect(item.rows[0]!.cells[0]!.columnIndex).toBe(0);expect(item.rows[0]!.cells[0]!.paragraphIndexes).toEqual([0]);expect(JSON.stringify(third)).not.toContain('"text":"right"');
    const fourth=documentPassage(document,source,{cursor:third.next,maxParagraphs:1});const last=fourth.items![0]!;if(last.type!=="tableSlice")throw new Error("fixture");expect(last.rows[0]!.cells[0]!.columnIndex).toBe(1);expect(last.continuedBefore).toBe(true);
    document.blocks=document.blocks.slice(0,2);expect(documentPassage(document,source).items!.map(item=>item.type)).toEqual(["image","pageBreak"]);
  });
  test("metadata-heavy empty runs progress with an exact run cursor; review histories remain bounded summaries",()=>{
    const document=documentFromText("",randomUUID);const p=document.blocks[0];if(p.type!=="paragraph")throw new Error("fixture");p.runs=Array.from({length:300},()=>({id:randomUUID(),text:"",style:{}}));let cursor:import("@/documents/passage-model").DocumentPassageCursor={paragraph:0,offset:0};const ids:string[]=[];
    do{const page=documentPassage(document,source,{cursor,maxRuns:7});ids.push(...page.paragraphs.flatMap(p=>p.runs.map(run=>run.runId)));if(!page.next)break;cursor=page.next;}while(ids.length<400);
    expect(ids).toEqual(p.runs.map(run=>run.id));expect(new Set(ids).size).toBe(300);
  });
  test("tracked edits are server attributed while untouched source remains identical", () => {
    const document = documentFromText("original", randomUUID);
    const window = documentPassage(document, source);
    const block = window.paragraphs[0]!;
    const run = block.runs[0]!;
    const changed = applyPassageEdits(
      document,
      window,
      {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: source.bookRevisionId,
        expectedSceneRevisionId: source.sceneRevisionId,
        windowHash: window.windowHash,
        cursor: { paragraph: 0, offset: 0 },
        edits: [
          {
            blockId: block.paragraph.id,
            runId: run.runId,
            sourceHash: run.sourceHash,
            from: 0,
            to: 8,
            expectedText: "original",
            replacement: "new",
          },
        ],
      },
      {
        authorId: 1,
        authorName: "Owner",
        createdAt: new Date().toISOString(),
        status: "pending",
        origin: "manual",
      },
    );
    expect(projectDocument(changed).text).toBe("new");
    expect(projectDocument(changed, "original").text).toBe("original");
    expect(
      changed.changes.every((change) => change.authorName === "Owner"),
    ).toBe(true);
  });
});
