import {z} from 'zod';
import {finalPassageSourceFrameSchema} from './passageOperationCommits';
import {documentPassageRestoreSchema} from './passageValidation';
const documentPassageRequestSchema=documentPassageRestoreSchema.pick({cursor:true,maxCharacters:true,maxParagraphs:true,maxRuns:true,reviewOffset:true}).extend({bookRevisionId:z.string().uuid().optional(),projection:z.literal('final').optional()}).strict();
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const paragraph=z.object({blockId:id,paragraphHash:hash,containerHash:hash}).strict();
const run=paragraph.extend({runId:id,sourceHash:hash,from:z.number().int().nonnegative(),to:z.number().int().nonnegative()}).strict();
export const passageScopeSourceSchema=z.object({sceneId:z.number().int().positive(),expectedSceneRevisionId:z.string().uuid(),sourceFrame:finalPassageSourceFrameSchema,windowHash:hash,window:documentPassageRequestSchema}).strict();
const base=z.object({schemaVersion:z.literal(1),operationId:z.string().uuid(),expectedRevisionId:z.string().uuid(),source:passageScopeSourceSchema,destination:passageScopeSourceSchema});
export const passageScopeTransferSchema=z.union([
 base.extend({kind:z.literal('move-blocks'),blocks:z.array(z.object({blockId:id,sourceHash:hash}).strict()).min(1).max(256),placement:z.enum(['start','end'])}).strict(),
 base.extend({kind:z.literal('split-scene'),target:run,expectedText:z.literal('')}).strict(),
 base.extend({kind:z.literal('join-scenes'),left:paragraph,right:paragraph,boundaryHash:hash,tracking:z.boolean().optional()}).strict(),
]);
export const passageScopeRestoreSchema=z.object({schemaVersion:z.literal(1),operationId:z.string().uuid(),expectedRevisionId:z.string().uuid(),restoreFromBookRevisionId:z.string().uuid(),scenes:z.array(passageScopeSourceSchema).min(2).max(8)}).strict();
