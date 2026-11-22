import {z} from 'zod';
export const documentSearchQuery=z.object({
 q:z.string().min(1).max(512),caseSensitive:z.enum(['0','1','false','true']).default('false').transform((value)=>value==='1'||value==='true'),
 limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().min(1).max(2048).optional(),
}).strict();

export const documentSearchIndexRecoverySchema=z.object({after:z.string().uuid().optional(),limit:z.number().int().min(1).max(32).default(8)}).strict();
