import {foldSearchGrapheme} from './searchCaseFold';
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
/** Boundary maps exist only at full grapheme boundaries. Expansion (ß→ss),
 * composition and combining marks never create half-grapheme result offsets. */
function lowerBound(values:number[],needle:number){let left=0;let right=values.length;while(left<right){const middle=(left+right)>>>1;if(values[middle]!<needle)left=middle+1;else right=middle;}return left;}
export function normalizedSearchText(text:string,caseSensitive=false){
 if(/^[\x00-\x7f]*$/.test(text)){
  const get=(offset:number)=>Number.isInteger(offset)&&offset>=0&&offset<=text.length&&!(text[offset-1]==='\r'&&text[offset]==='\n')?offset:undefined;
  return {text:caseSensitive?text:text.toLowerCase(),ascii:true,originalOffsets:[] as number[],boundaries:{get,has:(offset:number)=>get(offset)!==undefined}};
 }
 const chunks:string[]=[];const normalizedOffsets=[0];const originalOffsets=[0];let length=0;
 for(const entry of segmenter.segment(text)){const folded=foldSearchGrapheme(entry.segment,caseSensitive);chunks.push(folded);length+=folded.length;normalizedOffsets.push(length);originalOffsets.push(entry.index+entry.segment.length);}
 const get=(offset:number)=>{const position=lowerBound(normalizedOffsets,offset);return normalizedOffsets[position]===offset?originalOffsets[position]:undefined;};
 return {text:chunks.join(''),ascii:false,originalOffsets,boundaries:{get,has:(offset:number)=>get(offset)!==undefined}};
}
export function searchExcerpt(text:string,from:number,to:number,searchable:ReturnType<typeof normalizedSearchText>){
 let excerptFrom:number;let excerptTo:number;
 if(searchable.ascii){excerptFrom=Math.max(0,from-120);excerptTo=Math.min(text.length,to+120);if(text[excerptFrom-1]==='\r'&&text[excerptFrom]==='\n')excerptFrom--;if(text[excerptTo-1]==='\r'&&text[excerptTo]==='\n')excerptTo++;}
 else{const boundaries=searchable.originalOffsets;const start=lowerBound(boundaries,from);const end=lowerBound(boundaries,to);excerptFrom=boundaries[Math.max(0,start-80)]!;excerptTo=boundaries[Math.min(boundaries.length-1,end+80)]!;}
 return {excerpt:text.slice(excerptFrom,excerptTo),excerptFrom,excerptTo};
}
