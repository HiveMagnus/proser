import { z } from 'zod';
import { positiveIntParam } from './shared';

export const chapterIdParams = z.object({
  chapterId: positiveIntParam('chapterId'),
});

export const sceneIdParams = z.object({
  sceneId: positiveIntParam('sceneId'),
});

export const applyFeedbackBody = z.object({
  recommendations: z.array(z.string().max(50_000)).optional(),
}).passthrough();
