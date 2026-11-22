import { createHash } from 'node:crypto';
import type { WordStyleDefinitions } from '@hivemagnus/canvas-word-codec';
import type { DocumentStyleDefinitions } from './style-model';
import type { WordDocument } from '@hivemagnus/canvas-word-codec';
import { paragraphsOf, type ProserDocument, type DocumentParagraph, type DocumentBlock } from './model';
import { validateDocument } from './validation';
/** Immutable source proofs/history stay in Factory. Detached ranges never become guessed Word anchors. */
export function wordExchangeDocument(raw: ProserDocument, story?:'header'|'footer',definitions?:DocumentStyleDefinitions): WordDocument {
  const document = validateDocument(raw);
  if(definitions){for(const paragraph of paragraphsOf(document,true)){if(paragraph.style.name&&definitions.paragraph[paragraph.style.name])paragraph.style.name=wordStyleId('paragraph',paragraph.style.name);for(const run of paragraph.runs)if(run.style.characterStyleId)run.style.characterStyleId=wordStyleId('character',run.style.characterStyleId);}for(const change of document.changes){for(const style of [change.beforeParagraphStyle,change.afterParagraphStyle])if(style?.name&&definitions.paragraph[style.name])style.name=wordStyleId('paragraph',style.name);for(const style of [change.beforeStyle,change.afterStyle])if(style?.characterStyleId)style.characterStyleId=wordStyleId('character',style.characterStyleId);}}
  const detached = new Set(detachedHistoricalBoundaryIds(document));
  for (const paragraph of paragraphsOf(document, true)) if (paragraph.boundaryChangeId && detached.has(paragraph.boundaryChangeId)) delete paragraph.boundaryChangeId;
  const bodyRuns=new Set(paragraphsOf(document).flatMap((paragraph)=>paragraph.runs.map((run)=>run.id)));
  return {
    ...document,
    changes:document.changes.filter((change)=>!detached.has(change.id)).map((change)=>{const plain={...change};delete plain.resolutionHistory;delete plain.historicalBoundarySource;return plain;}),
    comments: document.comments.filter((comment) => !story && !comment.resolved && !comment.anchorStates?.length && comment.anchors.every((anchor)=>bodyRuns.has(anchor.runId))).map((comment) => ({
      id: comment.id, authorId: comment.authorId, authorName: comment.authorName, createdAt: comment.createdAt,
      text: comment.text, anchors: comment.anchors, resolved: comment.resolved,
      ...(comment.importedAuthor ? { importedAuthor: comment.importedAuthor } : {}),
    })),
  };
}

const wordStyleId=(kind:'paragraph'|'character',id:string)=>`${kind[0]}-${createHash('sha256').update(id).digest('hex').slice(0,24)}`;
export function wordStyleDefinitions(definitions:DocumentStyleDefinitions|undefined):WordStyleDefinitions {
  const result:WordStyleDefinitions={};if(!definitions)return result;
  const text=(style:import('./model').TextStyle)=>({...style,...(style.characterStyleId?{characterStyleId:wordStyleId('character',style.characterStyleId)}:{})});
  for(const [id,paragraph] of Object.entries(definitions.paragraph))result[wordStyleId('paragraph',id)]={kind:'paragraph',paragraph:{...paragraph,name:undefined},run:text(definitions.text[id]??{}),label:definitions.labels?.[id]??id};
  for(const [id,run] of Object.entries(definitions.text))result[wordStyleId('character',id)]={kind:'character',paragraph:{},run:text(run),label:definitions.labels?.[id]??id};
  return result;
}

/** Detached resolved paragraph marks are historical evidence, not current Word
 * revisions. Linked current marks still determine the effective projection. */
export function detachedHistoricalBoundaryIds(document: ProserDocument): string[] {
  const linked = new Set<string>();
  const changes = new Map(document.changes.map((change) => [change.id, change]));
  const visit = (blocks: Array<DocumentBlock | DocumentParagraph>) => {
    for (let index = 0; index < blocks.length; index++) {
      const left = blocks[index], right = blocks[index + 1];
      if (left.type === 'table') for (const row of left.rows) for (const cell of row.cells) visit(cell.paragraphs);
      if (left.type !== 'paragraph' || right?.type !== 'paragraph' || !left.boundaryChangeId) continue;
      const change = changes.get(left.boundaryChangeId);
      if (change && change.targetBlockIds?.[0] === left.id && change.targetBlockIds?.[1] === right.id) linked.add(change.id);
    }
  };
  visit(document.blocks); visit(document.layout.header); visit(document.layout.footer);
  return document.changes.filter((change) => change.historicalBoundarySource && change.status !== 'pending' && ['paragraphSplit', 'paragraphJoin'].includes(change.kind) && !linked.has(change.id)).map((change) => change.id);
}
