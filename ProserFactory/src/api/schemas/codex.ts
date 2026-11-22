import { z } from 'zod';
import { documentMutationPreconditionsSchema } from './documents';
import { positiveIntParam, requiredStr, optionalStr } from './shared';

export const codexIdParams = z.object({
  id: positiveIntParam('id'),
});

export const updateCodexBody = z.object({
  documentPreconditions: documentMutationPreconditionsSchema.optional(),
  entryType: z.enum(['character', 'location', 'lore', 'item', 'faction', 'event', 'rule', 'culture', 'relationship']).optional(),
  entryName: requiredStr('entryName', 1, 255).optional(),
  entryDescription: optionalStr('entryDescription', 5000),
  attributes: optionalStr('attributes', 50000),
  entry_type: z.enum(['character', 'location', 'lore', 'item', 'faction', 'event', 'rule', 'culture', 'relationship']).optional(),
  entry_name: requiredStr('entry_name', 1, 255).optional(),
  entry_description: optionalStr('entry_description', 5000),
  attributes_json: optionalStr('attributes_json', 50000),
}).passthrough();
