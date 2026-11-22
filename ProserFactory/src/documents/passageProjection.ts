import { createHash, randomUUID } from "node:crypto";
import { DocumentError } from "./errors";
import { passageOperationParagraphSource, passageChangeSummary, passageParagraphLocation, passageBoundaryHash, emptyPassageBodyPlacement } from "./passageOperationSources";
import { passageLeaves, orderedPassageItems } from "./passageOrdering";
import {
  canonicalDocument,
  projectDocument,
  replaceDocumentText,
  visibleParagraph,
  visibleRun,
  paragraphStyle,
  runStyle,
  type ProserDocument,
  type DocumentParagraph,
  type DocumentChange,
  type DocumentView,
  MAX_DOCUMENT_BYTES,
} from "./model";
import type { DocumentStyleDefinitions } from "./style-model";
import type { PassageOwnedContext } from "./passageSource";
import { validateDocument } from "./validation";
import type {
  DocumentPassage,
  DocumentPassageRequest,
  DocumentPassageCommit,
  DocumentPassageParagraph,
  DocumentPassageRunSource,
} from "./passage-model";
export const passageHash = (value: unknown) =>
  createHash("sha256").update(canonicalDocument(value)).digest("hex");
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
function boundary(text: string, offset: number) {
  return (
    offset === 0 ||
    offset === text.length ||
    segmenter.segment(text).containing(offset)?.index === offset
  );
}
function boundedEnd(text: string, start: number, end: number) {
  if (end >= text.length) return text.length;
  if (end <= start) return start;
  const entry = segmenter.segment(text).containing(end);
  return entry?.index === end ? end : (entry?.index ?? start);
}
function entries(document: ProserDocument) {
  const result: Array<{
    paragraph: DocumentParagraph;
    container?: DocumentPassageParagraph["container"];
  }> = [];
  for (const block of document.blocks) {
    if (block.type === "paragraph") result.push({ paragraph: block });
    if (block.type === "table")
      for (const row of block.rows)
        for (const cell of row.cells)
          for (const paragraph of cell.paragraphs)
            result.push({
              paragraph,
              container: {
                tableId: block.id,
                rowId: row.id,
                cellId: cell.id,
                widths: block.widths,
              },
            });
  }
  return result;
}
export function committedPassageCursor(
  document: ProserDocument,
  cursor: import("./passage-model").DocumentPassageCursor,
  view: DocumentView = "final",
) {
  const paragraph = entries(document)[cursor.paragraph]?.paragraph;
  const text =
    (paragraph && (view === "final" || visibleParagraph(paragraph, document.changes, view))
      ? paragraph.runs
      : [])
      .filter((run) => visibleRun(run, document.changes, view))
      .map((run) => (run.inlineImage ? "\ufffc" : run.text))
      .join("");
  const offset = Math.min(cursor.offset, text.length);
  return {
    paragraph: cursor.paragraph,
    ...(cursor.item!==undefined?{item:Math.min(cursor.item,passageLeaves(document).length)}:{}),
    offset: boundary(text, offset)
      ? offset
      : (segmenter.segment(text).containing(offset)?.index ?? 0),
  };
}
function passageStyles(
  paragraphs: DocumentPassageParagraph[],
  changes: DocumentChange[],
  source: DocumentStyleDefinitions,
): DocumentStyleDefinitions {
  const result: DocumentStyleDefinitions = {
    text: Object.create(null) as DocumentStyleDefinitions["text"],
    paragraph: Object.create(null) as DocumentStyleDefinitions["paragraph"],
    labels: Object.create(null) as NonNullable<
      DocumentStyleDefinitions["labels"]
    >,
  };
  const ids = new Set<string>();
  for (const paragraph of paragraphs) {
    if (paragraph.paragraph.style.name) ids.add(paragraph.paragraph.style.name);
    for (const run of paragraph.paragraph.runs)
      if (run.style.characterStyleId) ids.add(run.style.characterStyleId);
  }
  for (const change of changes) {
    for (const style of [change.beforeStyle, change.afterStyle])
      if (style?.characterStyleId) ids.add(style.characterStyleId);
    for (const style of [
      change.beforeParagraphStyle,
      change.afterParagraphStyle,
    ])
      if (style?.name) ids.add(style.name);
  }
  const include = (id: string, seen = new Set<string>()) => {
    if (seen.has(id) || seen.size >= 32)
      throw new DocumentError(
        "DOCUMENT_STYLE_INVALID",
        "Passage style inheritance is cyclic or too deep.",
        409,
      );
    if (Object.hasOwn(source.paragraph, id))
      result.paragraph[id] = structuredClone(source.paragraph[id]!);
    if (source.labels && Object.hasOwn(source.labels, id))
      result.labels![id] = source.labels[id]!;
    const text = Object.hasOwn(source.text, id) ? source.text[id] : undefined;
    if (text) {
      result.text[id] = structuredClone(text);
      if (text.characterStyleId)
        include(text.characterStyleId, new Set([...seen, id]));
    }
  };
  for (const id of ids) include(id);
  return result;
}
/** No source paragraph, run or table graph is copied into a network passage. */
export function documentPassage(
  document: ProserDocument,
  source: {
    bookRevisionId: string;
    sceneId: number;
    sceneRevisionId: string;
    contentHash: string;
  },
  input: DocumentPassageRequest = {},
  owned?: PassageOwnedContext,
): DocumentPassage {
  const leaves = passageLeaves(document);
  const all = leaves.filter(entry=>entry.paragraph);
  let cursor = input.cursor ?? { paragraph: 0, offset: 0 };
  if(input.edge === "last") {
    if(input.anchorBlockId || input.anchorRunId || input.anchorOffset !== undefined || input.anchorSourceHash)
      throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Choose stable-anchor or last-edge navigation.",422);
    const view = input.projection ?? "final";
    let item = leaves.length - 1;
    while(item >= 0 && leaves[item]!.paragraph && !visibleParagraph(leaves[item]!.paragraph!, document.changes, view)) item--;
    if(item >= 0) {
      const entry = leaves[item]!, runs = entry.paragraph?.runs.filter(run => visibleRun(run,document.changes,view)) ?? [];
      const text = runs.map(run => run.inlineImage ? "\ufffc" : run.text).join("");
      const run = Math.max(0,runs.length - (input.maxRuns ?? 64));
      const prefix = runs.slice(0,run).reduce((sum,source) => sum + (source.inlineImage ? 1 : source.text.length),0);
      let offset = Math.max(prefix,text.length - (input.maxCharacters ?? 16000));
      if(!boundary(text,offset)) { const grapheme = segmenter.segment(text).containing(offset)!; offset = grapheme.index + grapheme.segment.length; }
      cursor = {item,paragraph:entry.ordinal,offset,...(entry.paragraph ? {run} : {})};
    } else cursor = {paragraph:0,offset:0,item:0};
  } else if(input.anchorBlockId){
    const item=leaves.findIndex(entry=>entry.paragraph?.id===input.anchorBlockId||entry.object?.id===input.anchorBlockId||entry.tableHead&&entry.table?.id===input.anchorBlockId);
    if(item<0)throw new DocumentError("DOCUMENT_TARGET_STALE","Stable navigation target is unavailable in this owned revision.",412);
    const entry=leaves[item]!,view=input.projection??"final";let offset=0;
    if(input.anchorRunId){
      const runs=entry.paragraph?.runs.filter(run=>visibleRun(run,document.changes,view))??[],index=runs.findIndex(run=>run.id===input.anchorRunId),run=runs[index];
      if(!run||input.anchorSourceHash&&passageHash(run)!==input.anchorSourceHash)throw new DocumentError("DOCUMENT_TARGET_STALE","Stable navigation run, formatting or projection changed.",412);
      const from=input.anchorOffset??0,text=run.inlineImage?"\ufffc":run.text;
      if(from>text.length||!boundary(text,from))throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Navigation offset splits or exceeds its canonical run.",422);
      offset=runs.slice(0,index).reduce((sum,run)=>sum+(run.inlineImage?1:run.text.length),0)+from;
    }else if(input.anchorOffset||input.anchorSourceHash)throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Run-qualified navigation offsets require a run identity.",422);
    cursor={item,paragraph:entry.ordinal,offset};
  }else if(input.anchorRunId||input.anchorOffset||input.anchorSourceHash)throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Stable navigation requires a block identity.",422);
  const maxCharacters = input.maxCharacters ?? 16000;
  const maxParagraphs = input.maxParagraphs ?? 24;
  if (
    !Number.isSafeInteger(cursor.paragraph) ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.paragraph < 0 ||
    cursor.offset < 0 ||
    cursor.paragraph > all.length ||
    !Number.isSafeInteger(maxCharacters) ||
    !Number.isSafeInteger(maxParagraphs) ||
    maxCharacters < 128 ||
    maxCharacters > 32768 ||
    maxParagraphs < 1 ||
    maxParagraphs > 64
  )
    throw new DocumentError(
      "DOCUMENT_PASSAGE_INVALID",
      "Passage cursor or bounds are invalid.",
      422,
    );
  const view=input.projection??"final";
  const maxRuns=input.maxRuns??64;
  const itemIndex=cursor.item??(cursor.paragraph===0&&cursor.offset===0?0:leaves.findIndex(entry=>entry.paragraph&&entry.ordinal===cursor.paragraph));
  if(itemIndex===leaves.length&&(cursor.offset||cursor.run))throw new DocumentError("DOCUMENT_PASSAGE_INVALID","End cursor has no text offsets.",422);
  if(!["final","original","markup"].includes(view)||!Number.isSafeInteger(itemIndex)||itemIndex<0||itemIndex>leaves.length||!Number.isSafeInteger(maxRuns)||maxRuns<1||maxRuns>256||!Number.isSafeInteger(cursor.run??0)||(cursor.run??0)<0)
    throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Passage cursor or bounds are invalid.",422);
  const projection=projectDocument(document,view);
  const spans=new Map(projection.spans.filter(span=>span.runId).map(span=>[span.runId!,span]));
  const paragraphs: DocumentPassageParagraph[] = [];
  const selected:number[]=[];
  let remaining=maxCharacters,remainingRuns=maxRuns,objectCount=0;
  let next:DocumentPassage["next"];
  for(let index=itemIndex;index<leaves.length;index++){
    const entry=leaves[index]!;const paragraph=entry.paragraph;
    if(!paragraph){
      if(index===itemIndex&&(cursor.offset||cursor.run))throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Objects have no text offsets.",422);
      selected.push(index);if(entry.object)objectCount++;
      if(objectCount>=maxParagraphs){if(index+1<leaves.length)next={item:index+1,paragraph:leaves[index+1]!.ordinal,offset:0};break;}continue;
    }
    if(!visibleParagraph(paragraph,document.changes,view)){
      if(index===itemIndex&&cursor.offset)throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Hidden paragraph has no projected offset.",422);continue;
    }
    const visible=paragraph.runs.filter(run=>visibleRun(run,document.changes,view));
    const text=visible.map(run=>run.inlineImage?"\ufffc":run.text).join("");
    const start=index===itemIndex?cursor.offset:0;
    if(start>text.length||!boundary(text,start))throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Passage offset splits a grapheme or exceeds its paragraph.",422);
    let end=boundedEnd(text,start,Math.min(text.length,start+remaining));
    if(end===start&&start<text.length)throw new DocumentError("DOCUMENT_PASSAGE_GRAPHEME_TOO_LARGE","A single grapheme exceeds the passage bound.",413);
    let offset=0,runNext:number|undefined;
    const runs:DocumentParagraph["runs"]=[],sources:DocumentPassageRunSource[]=[];
    const firstRun=index===itemIndex?cursor.run:undefined;
    if(firstRun!==undefined&&(firstRun>visible.length||visible.slice(0,firstRun).reduce((sum,run)=>sum+(run.inlineImage?1:run.text.length),0)>start))throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Run cursor exceeds its projected source.",422);
    for(let runIndex=0;runIndex<visible.length;runIndex++){
      const run=visible[runIndex]!,length=run.inlineImage?1:run.text.length;
      const from=Math.max(0,start-offset),to=Math.min(length,end-offset);
      if((firstRun===undefined||runIndex>=firstRun)&&(to>from||(length===0&&offset>=start&&offset<=end)||(start===end&&length>0&&runIndex===visible.length-1&&offset<=start&&start<=offset+length))){
        if(remainingRuns===0){end=offset;runNext=runIndex;break;}
        runs.push({...run,style:runStyle(run,document.changes,view),text:run.inlineImage?run.text:run.text.slice(from,to)});
        sources.push({runId:run.id,sourceHash:passageHash(run),from,to,sourceLength:length,projectionStart:spans.get(run.id)?.start});remainingRuns--;
      }
      offset+=length;
    }
    const location=passageParagraphLocation(document,paragraph.id),position=location.container.findIndex(block=>block.id===paragraph.id),adjacent=location.container[position+1];
    const adjacentEvidence=adjacent?.type==="paragraph"?{adjacentAfterId:adjacent.id,boundaryAfterHash:passageBoundaryHash(document,paragraph.id,adjacent.id)}:{};
    paragraphs.push({...passageOperationParagraphSource(document,paragraph.id),...adjacentEvidence,paragraph:{...paragraph,style:paragraphStyle(paragraph,document.changes,view),runs},ordinal:entry.ordinal,offset:start,length:text.length,continuedBefore:start>0||(firstRun??0)>0,continuedAfter:end<text.length||runNext!==undefined,runs:sources,...(entry.container?{container:structuredClone(entry.container)}:{})});
    selected.push(index);remaining-=end-start;
    if(end<text.length||runNext!==undefined){next={item:index,paragraph:entry.ordinal,offset:end,...(runNext!==undefined?{run:runNext}:{})};break;}
    if(paragraphs.length>=maxParagraphs||remaining<=0||remainingRuns===0){if(index+1<leaves.length)next={item:index+1,paragraph:leaves[index+1]!.ordinal,offset:0};break;}
  }
  const items=orderedPassageItems(document,leaves,selected,paragraphs);
  const runIds = new Set(
    paragraphs.flatMap((item) => item.paragraph.runs.map((run) => run.id)),
  );
  const blockIds = new Set(paragraphs.map((item) => item.paragraph.id));
  const changeIds = new Set(
    paragraphs.flatMap((item) =>
      [
        item.paragraph.changeId,
        item.paragraph.boundaryChangeId,
        ...item.paragraph.runs.map((run) => run.changeId),
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const related=document.changes.filter(change=>changeIds.has(change.id)||change.targetRunIds.some(id=>runIds.has(id))||change.targetBlockIds?.some(id=>blockIds.has(id)));
  const reviewOffset=input.reviewOffset??0;
  if(!Number.isSafeInteger(reviewOffset)||reviewOffset<0)throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Review offset is invalid.",422);
  const commentRecords=document.comments.filter(comment=>comment.anchors.some(anchor=>runIds.has(anchor.runId))||comment.anchorStates?.some(state=>runIds.has(state.sourceAnchor.runId))||itemIndex===0&&Boolean(comment.anchorStates?.length));
  const reviewTotal=related.length+commentRecords.length;
  if(reviewOffset>reviewTotal)throw new DocumentError("DOCUMENT_PASSAGE_INVALID","Review offset exceeds its immutable records.",422);
  const changeSummaries=related.slice(reviewOffset,reviewOffset+32).map(change=>passageChangeSummary(document,change.id,runIds,blockIds));
  const commentFrom=Math.max(0,reviewOffset-related.length),commentLimit=Math.max(0,32-changeSummaries.length);
  const commentSummaries=commentRecords.slice(commentFrom,commentFrom+commentLimit).map(comment=>({id:comment.id,authorId:comment.authorId,authorName:comment.authorName,createdAt:comment.createdAt,resolved:comment.resolved,recordHash:passageHash(comment),textPreview:comment.text.slice(0,256),anchorCount:comment.anchors.length,resolutionCount:comment.resolutionHistory?.length??0,visibleRunIds:[...new Set(comment.anchors.filter(anchor=>runIds.has(anchor.runId)).map(anchor=>anchor.runId))],staleAnchorCount:comment.anchorStates?.length??0}));
  const nextReviewOffset=reviewOffset+changeSummaries.length+commentSummaries.length;
  // Rendering records contain just the visible targets/properties. Durable full
  // history and proof remain server-owned and addressed by recordHash.
  const changes=related.filter(change=>changeIds.has(change.id)||change.status==="pending"&&["format","paragraphFormat"].includes(change.kind)).map(change=>{const{resolutionHistory:_history,historicalBoundarySource:_historical,...record}=change;return{...record,targetRunIds:record.targetRunIds.filter(id=>runIds.has(id)),...(record.targetBlockIds?{targetBlockIds:record.targetBlockIds.filter(id=>blockIds.has(id))}:{} )};});
  const {
    header: _header,
    footer: _footer,
    ...layout
  } = owned?.layout ?? document.layout;
  const result: Omit<DocumentPassage, "windowHash"> = {
    schemaVersion: 1,
    ...source,
    projection: view,
    ...(owned
      ? {
          sourceFrame: {...owned.sourceFrame,projection:view},
          styles: passageStyles(paragraphs, changes, owned.styles),
        }
      : {}),
    cursor,
    ...(next ? { next } : {}),
    paragraphs,
    images: items.flatMap(item=>item.type==="image"?[item.image]:[]),
    items, changeSummaries, commentSummaries,reviewOffset,
    ...(document.blocks.length === 0 ? {emptyPlacement:emptyPassageBodyPlacement()} : {}),
    ...(nextReviewOffset<reviewTotal?{nextReviewOffset}:{}),
    changes: structuredClone(changes),
    omitted: {
      paragraphs: all.length - paragraphs.length,
      comments: document.comments.length-commentSummaries.length,
      changes: document.changes.length - changeSummaries.length,
      objects: document.blocks.filter(
        (block) => block.type === "image" || block.type === "pageBreak",
      ).length-items.filter(item=>item.type==="image"||item.type==="pageBreak").length,
    },
    layout,
  };
  // Review records can themselves be large. Explicitly fail instead of violating
  // the response bound or silently truncating their authenticated metadata.
  if (Buffer.byteLength(canonicalDocument(result)) > 256 * 1024)
    throw new DocumentError(
      "DOCUMENT_PASSAGE_TOO_LARGE",
      "Passage review/object metadata exceeds 256 KiB; reduce the passage.",
      413,
    );
  return { ...result, windowHash: passageHash(result) };
}
export function applyPassageEdits(
  document: ProserDocument,
  window: DocumentPassage,
  input: DocumentPassageCommit,
  attribution?: Omit<DocumentChange, "id" | "kind" | "targetRunIds">,
): ProserDocument {
  if (window.windowHash !== input.windowHash)
    throw new DocumentError(
      "DOCUMENT_SOURCE_STALE",
      "Passage source changed.",
      412,
    );
  let result = document;
  const seen = new Set<string>();
  // Frozen original run coordinates; descending offsets preserve sequential
  // edits in one run. Multiple operations must not overlap or guess a new ID.
  const edits = [...input.edits].sort(
    (a, b) =>
      a.blockId.localeCompare(b.blockId) ||
      a.runId.localeCompare(b.runId) ||
      b.from - a.from,
  );
  for (const edit of edits) {
    if (
      /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        edit.replacement,
      )
    )
      throw new DocumentError(
        "DOCUMENT_PASSAGE_INVALID",
        "Replacement requires valid Unicode without NUL.",
        422,
      );
    const item = window.paragraphs.find(
      (item) => item.paragraph.id === edit.blockId,
    );
    const source = item?.runs.find((run) => run.runId === edit.runId);
    if (
      !source ||
      !Number.isSafeInteger(edit.from) ||
      !Number.isSafeInteger(edit.to) ||
      source.sourceHash !== edit.sourceHash ||
      edit.from < source.from ||
      edit.to > source.to ||
      edit.to < edit.from ||
      seen.has(edit.runId)
    )
      throw new DocumentError(
        "DOCUMENT_PASSAGE_TARGET_INVALID",
        "Each operation must target one exact visible source run in this passage.",
        409,
      );
    seen.add(edit.runId);
    const entry = entries(document).find(
      (entry) => entry.paragraph.id === edit.blockId,
    );
    const run = entry?.paragraph.runs.find((run) => run.id === edit.runId);
    if (
      !run ||
      run.inlineImage ||
      passageHash(run) !== edit.sourceHash ||
      run.text.slice(edit.from, edit.to) !== edit.expectedText ||
      !boundary(run.text, edit.from) ||
      !boundary(run.text, edit.to)
    )
      throw new DocumentError(
        "DOCUMENT_SOURCE_STALE",
        "Passage text, formatting, object or Unicode target changed.",
        412,
      );
    const projection = projectDocument(result);
    const span = projection.spans.find(
      (span) =>
        span.blockId === edit.blockId &&
        span.runId === edit.runId &&
        span.editable,
    );
    if (!span)
      throw new DocumentError(
        "DOCUMENT_PASSAGE_TARGET_INVALID",
        "Target is hidden or protected.",
        409,
      );
    try {
      result = replaceDocumentText(
        result,
        span.start + edit.from,
        span.start + edit.to,
        edit.expectedText,
        edit.replacement,
        randomUUID,
        attribution,
        { blockId: edit.blockId, runId: edit.runId },
      );
    } catch (error) {
      throw new DocumentError(
        "DOCUMENT_PASSAGE_TARGET_INVALID",
        error instanceof Error ? error.message : "Invalid passage edit",
        409,
      );
    }
  }
  if (Buffer.byteLength(canonicalDocument(result)) > MAX_DOCUMENT_BYTES)
    throw new DocumentError(
      "DOCUMENT_COMMIT_TOO_LARGE",
      "Scene document exceeds 2 MiB.",
      413,
    );
  return validateDocument(result);
}
