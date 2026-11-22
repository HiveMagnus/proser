import type {Router} from 'express';
import {z} from 'zod';
import {zBody,zParams} from '@/api/middleware/zodValidation';
import {ownedBookBudget} from '@/api/middleware/ownedBookBudget';
import {respondSuccess} from '@/api/utils/response';
import {documentAuthorityEnabled} from '@/documents/capabilities';
import {DocumentError} from '@/documents/errors';
import {passageScopeTransferSchema,passageScopeRestoreSchema} from '@/documents/scopePassageValidation';
import {transferPassageScopes,restorePassageScopes} from '@/documents/scopePassageTransfers';
export function registerScopeDocumentPassageRoutes(router:Router){
 const params=z.object({bookId:z.coerce.number().int().positive()});
 const guard=(req:import('express').Request,_res:import('express').Response,next:import('express').NextFunction)=>{
  if(!documentAuthorityEnabled())throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE','Structured document migration is not active.',503);
  if(!req.body?.operationId||!req.body?.expectedRevisionId)throw new DocumentError('DOCUMENT_PRECONDITION_REQUIRED','Book revision and operation preconditions are required.',428);next();
 };
 router.post('/:bookId/document-passage-transfers',zParams(params),ownedBookBudget({source:'params',required:true}),guard,zBody(passageScopeTransferSchema),async(req,res)=>respondSuccess(res,await transferPassageScopes(req.user!.id,Number(req.params.bookId),req.body)));
 router.post('/:bookId/document-passage-scope-restores',zParams(params),ownedBookBudget({source:'params',required:true}),guard,zBody(passageScopeRestoreSchema),async(req,res)=>respondSuccess(res,await restorePassageScopes(req.user!.id,Number(req.params.bookId),req.body)));
}
