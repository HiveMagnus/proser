import { randomUUID } from "node:crypto";
import request from "supertest";
import app from "@/index";
import { databaseService } from "@/lib/database";
import { documentService } from "@/documents/service";
import {
  readDocumentPassage,
  commitDocumentPassage,
  restoreDocumentPassage,
} from "@/documents/passage";
import { commitPassageOperations, readPassageReviewHistory } from "@/documents/passageOperationCommits";
import { commitPassageComment, readPassageComment } from "@/documents/passageComments";
import { passageHash } from "@/documents/passageProjection";
import { documentFromText, projectDocument, replaceDocumentText } from "@/documents/model";
import type { DocumentPassageOperationCommit } from "@/documents/passage-operations-model";
import type { DocumentPassageCommit } from "@/documents/passage-model";
// Marked real-PG cases repeatedly project/hash/write a 1.5 MiB scene.
// A 20s cold-CI harness deadline leaves their bounded transport/restore assertions intact.
describe("owned sparse passage save and recovery", () => {
  const db = () => databaseService.client;
  let userId: number;
  let githubId: string;
  let bookId: number;
  let sceneId: number;
  beforeAll(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = "true";
    githubId = `passage-fixture-${randomUUID()}`;
    userId = (
      await db().user.create({ data: { githubId, username: "Passage owner" } })
    ).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({
      data: {
        userId,
        title: "Disposable giant scene",
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: {
                chapterNumber: 1,
                scenes: {
                  create: { sceneNumber: 1, prose: "word ".repeat(300000) },
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
    sceneId = book.acts[0]!.chapters[0]!.scenes[0]!.id;
    await documentService.initialize(userId, bookId);
  });
  test("typed formatting commits sparse post-stamp mappings and recovers one exact receipt",async()=>{
    const window=await readDocumentPassage(userId,bookId,sceneId,{maxCharacters:128});
    const paragraph=window.paragraphs[0]!,run=paragraph.runs[0]!;
    const input:DocumentPassageOperationCommit={schemaVersion:1,operationId:randomUUID(),expectedRevisionId:window.bookRevisionId,expectedSceneRevisionId:window.sceneRevisionId,sourceFrame:window.sourceFrame!,windowHash:window.windowHash,cursor:window.cursor,maxCharacters:128,tracking:true,operations:[{id:randomUUID(),kind:"run-format",target:{blockId:paragraph.paragraph.id,paragraphHash:paragraph.paragraphHash!,containerHash:paragraph.containerHash!,runId:run.runId,sourceHash:run.sourceHash,from:0,to:4},expectedText:"word",patch:{set:{bold:true}}}]};
    const saved=await commitPassageOperations(userId,bookId,sceneId,input);
    expect(Object.hasOwn(saved,"scenes")).toBe(false);
    expect(Object.hasOwn(saved.result,"document")).toBe(false);
    expect(saved.result.passage.paragraphs[0]!.paragraph.runs[0]!.style.bold).toBe(true);
    expect(saved.result.operationMappings.some(map=>map.relation==="formatted")).toBe(true);
    const current=await documentService.read(userId,bookId,sceneId);
    for(const map of saved.result.operationMappings.filter(map=>map.target)){
      const source=saved.result.passage.paragraphs.flatMap(p=>p.runs).find(run=>run.runId===map.target!.runId);
      if(source)expect(map.target!.sourceHash).toBe(source.sourceHash);
    }
    expect(projectDocument(current.document,"original").text).toBe("word ".repeat(300000));
    expect(await commitPassageOperations(userId,bookId,sceneId,input)).toEqual(saved);
    await expect(commitPassageOperations(userId,bookId,sceneId,{...input,operationId:randomUUID()})).rejects.toMatchObject({status:412});
    const change=saved.result.passage.changeSummaries![0]!;
    expect((await readPassageReviewHistory(userId,bookId,sceneId,{bookRevisionId:saved.revisionId,expectedSceneRevisionId:current.revisionId,changeId:change.id,recordHash:change.recordHash})).items).toEqual([]);
  });
  test("Markup resolves pending deletions with exact bounded receipts", async () => {
    const before = await documentService.read(userId, bookId, sceneId);
    const attribution = {
      authorId: userId,
      authorName: "Passage owner",
      origin: "manual",
      createdAt: new Date().toISOString(),
      status: "pending",
    } as const;
    let document = documentFromText("Drop alpha. Keep beta.", randomUUID);
    document = replaceDocumentText(document, 0, 12, "Drop alpha. ", "", randomUUID, attribution);
    document = replaceDocumentText(document, 0, 10, "Keep beta.", "", randomUUID, attribution);
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: before.bookRevisionId,
      scenes: [{ sceneId, expectedRevisionId: before.revisionId, document }],
    });

    const final = await readDocumentPassage(userId, bookId, sceneId, { projection: "final" });
    expect(final.changeSummaries?.filter((change) => change.status === "pending")).toEqual([]);

    for (const [index, decision] of (["accepted", "rejected"] as const).entries()) {
      const markup = await readDocumentPassage(userId, bookId, sceneId, { projection: "markup" });
      const summary = markup.changeSummaries!.find((change) => change.id === document.changes[index].id)!;
      expect(summary).toMatchObject({ kind: "deletion", status: "pending" });
      const input: DocumentPassageOperationCommit = {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevisionId: markup.bookRevisionId,
        expectedSceneRevisionId: markup.sceneRevisionId,
        sourceFrame: markup.sourceFrame!,
        windowHash: markup.windowHash,
        cursor: markup.cursor,
        operations: [{
          id: randomUUID(), kind: "resolve-change", changeId: summary.id,
          changeHash: summary.recordHash, targetHash: summary.targetHash, decision,
        }],
      };
      if (index === 0) {
        await expect(commitPassageOperations(userId, bookId, sceneId, {
          ...input,
          windowHash: final.windowHash,
        })).rejects.toMatchObject({ status: 412 });
        await expect(commitPassageOperations(userId, bookId, sceneId, {
          ...input,
          operations: [{
            id: randomUUID(), kind: "insert-break", placement: markup.items![0].placement.after,
          }],
        })).rejects.toMatchObject({ status: 422 });
      }
      const receipt = await commitPassageOperations(userId, bookId, sceneId, input);
      expect(receipt.result.passage.projection).toBe("markup");
      expect(receipt.result.touched.changeIds).toEqual([summary.id]);
      expect(await documentService.operation(userId, bookId, input.operationId)).toEqual(receipt);
      expect(await commitPassageOperations(userId, bookId, sceneId, input)).toEqual(receipt);
    }
    const saved = await documentService.read(userId, bookId, sceneId);
    expect(saved.document.changes.map((change) => change.status)).toEqual(["accepted", "rejected"]);
    expect(projectDocument(saved.document).text).toBe("Keep beta.");
  });

  test("typed source frames and off-window objects cannot bypass owned revision checks",async()=>{
    const head=await documentService.manifest(userId,bookId),scene=await documentService.read(userId,bookId,sceneId);
    const document=documentFromText("Before\n\nAfter",randomUUID);
    document.blocks.splice(1,0,{type:"pageBreak",id:randomUUID()});
    await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:head.revisionId,scenes:[{sceneId,expectedRevisionId:scene.revisionId,document}]});
    const window=await readDocumentPassage(userId,bookId,sceneId,{maxParagraphs:1});
    const item=window.items![0]!;
    const input:DocumentPassageOperationCommit={schemaVersion:1,operationId:randomUUID(),expectedRevisionId:window.bookRevisionId,expectedSceneRevisionId:window.sceneRevisionId,sourceFrame:{...window.sourceFrame!,effectiveStyleLayoutHash:"f".repeat(64)},windowHash:window.windowHash,cursor:window.cursor,maxParagraphs:1,operations:[{id:randomUUID(),kind:"insert-break",placement:item.placement.after}]};
    await expect(commitPassageOperations(userId,bookId,sceneId,input)).rejects.toMatchObject({status:412});
    input.sourceFrame=window.sourceFrame!;
    const committed=await commitPassageOperations(userId,bookId,sceneId,input);
    expect(committed.result.introducedIds.some(id=>id.role.includes("break"))).toBe(true);
    expect(committed.sceneReferences).toHaveLength(1);
    expect((await documentService.read(userId,bookId,sceneId)).document.blocks.filter(block=>block.type==="pageBreak")).toHaveLength(2);
  });

  test("bounded comments preserve authenticated evidence, replay, lineage and resolution history",async()=>{
    const window=await readDocumentPassage(userId,bookId,sceneId,{maxCharacters:128});
    const paragraph=window.paragraphs[0]!,run=paragraph.runs[0]!;
    const input={schemaVersion:1 as const,operationId:randomUUID(),expectedRevisionId:window.bookRevisionId,expectedSceneRevisionId:window.sceneRevisionId,windowHash:window.windowHash,cursor:window.cursor,maxCharacters:128,action:"create" as const,text:"Preserve this exact source.",anchors:[{blockId:paragraph.paragraph.id,runId:run.runId,start:0,end:4,sourceText:"word"}]};
    const created=await commitPassageComment(userId,bookId,sceneId,input);
    expect(created.result.passage.commentSummaries?.[0]?.authorId).toBe(userId);
    expect(await commitPassageComment(userId,bookId,sceneId,input)).toEqual(created);
    expect(JSON.stringify(created).length).toBeLessThan(12000);
    const summary=created.result.passage.commentSummaries![0]!;
    const detail=await readPassageComment(userId,bookId,sceneId,summary.id,{bookRevisionId:created.revisionId,expectedSceneRevisionId:created.result.passage.sceneRevisionId,recordHash:summary.recordHash});
    expect(detail.anchors).toEqual(input.anchors);
    const current=created.result.passage,p=current.paragraphs[0]!,r=p.runs[0]!;
    const formatted=await commitPassageOperations(userId,bookId,sceneId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:current.bookRevisionId,expectedSceneRevisionId:current.sceneRevisionId,windowHash:current.windowHash,sourceFrame:current.sourceFrame!,cursor:current.cursor,maxCharacters:128,operations:[{id:randomUUID(),kind:"run-format",target:{blockId:p.paragraph.id,paragraphHash:p.paragraphHash!,containerHash:p.containerHash!,runId:r.runId,sourceHash:r.sourceHash,from:0,to:4},expectedText:"word",patch:{set:{bold:true}}}]});
    const next=formatted.result.passage,record=next.commentSummaries![0]!;
    const remapped=await readPassageComment(userId,bookId,sceneId,record.id,{bookRevisionId:next.bookRevisionId,expectedSceneRevisionId:next.sceneRevisionId,recordHash:record.recordHash});
    expect(remapped.anchors[0]!.sourceText).toBe("word");
    expect(remapped.anchorStates).toEqual([]);
    expect(next.paragraphs[0]!.paragraph.runs.find(run=>run.id===remapped.anchors[0]!.runId)?.style.bold).toBe(true);
    const resolved=await commitPassageComment(userId,bookId,sceneId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:next.bookRevisionId,expectedSceneRevisionId:next.sceneRevisionId,windowHash:next.windowHash,cursor:next.cursor,maxCharacters:128,action:"resolved",commentId:record.id,recordHash:record.recordHash});
    expect(resolved.result.passage.commentSummaries![0]!.resolved).toBe(true);
    const stored=(await documentService.read(userId,bookId,sceneId)).document.comments[0]!;
    expect(stored.resolutionHistory).toHaveLength(1);
    expect(stored.resolutionHistory![0]!.actorId).toBe(userId);
    expect(passageHash(stored)).toBe(resolved.result.passage.commentSummaries![0]!.recordHash);
    await expect(commitPassageComment(userId,bookId,sceneId,{...input,operationId:randomUUID()})).rejects.toMatchObject({status:412});
    await expect(readPassageComment(userId+999999,bookId,sceneId,record.id,{bookRevisionId:resolved.revisionId,expectedSceneRevisionId:resolved.result.passage.sceneRevisionId,recordHash:passageHash(stored)})).rejects.toThrow("Book not found");
    expect((await auth(request(app).post(`/api/books/${bookId}/scenes/${sceneId}/document-passages/comments`)).send({})).status).toBe(428);
  }, 20_000);
  test("empty-body insertion uses exact qualified placement and rejects forged sources",async()=>{
    const head=await documentService.manifest(userId,bookId),old=await documentService.read(userId,bookId,sceneId),document=documentFromText("",randomUUID);document.blocks=[];
    await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:head.revisionId,scenes:[{sceneId,expectedRevisionId:old.revisionId,document}]});
    const window=await readDocumentPassage(userId,bookId,sceneId,{});
    const input:DocumentPassageOperationCommit={schemaVersion:1,operationId:randomUUID(),expectedRevisionId:window.bookRevisionId,expectedSceneRevisionId:window.sceneRevisionId,windowHash:window.windowHash,sourceFrame:window.sourceFrame!,cursor:window.cursor,operations:[{id:randomUUID(),kind:"insert-paragraph",placement:window.emptyPlacement!}]};
    const saved=await commitPassageOperations(userId,bookId,sceneId,input);
    expect(saved.result.passage.paragraphs).toHaveLength(1);
    expect(saved.result.passage.paragraphs[0]!.runs).toHaveLength(1);
    expect(saved.result.passage.emptyPlacement).toBeUndefined();
    expect(await commitPassageOperations(userId,bookId,sceneId,input)).toEqual(saved);
  });
  afterEach(async () => {
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    await db().user.delete({ where: { id: userId } });
  });
  const auth = (call: request.Test) =>
    call.set("x-user-id", String(userId)).set("x-github-id", githubId);
  test("lost acknowledgement returns identical bounded receipt; stale reuse and cross-owner reads reject", async () => {
    const window = await readDocumentPassage(userId, bookId, sceneId, {
      cursor: { paragraph: 0, offset: 750000 },
      maxCharacters: 512,
    });
    expect(JSON.stringify(window).length).toBeLessThan(4096);
    const paragraph = window.paragraphs[0]!;
    const run = paragraph.runs[0]!;
    const input: DocumentPassageCommit = {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: window.bookRevisionId,
      expectedSceneRevisionId: window.sceneRevisionId,
      windowHash: window.windowHash,
      cursor: window.cursor,
      maxCharacters: 512,
      edits: [
        {
          blockId: paragraph.paragraph.id,
          runId: run.runId,
          sourceHash: run.sourceHash,
          from: run.from,
          to: run.from + 4,
          expectedText: "word",
          replacement: "exact",
        },
      ],
    };
    const first = await commitDocumentPassage(userId, bookId, sceneId, input);
    expect(Object.hasOwn(first, "scenes")).toBe(false);
    expect(first.sceneReferences).toHaveLength(1);
    expect(JSON.stringify(first).length).toBeLessThan(8192);
    expect(first.result.sceneRevisionId).toBe(
      first.sceneReferences![0]!.revisionId,
    );
    expect(
      first.result.paragraphs[0]!.paragraph.runs.map((run) => run.text).join(
        "",
      ),
    ).toContain("exact");
    expect(await commitDocumentPassage(userId, bookId, sceneId, input)).toEqual(
      first,
    );
    expect(
      await documentService.operation(userId, bookId, input.operationId),
    ).toEqual(first);
    expect(await db().sceneDocumentRevision.count({ where: { bookId } })).toBe(
      2,
    );
    const saved = await documentService.read(userId, bookId, sceneId);
    expect(saved.projection.text).toBe(
      "word ".repeat(150000) + "exact " + "word ".repeat(149999),
    );
    await expect(
      commitDocumentPassage(userId, bookId, sceneId, {
        ...input,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      commitDocumentPassage(userId, bookId, sceneId, {
        ...input,
        edits: [{ ...input.edits[0]!, replacement: "different" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      readDocumentPassage(userId + 100000, bookId, sceneId, {}),
    ).rejects.toThrow("Book not found");
    const historical = await readDocumentPassage(userId, bookId, sceneId, {
      bookRevisionId: window.bookRevisionId,
      cursor: window.cursor,
      maxCharacters: 512,
    });
    expect(historical).toEqual(window);
    const current = await readDocumentPassage(userId, bookId, sceneId, {
      cursor: window.cursor,
      maxCharacters: 512,
    });
    const restoration = {
      schemaVersion: 1 as const,
      operationId: randomUUID(),
      expectedRevisionId: current.bookRevisionId,
      expectedSceneRevisionId: current.sceneRevisionId,
      windowHash: current.windowHash,
      cursor: current.cursor,
      maxCharacters: 512,
      restoreFromRevisionId: window.sceneRevisionId,
      restoreCursor: window.cursor,
    };
    const restored = await restoreDocumentPassage(
      userId,
      bookId,
      sceneId,
      restoration,
    );
    expect(Object.hasOwn(restored, "scenes")).toBe(false);
    expect(JSON.stringify(restored).length).toBeLessThan(8192);
    expect(restored.result.restoredFromRevisionId).toBe(window.sceneRevisionId);
    expect(restored.result.passage.contentHash).toBe(window.contentHash);
    expect(restored.result.passage.sceneRevisionId).not.toBe(
      window.sceneRevisionId,
    );
    expect(
      await restoreDocumentPassage(userId, bookId, sceneId, restoration),
    ).toEqual(restored);
    expect(
      (await documentService.read(userId, bookId, sceneId)).projection.text,
    ).toBe("word ".repeat(300000));
    expect(await db().sceneDocumentRevision.count({ where: { bookId } })).toBe(
      3,
    );
    await expect(
      restoreDocumentPassage(userId, bookId, sceneId, {
        ...restoration,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 412 });
  }, 20_000);
  test("HTTP preconditions, bounds and foreign scene ownership are explicit", async () => {
    const prefix = `/api/books/${bookId}/scenes/${sceneId}/document-passages`;
    expect(
      (await auth(request(app).post(prefix).send({ schemaVersion: 1 }))).status,
    ).toBe(428);
    expect(
      (await auth(request(app).get(prefix + "?maxCharacters=100000"))).status,
    ).toBe(422);
    const read = await auth(request(app).get(prefix + "?maxCharacters=128"));
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe(`"${read.body.data.windowHash}"`);
    const passage = read.body.data;
    const paragraph = passage.paragraphs[0];
    const run = paragraph.runs[0];
    const invalid = await auth(request(app).post(prefix)).send({
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: passage.bookRevisionId,
      expectedSceneRevisionId: passage.sceneRevisionId,
      windowHash: passage.windowHash,
      cursor: passage.cursor,
      maxCharacters: 128,
      edits: [
        {
          blockId: paragraph.paragraph.id,
          runId: run.runId,
          sourceHash: run.sourceHash,
          from: 0,
          to: 0,
          expectedText: "",
          replacement: "\u0000",
        },
      ],
    });
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(read.body).length).toBeLessThan(4096);
    expect(
      (
        await auth(
          request(app).get(
            `/api/books/${bookId}/scenes/${sceneId + 100000}/document-passages`,
          ),
        )
      ).status,
    ).toBe(404);
  });
  test("passages derive chapter typography and used style ancestry from exact owned scopes instead of Scene.layout", async () => {
    const source = await documentService.read(userId, bookId, sceneId);
    const owned = await documentService.scope(userId, bookId, "layout");
    const layout = structuredClone(owned.content);
    layout.chapters[String(source.chapterId)] = {
      ...layout.book,
      font: "DejaVu Sans Mono",
      fontSize: 23,
    };
    layout.styles.text = {
      parent: { font: "Liberation Serif", bold: true },
      child: { characterStyleId: "parent", italic: true },
      unused: { font: "Arial" },
    };
    layout.styles.labels = { child: "Nested é style" };
    await documentService.mutateCatalog(
      userId,
      bookId,
      {
        operationId: randomUUID(),
        expectedRevisionId: source.bookRevisionId,
        expectedScopes: { layout: owned.revisionId },
        payload: { command: "owned-passage-layout-test" },
      },
      async () => ({ result: null, layout }),
    );
    const current = await documentService.read(userId, bookId, sceneId);
    const paragraph = current.document.blocks[0];
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.runs[0].style.characterStyleId = "child";
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: current.bookRevisionId,
      scenes: [
        {
          sceneId,
          expectedRevisionId: current.revisionId,
          document: current.document,
        },
      ],
    });
    const window = await readDocumentPassage(userId, bookId, sceneId, {
      maxCharacters: 128,
    });
    const manifest = await documentService.manifest(userId, bookId);
    expect(window.layout.font).toBe("DejaVu Sans Mono");
    expect(window.layout.fontSize).toBe(23);
    expect(window.styles?.text).toEqual({
      parent: { font: "Liberation Serif", bold: true },
      child: { characterStyleId: "parent", italic: true },
    });
    expect(window.styles?.labels?.child).toBe("Nested é style");
    expect(window.sourceFrame).toMatchObject({
      bookId,
      chapterId: source.chapterId,
      sceneId,
      bookRevisionId: manifest.revisionId,
      bookContentHash: manifest.contentHash,
      sceneContentHash: window.contentHash,
      layoutScope: manifest.scopes!.layout,
    });
    expect(
      (await documentService.read(userId, bookId, sceneId)).document.layout
        .font,
    ).toBe(source.document.layout.font);
  });
});
