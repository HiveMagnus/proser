import {chromium} from 'playwright';
import {inspectImageMetadata} from '@/lib/imageMetadata';
import {paragraphsOf} from './model';
import {DocumentError} from './errors';
import {publicationDocuments,type PublicationInput} from './publicationRender';
export interface PublicationImageDerivation {assetId:number;originalSha256:string;derivedSha256:string;originalMediaType:'image/webp';derivedMediaType:'image/png';width:number;height:number;rendererVersion:string;method:'chromium-static-webp-to-png'}
/** Only the export projection changes; owned source bytes, references and revisions stay exact. */
export async function prepareDocxImages(input:PublicationInput):Promise<{input:PublicationInput;derivations:PublicationImageDerivation[];rendererVersion:string|null}> {
 const webp=[...input.assets].filter(([,asset])=>asset.mediaType==='image/webp');
 if(!webp.length)return{input,derivations:[],rendererVersion:null};
 const projected={...input,sections:structuredClone(input.sections),assets:new Map(input.assets)};
 const derivations:PublicationImageDerivation[]=[];const browser=await chromium.launch({headless:true});
 try {
  const version=browser.version();let totalBytes=[...input.assets.values()].reduce((total,asset)=>total+asset.bytes.length,0);
  for(const [assetId,asset]of webp){
   let source:ReturnType<typeof inspectImageMetadata>;try{source=inspectImageMetadata(asset.bytes);}catch{throw new DocumentError('EXPORT_ASSET_UNAVAILABLE','WebP source has invalid or unsupported bounded headers.',409);}
   const page=await browser.newPage({viewport:{width:source.width,height:source.height},deviceScaleFactor:1});
   let bytes:Buffer;
   try{await page.route('**/*',(route)=>route.abort());await page.setContent(`<html><head><style>html,body{margin:0;width:${source.width}px;height:${source.height}px}img{display:block;width:${source.width}px;height:${source.height}px}</style></head><body><img alt="" src="data:image/webp;base64,${asset.bytes.toString('base64')}"/></body></html>`,{waitUntil:'load',timeout:10_000});await page.evaluate("document.querySelector('img').decode()");bytes=await page.screenshot({type:'png',omitBackground:true,timeout:10_000});}catch{throw new DocumentError('EXPORT_IMAGE_CONVERSION_FAILED','Pinned Chromium could not derive a complete PNG from the verified static WebP.',409);}finally{await page.close();}
   if(bytes.length>32*1024*1024)throw new DocumentError('EXPORT_ASSET_LIMIT','A derived PNG exceeds the supported 32 MiB image bound.',413);
   const derived=inspectImageMetadata(bytes);if(derived.mediaType!=='image/png'||derived.width!==source.width||derived.height!==source.height)throw new DocumentError('EXPORT_IMAGE_CONVERSION_FAILED','Derived PNG dimensions differ from the source image.',409);
   totalBytes+=bytes.length-asset.bytes.length;if(totalBytes>256*1024*1024)throw new DocumentError('EXPORT_ASSET_LIMIT','Derived publication assets exceed 256 MiB.',413);
   projected.assets.set(assetId,{bytes,mediaType:'image/png'});
   for(const section of projected.sections)for(const image of publicationDocuments(section).flatMap((document)=>[...document.blocks.filter((block)=>block.type==='image'),...paragraphsOf(document,true).flatMap((paragraph)=>paragraph.runs.flatMap((run)=>run.inlineImage?[run.inlineImage]:[]))]))if(image.assetId===assetId){if(image.sha256!==source.sha256)throw new DocumentError('EXPORT_ASSET_UNAVAILABLE','WebP reference differs from verified original bytes.',409);image.sha256=derived.sha256;}
   derivations.push({assetId,originalSha256:source.sha256,derivedSha256:derived.sha256,originalMediaType:'image/webp',derivedMediaType:'image/png',width:source.width,height:source.height,rendererVersion:version,method:'chromium-static-webp-to-png'});
  }
  return{input:projected,derivations,rendererVersion:version};
 }finally{await browser.close();}
}
