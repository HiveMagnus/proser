import { z } from 'zod';
import { requiredStr, optionalStr, optionalInt, optionalFloat } from './shared';

// --- Forge image generation ---

export const generateImageBody = z.object({
  transparent_background: z.boolean().optional(),
  prompt: requiredStr('prompt', 1, 2000),
  model: optionalStr('model', 100),
  n: optionalInt('n', 1, 4),
  size: optionalStr('size', 20),
  quality: optionalStr('quality', 10),
  response_format: optionalStr('response_format', 10),
  bookId: optionalInt('bookId', 1, Number.MAX_SAFE_INTEGER),
}).passthrough();

// --- Flux image generation ---

export const generateFluxBody = z.object({
  transparent_background: z.boolean().optional(),
  prompt: requiredStr('prompt', 1, 4000),
  n: optionalInt('n', 1, 4),
  width: optionalInt('width', 64, 2048),
  height: optionalInt('height', 64, 2048),
  steps: optionalInt('steps', 1, 100),
  seed: optionalInt('seed', -1, Number.MAX_SAFE_INTEGER),
  cfg_scale: optionalFloat('cfg_scale', 0, 50),
  distilled_cfg_scale: optionalFloat('distilled_cfg_scale', 0, 50),
  sampler_name: optionalStr('sampler_name', 50),
  scheduler: optionalStr('scheduler', 50),
  model: optionalStr('model', 200),
  response_format: optionalStr('response_format', 10),
  bookId: optionalInt('bookId', 1, Number.MAX_SAFE_INTEGER),
}).passthrough();
