import {admitReleaseMutation} from '@/operations/releaseAdmission';
import fs from 'fs';
import path from 'path';
import logger from '../lib/logger';
import { CONFIG } from '../core/config';
import { resolveForgeModel } from './forgeModel';
// Use dynamic import for ky to avoid ESM issues under Jest/CommonJS
type KyModule = typeof import('ky');
async function getKy(): Promise<KyModule['default']> {
  const mod = await import('ky');
  return mod.default || mod;
}

export interface FluxGenerateParams {
  prompt: string;
  n?: number;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  cfg_scale?: number; // classifier-free guidance
  distilled_cfg_scale?: number; // Flux specific
  sampler_name?: string; // e.g., "euler", "dpmpp_2m_sde"
  scheduler?: string; // e.g., "karras"
  transparent_background?: boolean;
  model?: string; // e.g., "flux1-dev.safetensors" or checkpoint name in Forge
  response_format?: 'url' | 'b64_json';
  // Optional book context for ownership; when provided, saved filenames will start with `${bookId}_`
  bookId?: number;
}

export interface FluxGenerateResult {
  urls: string[];
  model: string;
  b64?: string[];
}

export class FluxImageService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
  this.baseUrl = (baseUrl || CONFIG.WEBUI_FORGE_URL).replace(/\/$/, '');
  }

  private clampSize(value: number | undefined, min: number, max: number, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    const v = Number(value);
    return Math.max(min, Math.min(max, v));
  }

  async generate(params: FluxGenerateParams): Promise<FluxGenerateResult> {
    await admitReleaseMutation('provider','image-generation',params);
    const n = params.n && params.n > 0 ? Math.min(params.n, 4) : 1;
    const width = this.clampSize(params.width, 64, 2048, 1024);
    const height = this.clampSize(params.height, 64, 2048, 1024);
    const steps = this.clampSize(params.steps, 1, 100, CONFIG.FORGE_STEPS);
    const cfgScale = typeof params.cfg_scale === 'number' ? params.cfg_scale : 2.5;
  const distilledCfg = typeof params.distilled_cfg_scale === 'number' ? params.distilled_cfg_scale : undefined; // only include if explicitly set
  const sampler = params.sampler_name || CONFIG.FORGE_SAMPLER;
  const scheduler = params.scheduler || CONFIG.FORGE_SCHEDULER;
    const seed = typeof params.seed === 'number' ? params.seed : -1;

    // Set model checkpoint if provided
    const model = await resolveForgeModel(this.baseUrl, params.model || CONFIG.FORGE_MODEL);
    // Select the checkpoint per request without mutating the shared owner defaults.

    const payload: Record<string, unknown> = {
      prompt: params.transparent_background ? `This is an RGBA format image with transparency. ${params.prompt} The image has an alpha channel and a transparent background.` : params.prompt,
      batch_size: n,
      width,
      height,
      steps,
      cfg_scale: cfgScale,
      seed,
      // Ensure model per-request in case global option didn’t take effect
      override_settings: { sd_model_checkpoint: model },
      override_settings_restore_afterwards: true
    };
    if (typeof distilledCfg === 'number') payload['distilled_cfg_scale'] = distilledCfg;
    if (sampler) payload['sampler_name'] = sampler;
    if (scheduler) payload['scheduler'] = scheduler;

  const url = `${this.baseUrl}/sdapi/v1/txt2img`;
  let data: { images?: string[] } | undefined;
    try {
  const ky = await getKy();
  const client = ky.extend({ timeout: 600_000, throwHttpErrors: false });
      await admitReleaseMutation('provider','image-dispatch',{url:url,body:payload});
      const resp = await client.post(url, { json: payload });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json() as { images?: string[] };
    } catch (err) {
      const msg = (err as Error).message || '';
      logger.warn({ err: msg }, 'Qwen image generation failed; provider effect may be unknown');
      throw err;
    }
    const images = Array.isArray(data?.images) ? data!.images! : [];
    if (!images.length) return { urls: [], b64: [], model };

    const outDir = path.resolve('public/images');
    fs.mkdirSync(outDir, { recursive: true });

    const urls: string[] = [];
    let idx = 0;
    for (const raw of images) {
      if (typeof raw !== 'string' || !raw.length) continue;
      // Normalize base64: strip data URL prefix if present (allow newlines) and convert base64url to base64 with padding
      let s = raw.trim();
      const m = s.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+\/_=\-\n\r]+)$/i);
      if (m) s = m[2];
      // Convert base64url characters to standard base64
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4; if (pad) s = s + '='.repeat(4 - pad);
      let buf: Buffer;
      try { buf = Buffer.from(s, 'base64'); } catch { continue; }
      if (!buf || buf.length < 12) continue;
      // Detect format by magic numbers
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      const isJpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      const isWebp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
      const ext = isPng ? 'png' : isJpg ? 'jpg' : isWebp ? 'webp' : 'png';
      // Suspiciously small PNG detection: 512x512+ images should rarely be < 10KB unless blank
      if (isPng && buf.length < 10_000) {
        // Try to inspect IHDR to log dimensions
        try {
          const w = (buf[16]<<24)|(buf[17]<<16)|(buf[18]<<8)|buf[19];
          const h = (buf[20]<<24)|(buf[21]<<16)|(buf[22]<<8)|buf[23];
          logger.warn({ size: buf.length, w, h }, 'Flux PNG suspiciously small; possible blank output');
        } catch {}
      }
      const prefix = (params.bookId && Number.isFinite(params.bookId)) ? `${Number(params.bookId)}_` : '';
      const name = `${prefix}img_${Date.now()}_${Math.random().toString(36).slice(2)}_${idx++}.${ext}`;
      const filePath = path.join(outDir, name);
      fs.writeFileSync(filePath, buf, { flag: 'w' });
      urls.push(`/images/${name}`);
    }
    return { urls, b64: images, model };
  }

}

export const fluxImageService = new FluxImageService();
