import { Response } from 'express';
import { CONFIG } from '../../core/config';
import { AuthenticatedRequest } from '../types';
import { fluxImageService } from '../../services/fluxImageService';
import { imageAssetService } from '../../services/imageAssetService';
import { AuthenticationError, ValidationError } from '../../lib/errors';
import { respondSuccess } from '../utils/response';
import { databaseService } from '../../lib/database';
import { NotFoundError } from '../../lib/errors';

export class FluxImagesController {
  static async generateFlux(req: AuthenticatedRequest, res: Response) {
    if (!req.user?.id) throw new AuthenticationError('Unauthorized');
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') throw new ValidationError('prompt is required');

    const {
      n = 1, width = 1024, height = 1024, steps = CONFIG.FORGE_STEPS, seed = -1,
      cfg_scale, distilled_cfg_scale, sampler_name, scheduler,
      model = CONFIG.FORGE_MODEL, response_format = 'url'
    } = req.body || {};

    const bookId = req.body && Number.isFinite(Number(req.body.bookId)) ? Number(req.body.bookId) : undefined;
    if (bookId) {
      const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId: req.user.id } });
      if (!book) throw new NotFoundError('Book not found');
    }

    const result = await fluxImageService.generate({
      prompt, n: Number(n), width: Number(width), height: Number(height),
      steps: steps === undefined ? undefined : Number(steps), seed: Number(seed),
      cfg_scale: typeof cfg_scale === 'number' ? cfg_scale : undefined,
      distilled_cfg_scale: typeof distilled_cfg_scale === 'number' ? distilled_cfg_scale : undefined,
      sampler_name: sampler_name ? String(sampler_name) : undefined,
      scheduler: scheduler ? String(scheduler) : undefined,
      model: model === undefined ? undefined : String(model), response_format,
      transparent_background: req.body.transparent_background, bookId
    });

    const safeConfig: Record<string, unknown> = { ...req.body, model: result.model, steps, cfg_scale: cfg_scale ?? 2.5, sampler_name: sampler_name ?? CONFIG.FORGE_SAMPLER, scheduler: scheduler ?? CONFIG.FORGE_SCHEDULER };
    delete safeConfig.response_format;
    const assets = await imageAssetService.persistAssets({
      userId: req.user.id,
      bookId,
      urls: result.urls || [],
      source: 'flux',
      config: safeConfig,
    });

    const data = (response_format === 'b64_json')
      ? (result.b64 || []).slice(0, n).map((b64) => ({ b64_json: b64 }))
      : assets.slice(0, n).map((asset) => ({ url: `/api/images/${asset.id}/content` }));
    const protectedAssets = assets.slice(0, n).map((asset) => ({
      id: String(asset.id),
      url: `/api/images/${asset.id}/content`,
      prompt,
    }));

    return respondSuccess(res, {
      created: Date.now(),
      data,
      urls: protectedAssets.map((asset) => asset.url),
      assets: protectedAssets,
    });
  }
}
