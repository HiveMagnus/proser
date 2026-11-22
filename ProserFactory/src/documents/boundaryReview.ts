import {canonicalDocument,paragraphsOf,type ProserDocument,type DocumentChange,type DocumentParagraph} from './model';
import {DocumentError} from './errors';
function container(document:ProserDocument,left:string,right:string):string|undefined{
 const pair=(ids:Array<string|undefined>)=>ids.some((id,index)=>id===left&&ids[index+1]===right);
 if(pair(document.blocks.map((block)=>block.type==='paragraph'?block.id:undefined)))return 'body';
 if(pair(document.layout.header.map((paragraph)=>paragraph.id)))return 'header';if(pair(document.layout.footer.map((paragraph)=>paragraph.id)))return 'footer';
 for(const block of document.blocks)if(block.type==='table')for(const row of block.rows)for(const cell of row.cells)if(pair(cell.paragraphs.map((paragraph)=>paragraph.id)))return canonicalDocument({tableId:block.id,rowId:row.id,cellId:cell.id});return undefined;
}
const metadata=(paragraph:DocumentParagraph)=>{const {runs:_runs,boundaryChangeId:_boundary,...rest}=paragraph;return canonicalDocument(rest);};
/** Paragraph-mark revisions own structural identity, not subsequent prose.
 * Text continuation is authenticated separately; imported/AI boundaries cannot
 * acquire ordinary text under their old attribution without resolution. */
export function assertPendingBoundary(previous:ProserDocument|undefined,next:ProserDocument,old:DocumentChange,change:DocumentChange,actorId:number,origin:string,sources:ProserDocument[]=[]){
 if(old.status!=='pending'||!['paragraphSplit','paragraphJoin'].includes(old.kind))return;
 const [left,right]=old.targetBlockIds??[];if(!left||!right)throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Pending paragraph boundaries need exact adjacent targets.',409);
 const baseline=[...(previous?[previous]:[]),...sources].find((document)=>container(document,left,right)!==undefined);const place=baseline?container(baseline,left,right):undefined;
 if(!baseline||!place||container(next,left,right)!==place)throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Resolve the pending boundary before moving, reordering or replacing its paragraph/container identities.',409);
 const before=new Map(paragraphsOf(baseline,true).map((paragraph)=>[paragraph.id,paragraph]));const after=new Map(paragraphsOf(next,true).map((paragraph)=>[paragraph.id,paragraph]));
 if(after.get(left)?.boundaryChangeId!==old.id)throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','The pending paragraph mark cannot be replaced or detached.',409);
 for(const id of [left,right]){const a=before.get(id);const b=after.get(id);if(!a||!b||metadata(a)!==metadata(b))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Resolve the pending paragraph boundary before changing its structural metadata or style.',409);
  if(canonicalDocument(a.runs)===canonicalDocument(b.runs))continue;
  if(change.status!=='pending')throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Save edits separately before resolving this exact paragraph boundary target.',409);
  if(origin!=='manual'||old.origin!=='manual'||old.authorId!==actorId||old.importedAuthor!==undefined)throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','Resolve this pending paragraph boundary before another author/provider edits its text.',409);
  for(const run of a.runs){const current=b.runs.find((entry)=>entry.id===run.id);if(run.inlineImage&&canonicalDocument(current)!==canonicalDocument(run))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','A pending paragraph boundary protects its existing inline objects.',409);if(current&&canonicalDocument(run.style)!==canonicalDocument(current.style))throw new DocumentError('DOCUMENT_PENDING_REVIEW_TARGET_CHANGED','A pending paragraph boundary protects existing run styles; resolve it before formatting.',409);}
 }
}
