/** Addresses are transient cursors in one immutable revision, never target identities. */
import type { ProserDocument, DocumentParagraph, DocumentImage, DocumentBreak, DocumentTable } from './model';
import type { DocumentPassageParagraph, DocumentPassageItem } from './passage-model';
import { passageOperationObjectSource, passageOperationPlacement, passageTableRowHash, passageTableColumnHash } from './passageOperationSources';
export interface PassageLeaf {
 blockOrdinal:number; paragraph?:DocumentParagraph; ordinal:number;
 object?:DocumentImage|DocumentBreak; table?:DocumentTable; tableHead?:boolean;
 container?:DocumentPassageParagraph['container'];
}
export function passageLeaves(document:ProserDocument):PassageLeaf[]{
 const result:PassageLeaf[]=[];let ordinal=0;
 document.blocks.forEach((block,blockOrdinal)=>{
  if(block.type==='paragraph')result.push({blockOrdinal,paragraph:block,ordinal:ordinal++});
  else if(block.type==='table'){
   result.push({blockOrdinal,table:block,tableHead:true,ordinal});
   block.rows.forEach((row,rowOrdinal)=>row.cells.forEach((cell,columnIndex)=>cell.paragraphs.forEach((paragraph,cellParagraphOrdinal)=>result.push({blockOrdinal,table:block,paragraph,ordinal:ordinal++,container:{tableId:block.id,rowId:row.id,cellId:cell.id,widths:block.widths,rowOrdinal,columnIndex,cellParagraphOrdinal}}))));
  }else result.push({blockOrdinal,object:block,ordinal});
 });return result;
}
export function passageItemPlacement(document:ProserDocument,id:string){return{before:passageOperationPlacement(document,id,'before'),after:passageOperationPlacement(document,id,'after')};}
export function orderedPassageItems(document:ProserDocument, leaves:PassageLeaf[], selected:number[], paragraphs:DocumentPassageParagraph[]):DocumentPassageItem[]{
 const items:DocumentPassageItem[]=[];const tables=new Map<string,Extract<DocumentPassageItem,{type:'tableSlice'}>>();
 for(const index of selected){
  const entry=leaves[index]!,block=document.blocks[entry.blockOrdinal]!;
  if(entry.object){
   const common={blockOrdinal:entry.blockOrdinal,placement:passageItemPlacement(document,entry.object.id),source:passageOperationObjectSource(document,entry.object.id)};
   items.push(entry.object.type==='image'?{type:'image',image:structuredClone(entry.object),...common}:{type:'pageBreak',pageBreak:{...entry.object},...common});continue;
  }
  const paragraphIndex=paragraphs.findIndex(p=>p.ordinal===entry.ordinal&&p.paragraph.id===entry.paragraph?.id);
  if(entry.table){
   const table=entry.table;let item=tables.get(table.id);
   if(!item){item={type:'tableSlice',id:table.id,widths:[...table.widths],source:passageOperationObjectSource(document,table.id),placement:passageItemPlacement(document,table.id),blockOrdinal:entry.blockOrdinal,rowCount:table.rows.length,columnCount:table.widths.length,columnHashes:table.widths.map((_,column)=>passageTableColumnHash(table,column)),continuedBefore:!entry.tableHead,continuedAfter:true,rows:[]};tables.set(table.id,item);items.push(item);}
   if(paragraphIndex<0)continue;
   const descriptor=paragraphs[paragraphIndex]!,container=entry.container!,rowOrdinal=container.rowOrdinal!,columnIndex=container.columnIndex!;
   const originalRow=table.rows[rowOrdinal]!,originalCell=originalRow.cells[columnIndex]!;
   let row=item.rows.find(row=>row.id===originalRow.id);
   if(!row){row={id:originalRow.id,ordinal:rowOrdinal,sourceHash:passageTableRowHash(originalRow),cells:[]};item.rows.push(row);}
   let cell=row.cells.find(cell=>cell.id===originalCell.id);
   if(!cell){cell={id:originalCell.id,columnIndex,paragraphCount:originalCell.paragraphs.length,continuedBefore:container.cellParagraphOrdinal!>0||descriptor.continuedBefore,continuedAfter:true,paragraphIndexes:[]};row.cells.push(cell);}
   cell.paragraphIndexes.push(paragraphIndex);
   cell.continuedAfter=container.cellParagraphOrdinal!==originalCell.paragraphs.length-1||descriptor.continuedAfter;
   item.continuedAfter=rowOrdinal!==table.rows.length-1||columnIndex!==originalRow.cells.length-1||cell.continuedAfter;
  }else if(paragraphIndex>=0)items.push({type:'paragraph',paragraphIndex,blockOrdinal:entry.blockOrdinal,placement:passageItemPlacement(document,block.id)});
 }
 return items;
}
