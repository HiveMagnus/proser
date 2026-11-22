import type { Router } from 'express';
import { z } from 'zod';
import { zBody,zParams } from '@/api/middleware/zodValidation';
import { respondSuccess } from '@/api/utils/response';
import { documentAuthorityEnabled,documentService } from '@/documents/service';
import { DocumentError } from '@/documents/errors';
import { canonicalDocument } from '@/documents/model';
import { readOperatorEffect,cancelOperatorEffect } from '@/documents/operatorEffects';
import { createHash } from 'node:crypto';
export function registerDocumentOperatorEffectRoutes(router:Router){
 const params=z.object({bookId:z.coerce.number().int().positive()});const operationParams=params.extend({operationId:z.string().uuid()});
 router.use('/:bookId/document-operator-effects',(_req,_res,next)=>{if(!documentAuthorityEnabled())throw new DocumentError('DOCUMENT_AUTHORITY_INACTIVE','Document authority is not active.',503);next();});
 router.get('/:bookId/document-operator-effects',zParams(params),async(req,res)=>{
  const userId=req.user!.id;const bookId=Number(req.params.bookId);const query=z.object({cursor:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);
  const result=await documentService.sideRecord(userId,bookId,async(tx)=>{
   const cursor=query.cursor?await tx.documentOperatorEffect.findFirst({where:{id:query.cursor,userId,bookId},select:{createdAt:true,id:true}}):null;if(query.cursor&&!cursor)throw new DocumentError('DOCUMENT_OPERATOR_EFFECT_NOT_FOUND','Owned effect cursor not found.',404);
   const rows=await tx.documentOperatorEffect.findMany({where:{userId,bookId,...(cursor?{OR:[{createdAt:{gt:cursor.createdAt}},{createdAt:cursor.createdAt,id:{gt:cursor.id}}]}:{})},orderBy:[{createdAt:'asc'},{id:'asc'}],take:query.limit+1,select:{id:true,sceneId:true,kind:true,status:true,sourceBookRevision:true,sourceContentHash:true,errorCode:true,createdAt:true,startedAt:true,completedAt:true}});
   return {operations:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null};
  });res.setHeader('Cache-Control','private, no-store');respondSuccess(res,result);
 });
 router.get('/:bookId/document-operator-effects/:operationId',zParams(operationParams),async(req,res)=>{
  const query=z.object({view:z.enum(['status','request','result']).default('status'),offset:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1024).max(32768).default(16384)}).parse(req.query);
  const row=await readOperatorEffect(req.user!.id,Number(req.params.bookId),String(req.params.operationId));const {request,result,...status}=row;res.setHeader('Cache-Control','private, no-store');
  if(query.view==='status'){respondSuccess(res,status);return;}
  const serialized=canonicalDocument(query.view==='request'?request:result);respondSuccess(res,{operationId:row.id,view:query.view,encoding:'json-utf16',offset:query.offset,total:serialized.length,sha256:createHash('sha256').update(serialized).digest('hex'),content:serialized.slice(query.offset,query.offset+query.limit),nextOffset:query.offset+query.limit<serialized.length?query.offset+query.limit:null});
 });
 router.post('/:bookId/document-operator-effects/:operationId/cancel',zParams(operationParams),zBody(z.object({}).strict()),async(req,res)=>{respondSuccess(res,await cancelOperatorEffect(req.user!.id,Number(req.params.bookId),String(req.params.operationId)));});
}
