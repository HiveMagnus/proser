import { z } from 'zod';
import { MAX_DOCUMENT_BYTES, type ProserDocument, paragraphsOf, canonicalDocument } from './model';
import { DocumentError } from './errors';
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const textStyle = z.object({
  characterStyleId:identifier.optional(),
  font: z.string().min(1).max(100).optional(), size: z.number().min(6).max(144).optional(),
  bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), strikeout: z.boolean().optional(),
  color: color.optional(), highlight: color.optional(), hyperlink: z.string().max(2048).url().refine((value) => /^https?:\/\//i.test(value), 'Only HTTP(S) hyperlinks are supported').optional(),
}).strict();
const paragraphStyle = z.object({ name: z.string().max(100).optional(), alignment: z.enum(['left', 'center', 'right', 'justify']).optional(), lineSpacing: z.number().min(0.5).max(5).optional(), before: z.number().min(0).max(500).optional(), after: z.number().min(0).max(500).optional(), indent: z.number().min(0).max(500).optional(), firstLineIndent: z.number().min(-500).max(500).optional(), keepWithNext: z.boolean().optional(), pageBreakBefore: z.boolean().optional(), heading: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional(), list: z.enum(['bullet', 'number']).optional() }).strict();
const inlineImage = z.object({ assetId: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), alt: z.string().max(2000), width: z.number().positive().max(16384), height: z.number().positive().max(16384) }).strict();
const paragraph = z.object({
  type: z.literal('paragraph'), id: identifier, changeId: identifier.optional(), boundaryChangeId: identifier.optional(),
  style: paragraphStyle,
  runs: z.array(z.object({ id: identifier, text: z.string().max(MAX_DOCUMENT_BYTES), style: textStyle, changeId: identifier.optional(), inlineImage: inlineImage.optional() }).strict()).min(1).max(20000),
}).strict();
export const commentAnchorSchema = z.object({ blockId: identifier, runId: identifier, start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), sourceText: z.string().max(20000) }).strict();
const commentAnchorStateBase = z.object({ anchorIndex: z.number().int().nonnegative(), status: z.enum(['stale','orphaned']), reason: z.enum(['target-removed','target-text-changed','target-hidden','target-container-changed','target-image-changed']), sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/), sourceAnchor: commentAnchorSchema });
const commentAnchorState = z.union([
  commentAnchorStateBase.extend({ sourceKind: z.literal('scene').optional(), sourceSceneId: z.number().int().positive(), sourceSceneRevisionId: z.string().uuid() }).strict(),
  commentAnchorStateBase.extend({ sourceKind: z.literal('layout-story'), sourceStoryId: identifier, sourceLayoutRevisionId: z.string().uuid() }).strict(),
]);
const commentResolutionBase = z.object({ operationId: z.string().uuid(), action: z.enum(['resolved','reopened','reanchored']), actorId: z.number().int().positive(), actorName: z.string().max(200), createdAt: z.string().datetime(), previousAnchors: z.array(commentAnchorSchema).min(1).max(1000), previousAnchorStates: z.array(commentAnchorState).max(1000).optional() });
const commentResolution = z.union([
  commentResolutionBase.extend({ sourceKind: z.literal('scene').optional(), sourceSceneRevisionId: z.string().uuid() }).strict(),
  commentResolutionBase.extend({ sourceKind: z.literal('layout-story'), sourceStoryId: identifier, sourceLayoutRevisionId: z.string().uuid() }).strict(),
]);
const changeResolutionBase = z.object({ operationId: z.string().uuid(), actorId: z.number().int().positive(), actorName: z.string().max(200), createdAt: z.string().datetime(), decision: z.enum(['accepted','rejected']), origin: z.enum(['manual','workflow']), phase: z.enum(['resolved','created-and-resolved']), sourceBookRevisionId: z.string().uuid(), sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/), workflowRunId: z.string().uuid().optional() });
const changeResolution = z.union([
  changeResolutionBase.extend({ sourceKind: z.literal('scene'), sourceSceneId: z.number().int().positive(), sourceSceneRevisionId: z.string().uuid() }).strict(),
  changeResolutionBase.extend({ sourceKind: z.literal('layout-story'), sourceStoryId: identifier, sourceLayoutRevisionId: z.string().uuid() }).strict(),
  changeResolutionBase.extend({ sourceKind: z.literal('scene-creation'), sourceSceneId: z.number().int().positive() }).strict(),
]).superRefine((event, context) => {
  if (event.origin === 'workflow' && !event.workflowRunId) context.addIssue({code: z.ZodIssueCode.custom, message:'Workflow resolution requires its exact run identity.'});
  if (event.phase === 'created-and-resolved' && event.origin !== 'workflow') context.addIssue({code: z.ZodIssueCode.custom, message:'Only authorized workflow automation can create and resolve in one transaction.'});
  if (event.sourceKind === 'scene-creation' && event.phase !== 'created-and-resolved') context.addIssue({code: z.ZodIssueCode.custom, message:'Fresh scene history cannot claim an existing pending decision.'});
});
const historicalBoundaryBase = z.object({sourceBookRevisionId:z.string().uuid(),sourceBookContentHash:z.string().regex(/^[a-f0-9]{64}$/),sourceDocumentHash:z.string().regex(/^[a-f0-9]{64}$/),changeHash:z.string().regex(/^[a-f0-9]{64}$/),targetHash:z.string().regex(/^[a-f0-9]{64}$/)});
const historicalBoundarySource = z.union([
 historicalBoundaryBase.extend({sourceKind:z.literal('scene'),sourceSceneId:z.number().int().positive(),sourceSceneRevisionId:z.string().uuid()}).strict(),
 historicalBoundaryBase.extend({sourceKind:z.literal('layout-story'),sourceStoryId:identifier,sourceLayoutRevisionId:z.string().uuid()}).strict(),
]);
export const documentSchema = z.object({
  schemaVersion: z.literal(1),
  blocks: z.array(z.discriminatedUnion('type', [paragraph,
    z.object({ type: z.literal('image'), id: identifier, assetId: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), alt: z.string().max(2000), width: z.number().positive().max(16384), height: z.number().positive().max(16384) }).strict(),
    z.object({ type: z.literal('table'), id: identifier, widths: z.array(z.number().positive().max(2000)).min(1).max(100), rows: z.array(z.object({ id: identifier, cells: z.array(z.object({ id: identifier, paragraphs: z.array(paragraph).min(1).max(1000) }).strict()).min(1).max(100) }).strict()).min(1).max(100) }).strict(),
    z.object({ type: z.literal('pageBreak'), id: identifier }).strict(),
  ])).max(20000),
  changes: z.array(z.object({ id: identifier, kind: z.enum(['insertion', 'deletion', 'format', 'paragraphInsertion', 'paragraphDeletion', 'paragraphFormat', 'paragraphSplit', 'paragraphJoin']), authorId: z.number().int().nonnegative(), authorName: z.string().max(200), createdAt: z.string().datetime(), status: z.enum(['pending', 'accepted', 'rejected']), origin: z.enum(['manual', 'ai', 'workflow', 'import']), importedAuthor: z.string().max(200).optional(), targetRunIds: z.array(identifier).max(20000), targetBlockIds: z.array(identifier).max(20000).optional(), beforeStyle: textStyle.optional(), afterStyle: textStyle.optional(), beforeParagraphStyle: paragraphStyle.optional(), afterParagraphStyle: paragraphStyle.optional(), resolutionHistory: z.array(changeResolution).max(1000).optional(), historicalBoundarySource: historicalBoundarySource.optional() }).strict()).max(10000),
  comments: z.array(z.object({ id: identifier, authorId: z.number().int().nonnegative(), authorName: z.string().max(200), createdAt: z.string().datetime(), text: z.string().max(10000), anchors: z.array(commentAnchorSchema).min(1).max(1000), resolved: z.boolean(), importedAuthor: z.string().max(200).optional(), anchorStates: z.array(commentAnchorState).max(1000).optional(), resolutionHistory: z.array(commentResolution).max(1000).optional() }).strict()).max(10000),
  layout: z.object({ preset: z.enum(['manuscript', 'book']), width: z.number().min(100).max(2000), height: z.number().min(100).max(3000), margins: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]), font: z.string().min(1).max(100), fontSize: z.number().min(6).max(144), pageNumbers: z.boolean(), header: z.array(paragraph).max(100), footer: z.array(paragraph).max(100) }).strict(),
}).strict();
function validateCanonicalDocument(raw: unknown, reviewCandidates = false): ProserDocument {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > MAX_DOCUMENT_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', 'Document exceeds 2 MiB', 413);
  const document = documentSchema.parse(raw);
  const validateUnicode = (value: unknown): void => {
    if (typeof value === 'string' && (/\u0000/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))) throw new Error('Canonical strings require valid Unicode without NUL. Original bytes must be preserved separately.');
    if (Array.isArray(value)) for (const item of value) validateUnicode(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) validateUnicode(item);
  };
  validateUnicode(document);
  const ids = new Set<string>();
  const add = (id: string) => { if (ids.has(id)) throw new Error('Duplicate document identity'); ids.add(id); };
  const runs = new Map<string, { text: string; blockId: string }>();
  for (const block of document.blocks) {
    if (block.type !== 'paragraph') add(block.id);
    if (block.type === 'table') {
      for (const row of block.rows) { add(row.id); if (row.cells.length !== block.widths.length) throw new Error('Table column count mismatch'); for (const cell of row.cells) add(cell.id); }
    }
  }
  for (const block of paragraphsOf(document, true)) {
    add(block.id);
    for (const run of block.runs) {
      add(run.id);
      if (run.inlineImage && (run.text !== '' || Object.keys(run.style).length)) throw new Error('Inline images require a protected empty text/style run');
      runs.set(run.id, { text: run.text, blockId: block.id });
    }
  }
  const paragraphIds = new Set(paragraphsOf(document, true).map((block) => block.id));
  const byParagraphId = new Map(paragraphsOf(document, true).map((block) => [block.id, block]));
  const adjacent = new Set<string>();
  const story = (paragraphs: Array<{ id: string }>) => { for (let index = 1; index < paragraphs.length; index++) adjacent.add(JSON.stringify([paragraphs[index - 1]!.id, paragraphs[index]!.id])); };
  // A page break, image, table or cell boundary cannot be a paragraph mark.
  for (let index = 1; index < document.blocks.length; index++) { const left = document.blocks[index - 1]!; const right = document.blocks[index]!; if (left.type === 'paragraph' && right.type === 'paragraph') story([left, right]); }
  story(document.layout.header); story(document.layout.footer);
  for (const block of document.blocks) if (block.type === 'table') for (const row of block.rows) for (const cell of row.cells) story(cell.paragraphs);
  const paragraphFormats = new Set<string>();
  for (const change of document.changes) {
    if(!reviewCandidates&&change.resolutionHistory?.length&&(change.status==='pending'||change.resolutionHistory[change.resolutionHistory.length-1]!.decision!==change.status))throw new Error('Resolution history must match the resolved change state');
    if(new Set((change.resolutionHistory??[]).map((event)=>event.operationId)).size!==(change.resolutionHistory?.length??0))throw new Error('Duplicate resolution operation identity');
    const historical = change.historicalBoundarySource !== undefined;
    const boundary = change.kind === 'paragraphSplit' || change.kind === 'paragraphJoin';
    if (historical && (!boundary || change.status === 'pending')) throw new Error('Only resolved paragraph boundaries can retain historical target evidence');
    add(change.id); if ((!boundary || change.status === 'pending' || !historical && !reviewCandidates) && (change.targetRunIds.some((id) => !runs.has(id)) || change.targetBlockIds?.some((id) => !paragraphIds.has(id)))) throw new Error('Change target does not exist');
    if (new Set(change.targetRunIds).size !== change.targetRunIds.length || new Set(change.targetBlockIds).size !== (change.targetBlockIds?.length ?? 0)) throw new Error('Duplicate change target');
    if (change.kind.startsWith('paragraph') && (!change.targetBlockIds?.length || change.targetRunIds.length)) throw new Error('Paragraph revisions require paragraph targets');
    if (['paragraphInsertion', 'paragraphDeletion'].includes(change.kind) && change.status === 'pending' && change.targetBlockIds?.some((id) => paragraphsOf(document, true).find((block) => block.id === id)?.changeId !== change.id)) throw new Error('Pending paragraph review links cannot be discarded');
    if (change.kind === 'paragraphFormat') {
      if (!change.beforeParagraphStyle || !change.afterParagraphStyle) throw new Error('Paragraph formatting revisions require both property snapshots');
      for (const id of change.targetBlockIds!) {
        if (change.status === 'pending' && paragraphFormats.has(id)) throw new Error('Overlapping paragraph formatting revisions');
        if (change.status === 'pending') { paragraphFormats.add(id); if (canonicalDocument(byParagraphId.get(id)!.style) !== canonicalDocument(change.afterParagraphStyle)) throw new Error('Pending paragraph formatting differs from proposed properties'); }
      }
    }
    if (change.kind === 'paragraphSplit' || change.kind === 'paragraphJoin') {
      const [left, right] = change.targetBlockIds!;
      if (change.targetBlockIds!.length !== 2 || (!historical && !(reviewCandidates && change.status !== 'pending') && (!adjacent.has(JSON.stringify([left, right])) || byParagraphId.get(left)?.boundaryChangeId !== change.id))) throw new Error('Paragraph mark revisions require linked adjacent paragraphs in the same container');
    }
  }
  for (const block of paragraphsOf(document, true)) if (block.changeId && !document.changes.some((change) => change.id === block.changeId && ['paragraphInsertion', 'paragraphDeletion'].includes(change.kind) && change.targetBlockIds?.includes(block.id))) throw new Error('Missing paragraph change');
  for (const block of paragraphsOf(document, true)) if (block.boundaryChangeId && !document.changes.some((change) => change.id === block.boundaryChangeId && (change.kind === 'paragraphSplit' || change.kind === 'paragraphJoin') && change.targetBlockIds?.[0] === block.id)) throw new Error('Missing paragraph mark change');
  for (const block of paragraphsOf(document, true)) for (const run of block.runs) {
    if (run.changeId && !document.changes.some((change) => change.id === run.changeId && change.targetRunIds.includes(run.id))) throw new Error('Missing run change');
  }
  for (const comment of document.comments) {
    add(comment.id);
    const detached = new Map((comment.anchorStates ?? []).map((state) => [state.anchorIndex, state]));
    if (detached.size !== (comment.anchorStates?.length ?? 0) || [...detached.keys()].some((index) => index >= comment.anchors.length)) throw new Error('Invalid detached comment anchor index');
    for (const [index, anchor] of comment.anchors.entries()) {
      if (anchor.end < anchor.start || anchor.end - anchor.start !== anchor.sourceText.length) throw new Error('Invalid comment anchor source span');
      const state = detached.get(index);
      if (state) { if (canonicalDocument(state.sourceAnchor) !== canonicalDocument(anchor)) throw new Error('Detached comment source evidence differs from its retained anchor'); continue; }
      const run = runs.get(anchor.runId);
      if (!run || run.blockId !== anchor.blockId || anchor.end > run.text.length || run.text.slice(anchor.start, anchor.end) !== anchor.sourceText) throw new Error('Comment anchor is stale');
    }
  }
  const { width, height, margins } = document.layout;
  if (margins[1] + margins[3] >= width || margins[0] + margins[2] >= height) throw new Error('Page margins leave no content area');
  return document;
}
export function validateDocument(raw: unknown, options: { reviewCandidates?: boolean } = {}): ProserDocument {
  try { return validateCanonicalDocument(raw, options.reviewCandidates ?? false); }
  catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('DOCUMENT_INVALID', error instanceof z.ZodError ? 'Invalid canonical document schema.' : error instanceof Error ? error.message : 'Invalid canonical document.', 422);
  }
}
