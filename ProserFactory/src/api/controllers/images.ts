import { Response } from 'express';
import { CONFIG } from '../../core/config';
import { AuthenticatedRequest } from '../types';
import { imageService } from '../../services/imageService';
import { imageAssetService } from '../../services/imageAssetService';
import { AuthenticationError, ValidationError } from '../../lib/errors';
import { respondSuccess } from '../utils/response';
import { databaseService } from '../../lib/database';
import { NotFoundError } from '../../lib/errors';

export class ImagesController {
  static async generate(req: AuthenticatedRequest, res: Response) {
    if (!req.user?.id) throw new AuthenticationError('Unauthorized');
    const { model = CONFIG.FORGE_MODEL, prompt, n = 1, size = '1024x1024', quality = 'standard', response_format = 'url', bookId } = req.body || {};
    if (!prompt || typeof prompt !== 'string') throw new ValidationError('prompt is required');
    const ownedBookId = Number.isFinite(Number(bookId)) ? Number(bookId) : undefined;
    if (ownedBookId) {
      const book = await databaseService.client.book.findFirst({ where: { id: ownedBookId, userId: req.user.id } });
      if (!book) throw new NotFoundError('Book not found');
    }
    const result = await imageService.generate({ model, prompt, n: Number(n), size: String(size), quality, response_format, transparent_background: req.body.transparent_background, bookId: ownedBookId });

    const assets = await imageAssetService.persistAssets({
      userId: req.user.id,
      bookId: ownedBookId,
      urls: result.urls || [],
      source: 'forge',
      config: { model: result.model, prompt, n: Number(n), size: String(size), quality, bookId: ownedBookId },
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
