import {admitReleaseMutation} from '@/operations/releaseAdmission';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../core/config';
import { resolveForgeModel } from './forgeModel';
import logger from '../lib/logger';

// Use dynamic import for ky to avoid ESM issues under Jest/CommonJS
type KyModule = typeof import('ky');
async function getKy(): Promise<KyModule['default']> {
  const mod = await import('ky');
  return mod.default || mod;
}

export interface ImageGenerateParams {
  model?: string;
  transparent_background?: boolean;
  prompt: string;
  n?: number;
  size?: string; // e.g., "1024x1024"
  quality?: 'standard' | 'hd';
  response_format?: 'url' | 'b64_json';
  // Optional book context for ownership; when provided, saved filenames will start with `${bookId}_`
  bookId?: number;
}

export interface ImageGenerateResult {
  urls: string[];
  model: string;
  b64?: string[];
}

// Minimal WebUI Forge/text2img client
// Reference: Automatic1111/Forge API typically accepts /sdapi/v1/txt2img
export class ImageService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || CONFIG.WEBUI_FORGE_URL).replace(/\/$/, '');
  }

  private parseSize(size?: string): { width: number; height: number } {
    const fallback = { width: 1024, height: 1024 };
    if (!size) return fallback;
    const m = size.match(/^(\d+)x(\d+)$/);
    if (!m) return fallback;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fallback;
    // clamp to reasonable bounds
    return { width: Math.min(w, 2048), height: Math.min(h, 2048) };
  }

  async generate(params: ImageGenerateParams): Promise<ImageGenerateResult> {
    await admitReleaseMutation('provider','image-generation',params);
    const n = params.n && params.n > 0 ? Math.min(params.n, 4) : 1; // cap at 4
    const { width, height } = this.parseSize(params.size);
    const cfgScale = 2.5;
    const steps = CONFIG.FORGE_STEPS;
    const model = await resolveForgeModel(this.baseUrl, params.model || CONFIG.FORGE_MODEL);

    const payload: Record<string, unknown> = {
      prompt: params.transparent_background ? `This is an RGBA format image with transparency. ${params.prompt} The image has an alpha channel and a transparent background.` : params.prompt,
      batch_size: n,
      width,
      height,
      cfg_scale: cfgScale,
      steps,
      sampler_name: CONFIG.FORGE_SAMPLER,
      scheduler: CONFIG.FORGE_SCHEDULER,
      override_settings: { sd_model_checkpoint: model },
      override_settings_restore_afterwards: true,
    };

    const url = `${this.baseUrl}/sdapi/v1/txt2img`;
    let data: { images?: string[] };
    try {
      const ky = await getKy();
      // Qwen/Forge commonly needs more than a minute for a cold 1024px render.
      // Timing out early leaves Forge rendering an orphaned request and the
      // fallback submits duplicate work, which can exhaust VRAM.
      const configuredTimeout = Number(process.env.FORGE_GENERATION_TIMEOUT_MS ?? '300000');
      const client = ky.extend({ timeout: Number.isFinite(configuredTimeout) ? Math.max(60_000, Math.min(600_000, configuredTimeout)) : 300_000, throwHttpErrors: false });
      await admitReleaseMutation('provider','image-dispatch',{url:url,body:payload});
      const resp = await client.post(url, { json: payload });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json() as { images?: string[] };
    } catch (err) {
      const msg = (err as Error).message || '';
      logger.warn({ err: msg }, 'Qwen image generation failed; provider effect may be unknown');
      throw err;
    }
    const images = Array.isArray(data.images) ? data.images : [];
  if (!images.length) return { urls: [], b64: [], model };

    // Ensure output dir
    const outDir = path.resolve('public/images');
    fs.mkdirSync(outDir, { recursive: true });

    const urls: string[] = [];
    let idx = 0;
  for (const b64 of images) {
      if (typeof b64 !== 'string' || !b64.length) continue;
      const buf = Buffer.from(b64, 'base64');
      const prefix = (params.bookId && Number.isFinite(params.bookId)) ? `${Number(params.bookId)}_` : '';
      const name = `${prefix}img_${Date.now()}_${Math.random().toString(36).slice(2)}_${idx++}.png`;
      const filePath = path.join(outDir, name);
      fs.writeFileSync(filePath, buf);
  const url = `/images/${name}`;
  urls.push(url);
    }
  return { urls, b64: images, model };
  }

}

export const imageService = new ImageService();
