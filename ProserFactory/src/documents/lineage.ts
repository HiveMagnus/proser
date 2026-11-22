import { createHash } from 'node:crypto';
import { canonicalDocument, paragraphsOf, type ProserDocument, type DocumentAnchorLineage, type DocumentLineagePoint } from './model';
import { DocumentError } from './errors';
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const boundary=(text:string,offset:number)=>offset===0||offset===text.length||segmenter.segment(text).containing(offset)?.index===offset;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type SpanIndex = Map<string, { blockId: string; text: string; style: string; container: string; boundaries?: Set<number> }>;
function span(document: ProserDocument, point: DocumentLineagePoint, indexes: Map<ProserDocument,SpanIndex>) {
  let index = indexes.get(document);
  if (!index) {
    index = new Map(); const containers = new Map<string,string>(); const layoutHash = hash(canonicalDocument(document.layout));
    for (const block of document.blocks) if (block.type === 'table') for (const row of block.rows) for (const cell of row.cells) for (const paragraph of cell.paragraphs) containers.set(paragraph.id,canonicalDocument({ tableId:block.id,rowId:row.id,cellId:cell.id }));
    for (const paragraph of paragraphsOf(document)) for (const run of paragraph.runs) index.set(run.id,{ blockId:paragraph.id,text:run.text,style:canonicalDocument({ run:run.style,inlineImage:run.inlineImage,paragraph:paragraph.style,layoutHash }),container:containers.get(paragraph.id) ?? canonicalDocument({}) });
    indexes.set(document,index);
  }
  const run = index.get(point.runId);
  const paragraph = run?.blockId === point.blockId;
  if (!paragraph || !run || !Number.isSafeInteger(point.from) || !Number.isSafeInteger(point.to) || point.from < 0 || point.to < point.from || point.to > run.text.length) throw new DocumentError('DOCUMENT_LINEAGE_INVALID', 'Lineage requires existing stable paragraph/run spans.', 422);
  if (!boundary(run.text,point.from) || !boundary(run.text,point.to)) throw new DocumentError('DOCUMENT_LINEAGE_INVALID', 'Lineage cannot split a Unicode grapheme.', 422);
  return { text: run.text.slice(point.from,point.to), style: run.style, container: run.container };
}
/** Formatting can split run IDs without moving text. Bind the exact paragraph
 * coordinate and every protected inline image, while allowing only text/paragraph properties
 * to differ. Repeated quotations elsewhere never qualify as this lineage. */
function formattingSpan(document:ProserDocument,point:DocumentLineagePoint) {
  const paragraph=paragraphsOf(document).find(block=>block.id===point.blockId)!;
  const position=paragraph.runs.findIndex(run=>run.id===point.runId);
  let offset=0;const images:Array<{offset:number;image:unknown}>=[];
  for(const run of paragraph.runs) {if(run.inlineImage)images.push({offset,image:run.inlineImage});offset+=run.text.length;}
  const prefix=paragraph.runs.slice(0,position).reduce((sum,run)=>sum+run.text.length,0);
  return canonicalDocument({paragraphId:paragraph.id,text:paragraph.runs.map(run=>run.text).join(""),images,layout:document.layout,from:prefix+point.from,to:prefix+point.to});
}
/** A claimed lineage is evidence only after validating both stable anchored
 * spans. Matching quotations in untouched source content cannot relocate it. */
export function validateAnchorLineage(mappings: DocumentAnchorLineage[], scopes: Array<{ sceneId: number; previous: ProserDocument; next: ProserDocument }>, verifiedRestorations: ReadonlyMap<number, ProserDocument> = new Map()) {
  if (mappings.length > 10000) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Too many lineage mappings.',413);
  const sources: Array<DocumentLineagePoint> = [];
  const indexes = new Map<ProserDocument,SpanIndex>();
  return mappings.map((mapping) => {
    if (!['split','join','move','restore','format'].includes(mapping.kind)) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Unsupported lineage operation.',422);
    const source = scopes.find((scope) => scope.sceneId === mapping.source.sceneId); const target = scopes.find((scope) => scope.sceneId === mapping.target.sceneId);
    if (!source || !target) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Both lineage scopes must commit atomically.',409);
    if (mapping.kind === 'restore' && (!verifiedRestorations.has(target.sceneId) || canonicalDocument(verifiedRestorations.get(target.sceneId)) !== canonicalDocument(target.next))) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Restore lineage requires a server-verified complete immutable scene revision.',409);
    const before = span(source.previous,mapping.source,indexes); const after = span(target.next,mapping.target,indexes);
    if (before.text !== after.text || before.container !== after.container || (mapping.kind === 'format'
      ? mapping.source.sceneId !== mapping.target.sceneId || mapping.source.blockId !== mapping.target.blockId || formattingSpan(source.previous,mapping.source) !== formattingSpan(target.next,mapping.target)
      : before.style !== after.style)) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Lineage must preserve exact text, paragraph coordinates and protected content; only explicit formatting lineage may change text/paragraph properties.',409);
    if (mapping.kind !== 'split' && mapping.kind !== 'restore' && mapping.kind !== 'format' && mapping.source.runId !== mapping.target.runId) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Move/join must retain run identity.',409);
    const identical = canonicalDocument(mapping.source) === canonicalDocument(mapping.target);
    let retained = false;
    try { const current = span(source.next,mapping.source,indexes); retained = current.text === before.text && current.style === before.style; } catch { /* A removed/split source is expected. */ }
    if (retained && !identical && mapping.kind !== 'format') throw new DocumentError('DOCUMENT_LINEAGE_INVALID','An unchanged source cannot be reattached by matching another quotation.',409);
    if (sources.some((point) => point.sceneId === mapping.source.sceneId && point.blockId === mapping.source.blockId && point.runId === mapping.source.runId && point.from < mapping.source.to && mapping.source.from < point.to)) throw new DocumentError('DOCUMENT_LINEAGE_INVALID','Source lineage spans cannot overlap.',409);
    sources.push(mapping.source);
    return { ...mapping, sourceTextSha256: hash(before.text), styleSha256: hash(before.style) };
  });
}
