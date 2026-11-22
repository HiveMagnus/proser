import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { documentService, type DocumentManifest } from './service';
import { convertSupportedLegacyHtml } from './legacyHtml';
import { canonicalDocument, projectDocument, type ProserDocument } from './model';
import { validateDocument } from './validation';
import { compatibilityOperationId } from './operationIdentity';
import { DocumentError } from './errors';
const hash = (value:unknown)=>createHash('sha256').update(canonicalDocument(value)).digest('hex');
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function previewLegacyHtmlScene(userId:number,bookId:number,sceneId:number) {
  return documentService.sideRecord(userId,bookId,async(tx)=>{
    const head=await tx.bookDocumentHead.findUnique({where:{bookId}});
    if(!head)throw new DocumentError('DOCUMENT_NOT_MIGRATED','Preserve the raw scene through explicit initial backfill before previewing HTML.',409);
    const manifest=head.manifest as unknown as DocumentManifest;
    const reference=manifest.scenes.find((scene)=>scene.sceneId===sceneId&&!scene.deletedAt);
    if(!reference)throw new DocumentError('DOCUMENT_SCOPE_NOT_FOUND','Scene not found.',404);
    const body=await tx.sceneDocumentRevision.findFirstOrThrow({where:{id:reference.revisionId,sceneId,bookId}});
    const source=validateDocument(body.document); const raw=projectDocument(source).text;
    if(!/<\/?[a-z][^>]*>/i.test(raw))throw new DocumentError('DOCUMENT_LEGACY_HTML_REQUIRED','Scene has no legacy HTML to convert.',409);
    if(source.changes.length||source.comments.length||source.blocks.some((block)=>block.type!=='paragraph'||Object.keys(block.style).length>0||block.runs.some((run)=>Object.keys(run.style).length)))throw new DocumentError('DOCUMENT_LEGACY_HTML_AMBIGUOUS','Formatting, review or protected objects already exist; reconcile them explicitly instead of replacing a legacy HTML body.',409);
    const bytes=Buffer.from(raw,'utf8'); const sourceSha=createHash('sha256').update(bytes).digest('hex');
    const originalId=compatibilityOperationId('proser.legacy-html.original.v1',{bookId,sceneId,sourceSha});
    const existing=await tx.documentImportOriginal.findUnique({where:{id:originalId}});
    if(!existing)await tx.documentImportOriginal.create({data:{id:originalId,bookId,userId,format:'legacy-html-v1',sha256:sourceSha,byteLength:bytes.length,bytes}});
    else if(existing.bookId!==bookId||existing.userId!==userId||existing.sha256!==sourceSha||!Buffer.from(existing.bytes).equals(bytes))throw new DocumentError('DOCUMENT_IMPORT_ORIGINAL_INVALID','Preserved original does not match its source.',503);
    // Original preservation commits even when conversion fails; perform the
    // converter outside this transaction in the next owned admission.
    return {originalId,sourceBookRevision:head.revisionId,sourceSceneRevision:reference.revisionId,sourceSha,raw,layout:source.layout};
  }).then(async(source)=>{
    const converted=convertSupportedLegacyHtml(source.raw,`${bookId}:${sceneId}`);
    converted.document.layout=structuredClone(source.layout);
    converted.fidelity.convertedHash=hash(converted.document);
    return documentService.sideRecord(userId,bookId,async(tx)=>{
      const report={...converted.fidelity,sceneId,sourceBookRevision:source.sourceBookRevision,sourceSceneRevision:source.sourceSceneRevision}; const reportHash=hash(report);
      const previewId=compatibilityOperationId('proser.legacy-html.preview.v1',{bookId,userId,reportHash});
      const existing=await tx.documentImportPreview.findUnique({where:{id:previewId}});
      if(!existing)await tx.documentImportPreview.create({data:{id:previewId,originalId:source.originalId,bookId,userId,sourceBookRevision:source.sourceBookRevision,requestHash:hash({sceneId,sourceSceneRevision:source.sourceSceneRevision}),conversion:json({sceneId,sourceSceneRevision:source.sourceSceneRevision,document:converted.document}),report:json(report),reportHash}});
      return {previewId,originalId:source.originalId,report,reportHash,document:converted.document};
    });
  });
}
export async function commitLegacyHtmlScene(userId:number,bookId:number,previewId:string,input:{operationId:string;expectedRevisionId:string;consentReportHash:string}) {
  if(!input.operationId||!input.expectedRevisionId)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Expected book revision and operation ID are required.',428);
  return documentService.mutateCatalog(userId,bookId,{operationId:input.operationId,expectedRevisionId:input.expectedRevisionId,expectedScopes:{},payload:{command:'legacy-html-backfill',previewId,consentReportHash:input.consentReportHash}},async(tx)=>{
    const preview=await tx.documentImportPreview.findFirst({where:{id:previewId,bookId,userId}});
    if(!preview)throw new DocumentError('DOCUMENT_IMPORT_PREVIEW_MISSING','Owned conversion preview not found.',404);
    if(preview.reportHash!==input.consentReportHash||hash(preview.report)!==preview.reportHash)throw new DocumentError('DOCUMENT_IMPORT_CONSENT_REQUIRED','Explicit consent must match the exact preserved report.',409);
    if(preview.sourceBookRevision!==input.expectedRevisionId)throw new DocumentError('DOCUMENT_SOURCE_STALE','Source revision changed after HTML preview.',412);
    const conversion=preview.conversion as unknown as {sceneId:number;sourceSceneRevision:string;document:ProserDocument};
    const document=validateDocument(conversion.document);
    const report=preview.report as {sourceSha256:string;convertedHash:string};
    const original=await tx.documentImportOriginal.findFirst({where:{id:preview.originalId,bookId,userId,format:'legacy-html-v1'}});
    if(!original||createHash('sha256').update(original.bytes).digest('hex')!==report.sourceSha256||hash(document)!==report.convertedHash)throw new DocumentError('DOCUMENT_IMPORT_ORIGINAL_INVALID','Preserved conversion evidence is invalid.',503);
    const source=await tx.sceneDocumentRevision.findFirstOrThrow({where:{id:conversion.sourceSceneRevision,bookId,sceneId:conversion.sceneId}});
    if(Buffer.from(projectDocument(validateDocument(source.document)).text,'utf8').compare(Buffer.from(original.bytes))!==0)throw new DocumentError('DOCUMENT_SOURCE_STALE','HTML source does not match preserved bytes.',412);
    await tx.auditLog.create({data:{userId,entityType:'book',entityId:bookId,action:'update',metadata:{command:'legacy-html-loss-consent',previewId,originalId:original.id,reportHash:input.consentReportHash,operationId:input.operationId}}});
    return {result:{command:'legacy-html-backfill',sceneId:conversion.sceneId,originalId:original.id,previewId,reportHash:input.consentReportHash},changedDocuments:[{sceneId:conversion.sceneId,expectedRevisionId:conversion.sourceSceneRevision,document}]};
  });
}
