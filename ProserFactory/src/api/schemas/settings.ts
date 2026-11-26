import { z } from 'zod';
import { optionalStr } from './shared';

const updateSettingsSections = z.object({
  profile: z.object({
    displayName: optionalStr('displayName', 255),
  }).partial().optional(),
  writing: z.object({
    defaultGenre: optionalStr('defaultGenre', 100),
    writingStyle: optionalStr('writingStyle', 2000),
    targetAudience: optionalStr('targetAudience', 100),
  }).partial().optional(),
}).passthrough();

export const updateSettingsBody = updateSettingsSections.refine(
  (value) => Boolean(value.profile || value.writing),
  { message: 'At least one settings section must be provided.' },
);
