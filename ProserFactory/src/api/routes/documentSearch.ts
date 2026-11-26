import type {Router} from 'express';
import {databaseService} from '@/lib/database';
import {backfillSceneSearchIndexes} from '@/documents/searchIndex';
import {documentService} from '@/documents/service';
import {zBody,zParams} from '../middleware/zodValidation';
import {ownedBookBudget} from '../middleware/ownedBookBudget';
import {respondSuccess} from '../utils/response';
import {documentBookParams} from '../schemas/documents';
import {documentSearchQuery,documentSearchIndexRecoverySchema,documentReplaceApplySchema,documentReplacePreviewSchema} from '@/documents/searchValidation';
import {searchOwnedDocument} from '@/documents/search';
import {applyBookReplace,previewBookReplace} from '@/documents/replace';
import {documentAuthorityEnabled,DocumentError} from '@/documents/service';
export function registerDocumentSearchRoutes(router:Router){
 router.post('/:bookId/document-search-index/recover',zParams(documentBookParams),ownedBookBudget({source:'params',required:true}),async(req,res)=>{
  if(!documentAuthorityEnabled())throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE','Structured manuscript indexing is inactive.',503);
  const body=documentSearchIndexRecoverySchema.parse(req.body);const bookId=Number(req.params.bookId);
  await documentService.manifest(req.user!.id,bookId);res.setHeader('Cache-Control','private, no-store');
  respondSuccess(res,await databaseService.client.$transaction((tx)=>backfillSceneSearchIndexes(tx,bookId,{...body,apply:true}),{timeout:30000}));
 });
 router.get('/:bookId/document-search',zParams(documentBookParams),ownedBookBudget({source:'params',required:true}),async(req,res)=>{
  if(!documentAuthorityEnabled())throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE','Structured manuscript search is inactive.',503);
  const query=documentSearchQuery.parse(req.query);res.setHeader('Cache-Control','private, no-store');respondSuccess(res,await searchOwnedDocument(req.user!.id,Number(req.params.bookId),query));
 });
 router.post('/:bookId/document-replace/preview',zParams(documentBookParams),zBody(documentReplacePreviewSchema),ownedBookBudget({source:'params',required:true}),async(req,res)=>{
  if(!documentAuthorityEnabled())throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE','Structured manuscript replace is inactive.',503);
  res.setHeader('Cache-Control','private, no-store');respondSuccess(res,await previewBookReplace(req.user!.id,Number(req.params.bookId),req.body));
 });
 router.post('/:bookId/document-replace',zParams(documentBookParams),zBody(documentReplaceApplySchema),ownedBookBudget({source:'params',required:true}),async(req,res)=>{
  if(!documentAuthorityEnabled())throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE','Structured manuscript replace is inactive.',503);
  res.setHeader('Cache-Control','private, no-store');respondSuccess(res,await applyBookReplace(req.user!.id,Number(req.params.bookId),req.body));
 });
}
