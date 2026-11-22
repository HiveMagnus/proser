import { createHash, randomUUID } from "node:crypto";
import {
  canonicalDocument,
  documentFromText,
  projectDocument,
  resolveChange,
  type ProserDocument,
} from "@/documents/model";
import { stampDocumentReview } from "@/documents/reviewAttribution";
import { validateDocument } from "@/documents/validation";
import { assertOwnedBoundaryEvidence } from "@/documents/boundaryHistory";
import { databaseService } from "@/lib/database";
import { documentService } from "@/documents/service";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
function fixture(): ProserDocument {
  const document = documentFromText("A\n\nB", randomUUID),
    [left, right] = document.blocks;
  if (left.type !== "paragraph" || right.type !== "paragraph")
    throw new Error("fixture");
  const id = randomUUID();
  left.boundaryChangeId = id;
  document.changes.push({
    id,
    kind: "paragraphSplit",
    status: "accepted",
    origin: "import",
    authorId: 4,
    authorName: "Imported editor",
    importedAuthor: "Original reviewer",
    createdAt: "2020-01-01T00:00:00.000Z",
    targetBlockIds: [left.id, right.id],
    targetRunIds: [],
  });
  return document;
}
function repeated(document: ProserDocument): ProserDocument {
  const next = structuredClone(document),
    left = next.blocks[0],
    right = next.blocks[1];
  if (left.type !== "paragraph" || right.type !== "paragraph")
    throw new Error("fixture");
  const id = randomUUID();
  left.boundaryChangeId = id;
  next.changes.push({
    id,
    kind: "paragraphJoin",
    status: "pending",
    origin: "manual",
    authorId: 8,
    authorName: "Local",
    createdAt: new Date().toISOString(),
    targetBlockIds: [left.id, right.id],
    targetRunIds: [],
  });
  return next;
}
const context = () => ({
  operationId: randomUUID(),
  sourceBookRevisionId: randomUUID(),
  sourceContentHash: "a".repeat(64),
  sourceKind: "scene" as const,
  sourceSceneId: 1,
  sourceSceneRevisionId: randomUUID(),
});
describe("historical resolved paragraph boundary source attestation", () => {
  test("repeat join retains imported old attribution/status and adds source evidence without a resolution event", () => {
    const before = fixture(),
      next = repeated(before),
      source = context();
    expect(() => validateDocument(next)).toThrow("linked adjacent");
    const events = stampDocumentReview(
      next,
      before,
      { id: 8, name: "Local" },
      "manual",
      false,
      source,
    );
    expect(events).toEqual([]);
    expect(next.changes[0]).toEqual({
      ...before.changes[0],
      historicalBoundarySource: {
        sourceKind: "scene",
        sourceSceneId: 1,
        sourceSceneRevisionId: source.sourceSceneRevisionId,
        sourceBookRevisionId: source.sourceBookRevisionId,
        sourceBookContentHash: source.sourceContentHash,
        sourceDocumentHash: hash(before),
        changeHash: hash(before.changes[0]),
        targetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(validateDocument(next)).toEqual(next);
    expect(projectDocument(next).text).toBe("AB");
    expect(projectDocument(next, "original").text).toBe("A\n\nB");
    expect(next.changes[0].resolutionHistory).toBeUndefined();
  });
  test("missing immutable context, fabricated/dropped proof or removed historical record cannot pass", () => {
    const before = fixture();
    expect(() =>
      stampDocumentReview(repeated(before), before, { id: 8, name: "Local" }),
    ).toThrow("immutable source");
    const next = repeated(before);
    stampDocumentReview(
      next,
      before,
      { id: 8, name: "Local" },
      "manual",
      false,
      context(),
    );
    const forged = structuredClone(next);
    forged.changes[0].historicalBoundarySource!.targetHash = "b".repeat(64);
    expect(() =>
      stampDocumentReview(forged, next, { id: 8, name: "Local" }),
    ).toThrow();
    const dropped = structuredClone(next);
    delete dropped.changes[0].historicalBoundarySource;
    expect(() =>
      stampDocumentReview(dropped, next, { id: 8, name: "Local" }),
    ).toThrow();
    const removed = structuredClone(next);
    removed.changes.shift();
    expect(() =>
      stampDocumentReview(removed, next, { id: 8, name: "Local" }),
    ).toThrow("history must be retained");
    expect(() =>
      stampDocumentReview(
        structuredClone(next),
        undefined,
        { id: 8, name: "Local" },
        "import",
        true,
        context(),
      ),
    ).toThrow();
  });
  test("pending marks cannot detach and history cannot invent deleted target proof", () => {
    const before = fixture();
    before.changes[0].status = "pending";
    const next = repeated(before);
    expect(() =>
      stampDocumentReview(
        next,
        before,
        { id: 8, name: "Local" },
        "manual",
        false,
        context(),
      ),
    ).toThrow("cannot be replaced");
    const invalid = fixture();
    const left = invalid.blocks[0];
    if (left.type !== "paragraph") throw new Error("fixture");
    delete left.boundaryChangeId;
    expect(() =>
      stampDocumentReview(
        repeated(invalid),
        invalid,
        { id: 8, name: "Local" },
        "manual",
        false,
        context(),
      ),
    ).toThrow("immutable source");
  });
});
describe("owned durable historical boundary revisions", () => {
  const db = () => databaseService.client;
  let userId: number;
  let bookId: number;
  let sceneId: number;
  beforeAll(async () => {
    userId = (
      await db().user.create({
        data: {
          githubId: `boundary-history-${randomUUID()}`,
          username: "Historical boundary owner",
        },
      })
    ).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({
      data: {
        userId,
        title: "Disposable historical boundary",
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: {
                chapterNumber: 1,
                scenes: { create: { sceneNumber: 1, prose: "AB" } },
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
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().manuscriptRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentSearchIndex.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    await db().user.delete({ where: { id: userId } });
  });
  async function save(document: ProserDocument) {
    const source = await documentService.read(userId, bookId, sceneId);
    return documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: source.bookRevisionId,
      scenes: [{ sceneId, expectedRevisionId: source.revisionId, document }],
    });
  }
  test.each(["accepted", "rejected"] as const)(
    "split resolved %s → join → split keeps two exact old histories",
    async (decision) => {
      const initial = await documentService.read(userId, bookId, sceneId),
        split = fixture();
      split.layout = initial.document.layout;
      split.changes[0].origin = "manual";
      split.changes[0].status = "pending";
      delete split.changes[0].importedAuthor;
      await save(split);
      const pending = await documentService.read(userId, bookId, sceneId);
      await save(
        resolveChange(
          pending.document,
          pending.document.changes[0].id,
          decision,
        ),
      );
      const resolved = await documentService.read(userId, bookId, sceneId),
        old = structuredClone(resolved.document.changes[0]);
      await save(repeated(resolved.document));
      const joined = await documentService.read(userId, bookId, sceneId);
      expect(joined.document.changes[0]).toMatchObject({
        ...old,
        historicalBoundarySource: {
          sourceSceneRevisionId: resolved.revisionId,
        },
      });
      expect(joined.document.changes[0].resolutionHistory).toEqual(
        old.resolutionHistory,
      );
      await assertOwnedBoundaryEvidence(db(), userId, bookId, joined.document);
      await expect(
        assertOwnedBoundaryEvidence(
          db(),
          userId + 100000,
          bookId,
          joined.document,
        ),
      ).rejects.toMatchObject({ code: "DOCUMENT_SCOPE_NOT_FOUND" });
      const forged = structuredClone(joined.document);
      forged.changes[0].historicalBoundarySource!.sourceDocumentHash =
        "b".repeat(64);
      await expect(
        assertOwnedBoundaryEvidence(db(), userId, bookId, forged),
      ).rejects.toMatchObject({ code: "DOCUMENT_BOUNDARY_HISTORY_INVALID" });
      await save(
        resolveChange(
          joined.document,
          joined.document.changes[1].id,
          "accepted",
        ),
      );
      const accepted = await documentService.read(userId, bookId, sceneId),
        again = repeated(accepted.document);
      again.changes[again.changes.length - 1].kind = "paragraphSplit";
      await save(again);
      const final = await documentService.read(userId, bookId, sceneId);
      expect(final.document.changes[0]).toEqual(joined.document.changes[0]);
      expect(final.document.changes[1].historicalBoundarySource).toMatchObject({
        sourceKind: "scene",
        sourceSceneRevisionId: accepted.revisionId,
      });
      expect(final.document.changes[1].resolutionHistory).toEqual(
        accepted.document.changes[1].resolutionHistory,
      );
      expect(final.document.changes[2].status).toBe("pending");
      await assertOwnedBoundaryEvidence(db(), userId, bookId, final.document);
    },
  );
  test('front matter and header table-cell boundary histories bind owned layout scopes; complete restore retains selected proofs', async () => {
    const scope=await documentService.scope(userId,bookId,'layout'), layout=structuredClone(scope.content), storyId=randomUUID(), headerId=randomUUID();
    const document=fixture();document.changes[0].status='pending';document.changes[0].origin='manual';delete document.changes[0].importedAuthor;
    const header=structuredClone(document);for(const block of header.blocks){if(block.type!=='paragraph')throw new Error('fixture');block.id=randomUUID();for(const run of block.runs)run.id=randomUUID();}
    const [a,b]=header.blocks;if(a.type!=='paragraph'||b.type!=='paragraph')throw new Error('fixture');header.changes[0].id=randomUUID();header.changes[0].targetBlockIds=[a.id,b.id];a.boundaryChangeId=header.changes[0].id;header.blocks=[{type:'table',id:randomUUID(),widths:[300],rows:[{id:randomUUID(),cells:[{id:randomUUID(),paragraphs:[a,b]}]}]}];
    layout.frontMatter=[{id:storyId,name:'Boundary preface',document}];layout.headerFooterStories=[{id:headerId,owner:'book',kind:'header',document:header}];
    const changeLayout=async(content:typeof layout)=>{const current=await documentService.scope(userId,bookId,'layout');return documentService.mutateCatalog(userId,bookId,{operationId:randomUUID(),expectedRevisionId:current.bookRevisionId,expectedScopes:{layout:current.revisionId},payload:{command:'historical-boundary-layout-fixture',content}},async()=>({result:{},layout:content}));};
    await changeLayout(layout);const pending=await documentService.scope(userId,bookId,'layout'), accepted=structuredClone(pending.content);
    accepted.frontMatter[0].document=resolveChange(accepted.frontMatter[0].document,accepted.frontMatter[0].document.changes[0].id,'accepted');accepted.headerFooterStories![0].document=resolveChange(accepted.headerFooterStories![0].document,accepted.headerFooterStories![0].document.changes[0].id,'rejected');await changeLayout(accepted);
    const source=await documentService.scope(userId,bookId,'layout'), next=structuredClone(source.content);next.frontMatter[0].document=repeated(next.frontMatter[0].document);
    const headerDoc=next.headerFooterStories![0].document, table=headerDoc.blocks[0];if(table.type!=='table')throw new Error('fixture');const left=table.rows[0].cells[0].paragraphs[0],right=table.rows[0].cells[0].paragraphs[1],id=randomUUID();left.boundaryChangeId=id;headerDoc.changes.push({id,kind:'paragraphJoin',status:'pending',origin:'manual',authorId:userId,authorName:'Historical boundary owner',createdAt:new Date().toISOString(),targetRunIds:[],targetBlockIds:[left.id,right.id]});
    await changeLayout(next);const current=await documentService.scope(userId,bookId,'layout');for(const [story,expectedId]of [[current.content.frontMatter[0],storyId],[current.content.headerFooterStories![0],headerId]] as const){expect(story.document.changes[0].historicalBoundarySource).toMatchObject({sourceKind:'layout-story',sourceStoryId:expectedId,sourceLayoutRevisionId:source.revisionId});await assertOwnedBoundaryEvidence(db(),userId,bookId,story.document);}
    const forged=structuredClone(current.content.frontMatter[0].document),proof=forged.changes[0].historicalBoundarySource!;if(proof.sourceKind!=='layout-story')throw new Error('fixture');proof.sourceStoryId=headerId;await expect(assertOwnedBoundaryEvidence(db(),userId,bookId,forged)).rejects.toMatchObject({code:'DOCUMENT_BOUNDARY_HISTORY_INVALID'});
    await documentService.restore(userId,bookId,source.bookRevisionId,current.bookRevisionId,randomUUID());const restored=await documentService.scope(userId,bookId,'layout');expect(restored.content).toEqual(source.content);
    await documentService.restore(userId,bookId,current.bookRevisionId,restored.bookRevisionId,randomUUID());const withProof=await documentService.scope(userId,bookId,'layout');expect(withProof.content).toEqual(current.content);await assertOwnedBoundaryEvidence(db(),userId,bookId,withProof.content.frontMatter[0].document);
  });

});
