import {z} from 'zod';
export const documentSearchQuery=z.object({
 q:z.string().min(1).max(512),caseSensitive:z.enum(['0','1','false','true']).default('false').transform((value)=>value==='1'||value==='true'),
 limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().min(1).max(2048).optional(),
}).strict();

export const documentSearchIndexRecoverySchema=z.object({after:z.string().uuid().optional(),limit:z.number().int().min(1).max(32).default(8)}).strict();

const replaceQuery={q:z.string().min(1).max(512),replacement:z.string().max(4096),caseSensitive:z.boolean().default(false)};
export const documentReplacePreviewSchema=z.object(replaceQuery).strict();
export const documentReplaceApplySchema=z.object({
 schemaVersion:z.literal(1),operationId:z.string().uuid(),expectedRevisionId:z.string().uuid(),...replaceQuery,
 matches:z.array(z.object({sceneId:z.number().int().positive(),sceneRevisionId:z.string().uuid(),from:z.number().int().nonnegative(),to:z.number().int().positive()}).strict()).min(1).max(1000),
}).strict();
