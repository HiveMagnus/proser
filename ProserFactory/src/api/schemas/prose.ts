import { z } from 'zod';
import { positiveIntParam, requiredStr, optionalStr } from './shared';

export const traceIdParams = z.object({
  traceId: requiredStr('traceId', 1, 255),
});

export const prosePreferenceBody = z.object({
  traceId: requiredStr('traceId', 1, 255),
  compareCardId: z.number({ error: 'compareCardId is required' }).int().min(1),
  chosen: z.enum(['a', 'b'], { error: 'chosen is required' }),
  applyChosen: z.boolean().default(false),
  rationale: optionalStr('rationale', 4000),
  operationId: z.string().uuid().optional(),
  expectedRevisionId: z.string().uuid().optional(),
  expectedSceneRevisionId: z.string().uuid().optional(),
  validationId: z.string().uuid().optional(),
}).passthrough();

export const dismissFindingParams = z.object({
  traceId: requiredStr('traceId', 1, 255),
  findingId: positiveIntParam('findingId'),
});
