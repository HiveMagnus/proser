import { randomUUID } from 'node:crypto';
import { defaultLayout, paragraphsOf, type ProserDocument, type DocumentParagraph } from './model';
import type { BookLayoutSnapshot, HeaderFooterStory } from './scope-model';
import { DocumentError } from './errors';
/** Owned graph lookup never searches text or infers another owner's identity. */
export function layoutStory(layout: BookLayoutSnapshot, kind: 'header'|'footer', chapterId?: number): HeaderFooterStory | undefined {
  return (chapterId === undefined ? undefined : layout.headerFooterStories?.find((story)=>story.owner==='chapter'&&story.chapterId===chapterId&&story.kind===kind)) ?? layout.headerFooterStories?.find((story)=>story.owner==='book'&&story.kind===kind);
}
/** Explicit caller commit creates a new layout revision; historical fragments stay byte-exact. */
export function upgradeLegacyLayoutStories(source: BookLayoutSnapshot, idFactory:()=>string=randomUUID): BookLayoutSnapshot {
  const layout=structuredClone(source);layout.headerFooterStories ??=[];
  for(const [chapter,settings] of [['book',layout.book],...Object.entries(layout.chapters)] as const) for(const kind of ['header','footer'] as const) {
    if(!settings[kind].length)continue;
    const document:ProserDocument={schemaVersion:1,blocks:structuredClone(settings[kind]),changes:[],comments:[],layout:defaultLayout()};
    document.layout.header=[];document.layout.footer=[];
    layout.headerFooterStories.push({id:idFactory(),owner:chapter==='book'?'book':'chapter',...(chapter==='book'?{}:{chapterId:Number(chapter)}),kind,document});settings[kind]=[];
  }
  return layout;
}
/** Extract exact converted story graph. Body and layout story keep disjoint authoritative review records. */
export function extractDocumentLayoutStories(source:ProserDocument, chapterId:number, idFactory:()=>string=randomUUID): {document:ProserDocument;stories:HeaderFooterStory[]} {
  const document=structuredClone(source);const stories:HeaderFooterStory[]=[];const detachedRuns=new Set<string>();const detachedBlocks=new Set<string>();
  for(const kind of ['header','footer'] as const) {
    const paragraphs=document.layout[kind];if(!paragraphs.length)continue;
    const blocks=new Set(paragraphs.map((paragraph)=>paragraph.id));const runs=new Set(paragraphs.flatMap((paragraph)=>paragraph.runs.map((run)=>run.id)));
    const changes=document.changes.filter((change)=>change.targetRunIds.every((id)=>runs.has(id))&&(change.targetBlockIds??[]).every((id)=>blocks.has(id))&&(change.targetRunIds.length||change.targetBlockIds?.length));
    const comments=document.comments.filter((comment)=>comment.anchors.every((anchor)=>runs.has(anchor.runId)));
    const storyDocument:ProserDocument={schemaVersion:1,blocks:structuredClone(paragraphs),changes:structuredClone(changes),comments:structuredClone(comments),layout:defaultLayout()};storyDocument.layout.header=[];storyDocument.layout.footer=[];
    stories.push({id:idFactory(),owner:'chapter',chapterId,kind,document:storyDocument});for(const id of runs)detachedRuns.add(id);for(const id of blocks)detachedBlocks.add(id);document.layout[kind]=[];
  }
  for(const change of document.changes) if(change.targetRunIds.some((id)=>detachedRuns.has(id))&&!change.targetRunIds.every((id)=>detachedRuns.has(id)))throw new DocumentError('DOCUMENT_STORY_REVIEW_CROSS_SCOPE','Review operation spans body and layout story; preserve and reconcile explicitly.',422);
  for(const comment of document.comments) if(comment.anchors.some((anchor)=>detachedRuns.has(anchor.runId))&&!comment.anchors.every((anchor)=>detachedRuns.has(anchor.runId)))throw new DocumentError('DOCUMENT_STORY_COMMENT_CROSS_SCOPE','Comment spans body and layout story; preserve and reconcile explicitly.',422);
  document.changes=document.changes.filter((change)=>!change.targetRunIds.some((id)=>detachedRuns.has(id))&&!(change.targetBlockIds??[]).some((id)=>detachedBlocks.has(id)));document.comments=document.comments.filter((comment)=>!comment.anchors.some((anchor)=>detachedRuns.has(anchor.runId)));
  return {document,stories};
}
/** Temporary paragraph rendering bridge; full table/image stories render from their owned document. */
export function layoutStoryParagraphs(story:HeaderFooterStory):DocumentParagraph[]{return paragraphsOf(story.document,false);}
