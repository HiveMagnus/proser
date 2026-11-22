/** Proser-owned canonical document contract. Generated into Author; never import Factory runtime there. */
import type { DocumentScopeReferences } from './scope-model';
export interface SceneDocumentReference {
  sceneId: number; chapterId: number; sceneNumber: number; revisionId: string;
  contentHash: string; wordCount: number; deletedAt?: string | null;
}
export interface DocumentManifest {
  schemaVersion: 1; scenes: SceneDocumentReference[];
  retiredScenes?: SceneDocumentReference[]; scopes?: DocumentScopeReferences;
}
export interface DocumentManifestResponse extends DocumentManifest {
  revisionId: string; contentHash: string;
  totals: { projection: 'final'; wordCount: number; sceneCount: number };
}
export const DOCUMENT_SCHEMA_VERSION = 1 as const;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export interface DocumentLineagePoint {
  sceneId: number; blockId: string; runId: string; from: number; to: number;
}
export interface DocumentAnchorLineage {
  kind: 'split' | 'join' | 'move' | 'restore' | 'format'; source: DocumentLineagePoint; target: DocumentLineagePoint;
}
export interface VerifiedDocumentAnchorLineage extends DocumentAnchorLineage {
  sourceTextSha256: string; styleSha256: string;
  sourceSceneRevisionId: string; targetSceneRevisionId: string;
}
export type DocumentView = 'final' | 'original' | 'markup';
export interface TextStyle {
  characterStyleId?: string;
  font?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  color?: string;
  highlight?: string;
  hyperlink?: string;
}
export interface ParagraphStyle {
  name?: string;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  lineSpacing?: number;
  before?: number;
  after?: number;
  indent?: number;
  firstLineIndent?: number;
  keepWithNext?: boolean;
  pageBreakBefore?: boolean;
  heading?: 1 | 2 | 3 | 4 | 5 | 6;
  list?: 'bullet' | 'number';
}
export interface DocumentRun {
  id: string;
  text: string;
  style: TextStyle;
  changeId?: string;
  /** An immutable inline image occupies one protected projected character. */
  inlineImage?: Omit<DocumentImage, 'type' | 'id'>;
}
export interface DocumentParagraph {
  type: 'paragraph';
  id: string;
  style: ParagraphStyle;
  runs: DocumentRun[];
  changeId?: string;
  /** Review of the paragraph mark following this physical paragraph. */
  boundaryChangeId?: string;
}
export interface DocumentImage {
  type: 'image';
  id: string;
  assetId: number;
  sha256: string;
  alt: string;
  width: number;
  height: number;
}
export interface DocumentTable {
  type: 'table';
  id: string;
  widths: number[];
  rows: Array<{ id: string; cells: Array<{ id: string; paragraphs: DocumentParagraph[] }> }>;
}
export interface DocumentBreak { type: 'pageBreak'; id: string }
export type DocumentBlock = DocumentParagraph | DocumentImage | DocumentTable | DocumentBreak;
export interface DocumentAnchor {
  blockId: string;
  runId: string;
  start: number;
  end: number;
  sourceText: string;
}
export type DocumentChangeResolutionSource =
  | { sourceKind: 'scene'; sourceSceneId: number; sourceSceneRevisionId: string }
  | { sourceKind: 'layout-story'; sourceStoryId: string; sourceLayoutRevisionId: string }
  | { sourceKind: 'scene-creation'; sourceSceneId: number };
export type DocumentChangeResolution = DocumentChangeResolutionSource & {
  operationId: string; actorId: number; actorName: string; createdAt: string;
  decision: 'accepted' | 'rejected'; origin: 'manual' | 'workflow';
  phase: 'resolved' | 'created-and-resolved';
  sourceBookRevisionId: string; sourceContentHash: string; workflowRunId?: string;
};
/** A detached resolved paragraph mark retains an owned immutable target proof.
 * Only the document service may attach this evidence; it never resolves a change. */
export type DocumentHistoricalBoundarySource = Exclude<DocumentChangeResolutionSource, { sourceKind: 'scene-creation' }> & {
  sourceBookRevisionId: string; sourceBookContentHash: string;
  sourceDocumentHash: string; changeHash: string; targetHash: string;
};
export interface DocumentChange {
  id: string;
  kind: 'insertion' | 'deletion' | 'format' | 'paragraphInsertion' | 'paragraphDeletion' | 'paragraphFormat' | 'paragraphSplit' | 'paragraphJoin';
  authorId: number;
  authorName: string;
  createdAt: string;
  status: 'pending' | 'accepted' | 'rejected';
  origin: 'manual' | 'ai' | 'workflow' | 'import';
  importedAuthor?: string;
  targetRunIds: string[];
  targetBlockIds?: string[];
  beforeStyle?: TextStyle;
  afterStyle?: TextStyle;
  beforeParagraphStyle?: ParagraphStyle;
  afterParagraphStyle?: ParagraphStyle;
  /** Authenticated decisions; original change/import attribution is retained. */
  resolutionHistory?: DocumentChangeResolution[];
  historicalBoundarySource?: DocumentHistoricalBoundarySource;
}
export interface DocumentComment {
  id: string;
  authorId: number;
  authorName: string;
  createdAt: string;
  text: string;
  anchors: DocumentAnchor[];
  resolved: boolean;
  importedAuthor?: string;
  /** Detached ranges retain their exact immutable source evidence. */
  anchorStates?: Array<{
    anchorIndex: number; status: 'stale' | 'orphaned';
    reason: 'target-removed' | 'target-text-changed' | 'target-hidden' | 'target-container-changed' | 'target-image-changed';
    sourceContentHash: string; sourceAnchor: DocumentAnchor;
  } & (
    { sourceKind?: 'scene'; sourceSceneId: number; sourceSceneRevisionId: string }
    | { sourceKind: 'layout-story'; sourceStoryId: string; sourceLayoutRevisionId: string }
  )>;
  resolutionHistory?: Array<{
    operationId: string; action: 'resolved' | 'reopened' | 'reanchored';
    actorId: number; actorName: string; createdAt: string;
    previousAnchors: DocumentAnchor[];
    previousAnchorStates?: DocumentComment['anchorStates'];
  } & (
    { sourceKind?: 'scene'; sourceSceneRevisionId: string }
    | { sourceKind: 'layout-story'; sourceStoryId: string; sourceLayoutRevisionId: string }
  )>;
}
export interface DocumentLayout {
  preset: 'manuscript' | 'book';
  width: number;
  height: number;
  margins: [number, number, number, number];
  font: string;
  fontSize: number;
  pageNumbers: boolean;
  header: DocumentParagraph[];
  footer: DocumentParagraph[];
}
export interface ProserDocument {
  schemaVersion: 1;
  blocks: DocumentBlock[];
  changes: DocumentChange[];
  comments: DocumentComment[];
  layout: DocumentLayout;
}
export interface DocumentSpan {
  start: number;
  end: number;
  blockId: string;
  runId?: string;
  cellId?: string;
  editable: boolean;
}
export const defaultLayout = (): DocumentLayout => ({
  preset: 'manuscript', width: 794, height: 1123, margins: [76, 76, 76, 76],
  font: 'Georgia', fontSize: 16, pageNumbers: true, header: [], footer: [],
});
export function documentFromText(text: string, id: () => string): ProserDocument {
  return {
    schemaVersion: 1,
    blocks: text.split('\n\n').map((value) => ({ type: 'paragraph', id: id(), style: {}, runs: [{ id: id(), text: value, style: {} }] })),
    changes: [], comments: [], layout: defaultLayout(),
  };
}
export function paragraphsOf(document: ProserDocument, includeStories = false): DocumentParagraph[] {
  const body = document.blocks.flatMap((block) => block.type === 'paragraph' ? [block]
    : block.type === 'table' ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs)) : []);
  return includeStories ? [...document.layout.header, ...body, ...document.layout.footer] : body;
}
export function imagesOf(document: ProserDocument): DocumentImage[] {
  return [...document.blocks.filter((block): block is DocumentImage => block.type === 'image'), ...paragraphsOf(document, true).flatMap((paragraph) => paragraph.runs.flatMap((run) => run.inlineImage ? [{ type: 'image' as const, id: run.id, ...run.inlineImage }] : []))];
}
export function visibleParagraph(block: DocumentParagraph, changes: DocumentChange[], view: DocumentView): boolean {
  const change = changes.find((item) => item.id === block.changeId);
  if (!change || !['paragraphInsertion', 'paragraphDeletion'].includes(change.kind)) return true;
  const insertion = change.kind === 'paragraphInsertion';
  if (change.status === 'accepted') return insertion;
  if (change.status === 'rejected') return !insertion;
  return view === 'markup' || (view === 'original' ? !insertion : insertion);
}
export function paragraphStyle(block: DocumentParagraph, changes: DocumentChange[], view: DocumentView): ParagraphStyle {
  const change = changes.find((item) => item.kind === 'paragraphFormat' && item.targetBlockIds?.includes(block.id) && item.status === 'pending');
  return change && view === 'original' ? change.beforeParagraphStyle ?? block.style : block.style;
}
/** Physical identities remain stable even when a projected paragraph mark is absent. */
export function paragraphBoundaryVisible(left: DocumentParagraph, right: DocumentParagraph, changes: DocumentChange[], view: DocumentView): boolean {
  const change = changes.find((item) => item.id === left.boundaryChangeId && (item.kind === 'paragraphSplit' || item.kind === 'paragraphJoin') && item.targetBlockIds?.[0] === left.id && item.targetBlockIds?.[1] === right.id);
  if (!change) return true;
  const split = change.kind === 'paragraphSplit';
  if (change.status === 'accepted') return split;
  if (change.status === 'rejected') return !split;
  return view === 'markup' || (view === 'original' ? !split : split);
}
export function paragraphGroups(paragraphs: DocumentParagraph[], changes: DocumentChange[], view: DocumentView): DocumentParagraph[][] {
  const result: DocumentParagraph[][] = [];
  for (const block of paragraphs.filter((item) => visibleParagraph(item, changes, view))) {
    const previous = result.at(-1)?.at(-1);
    if (previous && !paragraphBoundaryVisible(previous, block, changes, view)) result[result.length - 1]!.push(block);
    else result.push([block]);
  }
  return result;
}
export function visibleRun(run: DocumentRun, changes: DocumentChange[], view: DocumentView): boolean {
  const change = changes.find((item) => item.id === run.changeId);
  if (!change || change.kind === 'format') return true;
  if (change.status === 'accepted') return change.kind === 'insertion';
  if (change.status === 'rejected') return change.kind === 'deletion';
  return view === 'markup' || (view === 'original' ? change.kind === 'deletion' : change.kind === 'insertion');
}
export function runStyle(run: DocumentRun, changes: DocumentChange[], view: DocumentView): TextStyle {
  const change = changes.find((item) => item.kind === 'format' && item.targetRunIds.includes(run.id) && item.status === 'pending');
  return change && view === 'original' ? change.beforeStyle ?? run.style : run.style;
}
/** Offsets are UTF-16; separators and protected objects explicitly occupy noneditable spans. */
export function projectDocument(document: ProserDocument, view: DocumentView = 'final'): { text: string; spans: DocumentSpan[]; wordCount: number } {
  let text = '';
  const spans: DocumentSpan[] = [];
  const append = (value: string, info: Omit<DocumentSpan, 'start' | 'end'>) => {
    const start = text.length; text += value; spans.push({ ...info, start, end: text.length });
  };
  const paragraph = (block: DocumentParagraph, cellId?: string) => {
    for (const run of block.runs) if (visibleRun(run, document.changes, view)) append(run.inlineImage ? '\uFFFC' : run.text, { blockId: block.id, runId: run.id, cellId, editable: !run.inlineImage });
  };
  const visibleBlocks = document.blocks.filter((block) => block.type !== 'paragraph' || visibleParagraph(block, document.changes, view));
  visibleBlocks.forEach((block, index) => {
    const previous = visibleBlocks[index - 1];
    if (index && !(block.type === 'paragraph' && previous?.type === 'paragraph' && !paragraphBoundaryVisible(previous, block, document.changes, view))) append('\n\n', { blockId: block.id, editable: false });
    if (block.type === 'paragraph') paragraph(block);
    else if (block.type === 'table') block.rows.forEach((row, rowIndex) => {
      if (rowIndex) append('\n', { blockId: block.id, editable: false });
      row.cells.forEach((cell, cellIndex) => {
        if (cellIndex) append('\t', { blockId: block.id, cellId: cell.id, editable: false });
        const visible = cell.paragraphs.filter((item) => visibleParagraph(item, document.changes, view));
        visible.forEach((item, paragraphIndex) => {
          if (paragraphIndex && paragraphBoundaryVisible(visible[paragraphIndex - 1]!, item, document.changes, view)) append('\n\n', { blockId: item.id, cellId: cell.id, editable: false });
          paragraph(item, cell.id);
        });
      });
    });
    else append(block.type === 'image' ? '\uFFFC' : '\f', { blockId: block.id, editable: false });
  });
  return { text, spans, wordCount: text.replace(/[\uFFFC\f]/g, '').trim().split(/\s+/).filter(Boolean).length };
}
/** Stable canonical key ordering includes styles, layout and review metadata. */
export function canonicalDocument(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, normalize(child)])) : item;
  return JSON.stringify(normalize(value));
}
/** Conservative three-way proposal. Never guess identities, ordering or how to
 * combine overlapping text/format/object edits. The caller must review it. */
export function reconcileDocuments(base: ProserDocument, local: ProserDocument, saved: ProserDocument): { document?: ProserDocument; conflicts: string[] } {
  const result = structuredClone(saved); const conflicts: string[] = [];
  const choose = <T>(original: T, draft: T, remote: T, scope: string): T => {
    const a = canonicalDocument(original); const b = canonicalDocument(draft); const c = canonicalDocument(remote);
    if (b === a || b === c) return structuredClone(remote);
    if (c === a) return structuredClone(draft);
    conflicts.push(scope); return structuredClone(remote);
  };
  if (base.schemaVersion !== local.schemaVersion || base.schemaVersion !== saved.schemaVersion) return { conflicts: ['schemaVersion'] };
  const order = (value: ProserDocument) => value.blocks.map((block) => block.id);
  if (canonicalDocument(order(base)) === canonicalDocument(order(local)) && canonicalDocument(order(base)) === canonicalDocument(order(saved))) {
    result.blocks = base.blocks.map((block, index) => choose(block, local.blocks[index]!, saved.blocks[index]!, `block:${block.id}`));
  } else result.blocks = choose(base.blocks, local.blocks, saved.blocks, 'block-order-or-identity');
  result.layout = choose(base.layout, local.layout, saved.layout, 'layout');
  result.changes = choose(base.changes, local.changes, saved.changes, 'review-changes');
  result.comments = choose(base.comments, local.comments, saved.comments, 'comments');
  const paragraphs = paragraphsOf(result, true);
  for (const comment of result.comments) for (const anchor of comment.anchors) {
    const run = paragraphs.find((paragraph) => paragraph.id === anchor.blockId)?.runs.find((run) => run.id === anchor.runId);
    if (!run || run.text.slice(anchor.start, anchor.end) !== anchor.sourceText) conflicts.push(`comment-anchor:${comment.id}`);
  }
  const runIds = new Set(paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.id)));
  const blockIds = new Set(paragraphs.map((paragraph) => paragraph.id));
  for (const change of result.changes) if (change.targetRunIds.some((id) => !runIds.has(id)) || change.targetBlockIds?.some((id) => !blockIds.has(id))) conflicts.push(`review-target:${change.id}`);
  return conflicts.length ? { conflicts: [...new Set(conflicts)] } : { document: result, conflicts: [] };
}
/** Minimum text replacement with boundaries shared by complete graphemes. */
export function minimalTextEdit(source: string, next: string): { start: number; end: number; replacement: string } {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const left = [...segmenter.segment(source)]; const right = [...segmenter.segment(next)];
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix]!.segment === right[prefix]!.segment) prefix++;
  let a = left.length; let b = right.length;
  while (a > prefix && b > prefix && left[a - 1]!.segment === right[b - 1]!.segment) { a--; b--; }
  const start = left[prefix]?.index ?? source.length;
  const end = left[a]?.index ?? source.length;
  const nextStart = right[prefix]?.index ?? next.length;
  const nextEnd = right[b]?.index ?? next.length;
  return { start, end, replacement: next.slice(nextStart, nextEnd) };
}
export function resolveChange(document: ProserDocument, changeId: string, status: 'accepted' | 'rejected'): ProserDocument {
  const result = structuredClone(document);
  const change = result.changes.find((item) => item.id === changeId);
  if (!change || change.status !== 'pending') throw new Error('Change is missing or already resolved');
  change.status = status;
  if (change.kind === 'format' && status === 'rejected') {
    for (const paragraph of paragraphsOf(result, true)) for (const run of paragraph.runs) if (change.targetRunIds.includes(run.id)) run.style = { ...change.beforeStyle };
  }
  if (change.kind === 'paragraphFormat' && status === 'rejected') {
    for (const paragraph of paragraphsOf(result, true)) if (change.targetBlockIds?.includes(paragraph.id)) paragraph.style = { ...change.beforeParagraphStyle };
  }
  return result;
}
/** Exact, single-container replacement. Crossing protected objects or paragraph boundaries requires structured operations. */
export function replaceDocumentText(document: ProserDocument, start: number, end: number, expectedText: string, replacement: string,
  id: () => string, attribution?: Omit<DocumentChange, 'id' | 'kind' | 'targetRunIds'>, insertionTarget?: { blockId: string; runId?: string }): ProserDocument {
  const projection = projectDocument(document);
  if (start < 0 || end < start || end > projection.text.length || projection.text.slice(start, end) !== expectedText) throw new Error('DOCUMENT_SOURCE_STALE');
  const boundaries = new Set<number>([0, projection.text.length]);
  let cursor = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(projection.text)) { cursor += segment.length; boundaries.add(cursor); }
  if (!boundaries.has(start) || !boundaries.has(end)) throw new Error('Edit splits a Unicode grapheme');
  const targets = start === end ? [] : projection.spans.filter((span) => span.end > start && span.start < end);
  if (start === end) {
    let candidates = projection.spans.filter((span) => span.editable && span.start <= start && span.end >= start);
    if (insertionTarget) candidates = candidates.filter((span) => span.blockId === insertionTarget.blockId && (insertionTarget.runId === undefined || span.runId === insertionTarget.runId));
    if (!candidates.length) throw new Error('DOCUMENT_INSERTION_TARGET_STALE');
    const runs = new Map(paragraphsOf(document).flatMap((paragraph) => paragraph.runs.map((run) => [run.id, run] as const)));
    if (new Set(candidates.map((span) => span.blockId)).size !== 1 || new Set(candidates.map((span) => canonicalDocument(runs.get(span.runId!)?.style))).size !== 1) throw new Error('Insertion has ambiguous paragraph or formatting targets; supply stable block and run identities');
    targets.push(candidates[0]!);
  } else if (insertionTarget && targets.some((span) => span.blockId !== insertionTarget.blockId)) throw new Error('DOCUMENT_INSERTION_TARGET_STALE');
  if (!targets.length || targets.some((span) => !span.editable) || new Set(targets.map((span) => span.blockId)).size !== 1) throw new Error('Edit crosses a protected object or paragraph boundary');
  const result = structuredClone(document);
  const paragraph = paragraphsOf(result).find((item) => item.id === targets[0]!.blockId)!;
  const targetIds = new Set(targets.map((span) => span.runId));
  if (paragraph.runs.some((run) => targetIds.has(run.id) && run.changeId && result.changes.some((change) => change.id === run.changeId && change.status === 'pending'))) throw new Error('Resolve overlapping tracked changes before editing');
  const styles = new Set(paragraph.runs.filter((run) => targetIds.has(run.id)).map((run) => canonicalDocument(run.style)));
  if (styles.size > 1) throw new Error('Replacement crosses incompatible formatting');
  const insertId = id(); const deleteId = id();
  let inserted = false;
  const next: DocumentRun[] = [];
  for (const run of paragraph.runs) {
    const span = targets.find((item) => item.runId === run.id);
    if (!span) { next.push(run); continue; }
    const from = Math.max(0, start - span.start); const to = Math.min(run.text.length, end - span.start);
    if (from > 0) next.push({ ...run, text: run.text.slice(0, from) });
    if (attribution && to > from) next.push({ ...run, id: id(), text: run.text.slice(from, to), changeId: deleteId });
    if (!inserted) {
      if (replacement) next.push({ id: id(), text: replacement, style: { ...run.style }, ...(attribution ? { changeId: insertId } : {}) });
      inserted = true;
    }
    if (to < run.text.length) next.push({ ...run, id: from ? id() : run.id, text: run.text.slice(to) });
  }
  paragraph.runs = next.length ? next : [{ id: id(), text: '', style: {} }];
  if (attribution) {
    for (const [changeId, kind] of [[insertId, 'insertion'], [deleteId, 'deletion']] as const) {
      const targetRunIds = paragraph.runs.filter((run) => run.changeId === changeId).map((run) => run.id);
      if (targetRunIds.length) result.changes.push({ ...attribution, id: changeId, kind, targetRunIds });
    }
  }
  return result;
}

/** An explicit regeneration keeps old paragraphs for review. Only uniformly
 * styled text can be regenerated; protected objects and unresolved edits fail. */
export function regenerateDocumentText(document: ProserDocument, text: string, id: () => string, attribution: Omit<DocumentChange, 'id' | 'kind' | 'targetRunIds' | 'targetBlockIds'>): ProserDocument {
  if (document.blocks.some((block) => block.type !== 'paragraph') || paragraphsOf(document).some((paragraph) => paragraph.runs.some((run) => run.inlineImage))) throw new Error('Regeneration cannot replace protected objects');
  if (document.changes.some((change) => change.status === 'pending')) throw new Error('Resolve existing review changes before regeneration');
  const paragraphs = document.blocks.filter((block): block is DocumentParagraph => block.type === 'paragraph' && visibleParagraph(block, document.changes, 'final'));
  const styles = new Set(paragraphs.map((block) => canonicalDocument(block.style)));
  const textStyles = new Set(paragraphs.flatMap((block) => block.runs.filter((run) => visibleRun(run, document.changes, 'final')).map((run) => canonicalDocument(run.style))));
  if (styles.size > 1 || textStyles.size > 1) throw new Error('Regeneration crosses incompatible styles');
  const result = structuredClone(document); const deletionId = id(); const insertionId = id();
  const previous = result.blocks.filter((block): block is DocumentParagraph => block.type === 'paragraph' && visibleParagraph(block, result.changes, 'final'));
  for (const block of previous) {
    block.changeId = deletionId;
  }
  const next = documentFromText(text, id).blocks as DocumentParagraph[];
  for (const block of next) { block.style = { ...paragraphs[0]?.style }; block.changeId = insertionId; for (const run of block.runs) run.style = { ...paragraphs[0]?.runs.find((entry) => visibleRun(entry, document.changes, 'final'))?.style }; }
  result.blocks.push(...next);
  if (previous.length) result.changes.push({ ...attribution, id: deletionId, kind: 'paragraphDeletion', targetRunIds: [], targetBlockIds: previous.map((block) => block.id) });
  result.changes.push({ ...attribution, id: insertionId, kind: 'paragraphInsertion', targetRunIds: [], targetBlockIds: next.map((block) => block.id) });
  return result;
}
