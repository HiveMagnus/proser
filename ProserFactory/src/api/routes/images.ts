/* eslint-disable no-restricted-globals */
import { Router } from 'express';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { ImagesController } from '../controllers/images';
import { FluxImagesController } from '../controllers/imagesFlux';
import { authenticateRequest } from '../middleware/auth';
import { zBody } from '../middleware/zodValidation';
import { generateImageBody, generateFluxBody } from '../schemas/images';
import { redisRateLimit } from '../middleware/redisRateLimit';
import { CONFIG } from '../../core/config';
import { databaseService, withDatabaseBusyRetry } from '../../lib/database';
import { defaultModelRouter } from '../../lib/ai/router';
import { withRetry } from '../../lib/resilience';
import { extractJson } from '../../cli/utils/extractJson';
import { respondSuccess } from '../utils/response';
import { NotFoundError } from '../../lib/errors';
import logger from '../../lib/logger';
import { creativeImageSchema, importCreativeImage } from '../../services/creativeImportService';
import { DocumentError } from '@/documents/service';
import { novaVisibleBookIds, novaVisibleResourceIds } from '../middleware/novaGrant';

/** Minimal shape of the Forge /config response we inspect. */
interface ForgeConfig {
  dependencies?: Array<{ api_name?: string }>;
}

const router = Router();

// Health probes through the authoring proxy and delegated Nova path are
// authenticated; the response never includes the configured Forge address.
router.use(authenticateRequest);

// Authenticated health endpoint to check Forge/SD API availability
router.get('/health', async (req, res) => {
  const base = CONFIG.WEBUI_FORGE_URL.replace(/\/$/, '');
  // We'll probe a few known endpoints; if any succeed, we consider it reachable
  const endpoints: Array<{ path: string; method: 'GET' }> = [
    { path: '/sdapi/v1/sd-models', method: 'GET' },
    { path: '/sdapi/v1/options', method: 'GET' },
    { path: '/config', method: 'GET' },
  ];
  const fetchJson = async (fullUrl: string) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(fullUrl, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) return { ok: false as const, status: r.status };
      let json: ForgeConfig | undefined = undefined;
      try { json = (await r.json()) as ForgeConfig; } catch {}
      return { ok: true as const, json };
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  };

  try {
    let reachable = false;
    let hasTxt2Img: boolean | undefined = undefined;
    let lastStatus = 0;
    for (const ep of endpoints) {
      try {
        const url = `${base}${ep.path}`;
        const resp = await fetchJson(url);
        if (resp.ok) {
          reachable = true;
          // If this is the /config endpoint, attempt to derive hasTxt2Img from dependencies
          if (ep.path === '/config') {
            const cfg = resp.json;
            if (cfg && Array.isArray(cfg.dependencies)) {
              hasTxt2Img = cfg.dependencies.some((d) => d?.api_name && String(d.api_name).startsWith('txt2img'));
            }
          }
          // If we hit a known SD API endpoint successfully, assume txt2img exists unless proven otherwise
          if (ep.path.startsWith('/sdapi/')) {
            if (typeof hasTxt2Img === 'undefined') hasTxt2Img = true;
          }
          // We can break early on first success that gives us enough signal
          if (typeof hasTxt2Img !== 'undefined') break;
        } else {
          lastStatus = resp.status || lastStatus;
        }
      } catch {
        // swallow and try next
      }
    }

    if (!reachable) {
      return res.status(502).json({ success: false, error: { code: 'FORGE_UNREACHABLE', message: `No Forge endpoint reachable at ${base}`, details: { tried: endpoints.map(e => e.path), status: lastStatus } } });
    }

    const status: 'ok' | 'warn' = hasTxt2Img === false ? 'warn' : 'ok';
    return res.json({ success: true, data: { status, forge: 'reachable', hasTxt2Img: hasTxt2Img !== false } });
  } catch (err) {
    return res.status(502).json({ success: false, error: { code: 'FORGE_UNREACHABLE', message: (err as Error).message } });
  }
});

router.post('/generate',
  redisRateLimit({ key: (req) => `img:${req.user?.id}:gen`, limit: 10, windowSec: 60 }),
  zBody(generateImageBody),
  ImagesController.generate
);

// Flux-specific generation endpoint
router.post('/generate/flux',
  redisRateLimit({ key: (req) => `img:${req.user?.id}:genflux`, limit: 10, windowSec: 60 }),
  zBody(generateFluxBody),
  FluxImagesController.generateFlux
);

// List only database-owned image assets. Untracked files are never exposed.
router.post('/import', zBody(creativeImageSchema), async (req, res) => {
  const asset = await importCreativeImage(req.user!.id, req.body, req.authActor?.githubId || req.user!.githubId, String(req.headers['x-nova-request'] || ''));
  return respondSuccess(res, { ...asset, url: `/api/images/${asset.id}/content` }, asset.replayed ? 200 : 201);
});

router.get('/list', async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const pageSize = req.query.pageSize === undefined ? 50 : Number(req.query.pageSize);
    const bookId = req.query.bookId === undefined ? undefined : Number(req.query.bookId);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200 ||
      (bookId !== undefined && (!Number.isSafeInteger(bookId) || bookId < 1))) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid image list query' } });
    }
    const userId = req.user!.id;
    if (bookId !== undefined) {
      const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId } });
      if (!book) throw new NotFoundError('Book not found');
    }
    const [visibleBooks, visibleImages] = await Promise.all([novaVisibleBookIds(req), novaVisibleResourceIds(req, 'image')]);
    const where = {
      userId,
      ...(bookId !== undefined ? { bookId } : {}),
      ...(visibleBooks ? { OR: [{ bookId: { in: visibleBooks } }, { id: { in: visibleImages ?? [] } }] } : {}),
    };
    const total = await databaseService.client.imageAsset.count({ where });
    const start = (page - 1) * pageSize;
    const rows = await databaseService.client.imageAsset.findMany({ where, orderBy: { createdAt: 'desc' }, skip: start, take: pageSize });
    const items = rows.map((row) => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.configJson ?? '{}') as Record<string, unknown>; } catch { /* Legacy assets may lack verified metadata. */ }
      const sha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256) ? metadata.sha256 : undefined;
      return { id: row.id, name: row.name, bookId: row.bookId, source: row.source, createdAt: row.createdAt, url: `/api/images/${row.id}/content`, ...(sha256 ? { sha256 } : {}), ...(typeof metadata.width === 'number' && typeof metadata.height === 'number' ? { width: metadata.width, height: metadata.height } : {}) };
    });
    return res.json({ success: true, data: { items, page, pageSize, total } });
});

router.get('/:id/content', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid image id' } });
  }
  const asset = await databaseService.client.imageAsset.findFirst({ where: { id, userId: req.user!.id } });
  if (!asset) throw new NotFoundError('Image not found');
  const imageRoot = path.resolve('public/images');
  const filePath = path.resolve(imageRoot, path.basename(asset.name));
  if (!filePath.startsWith(`${imageRoot}${path.sep}`)) throw new NotFoundError('Image not found');
  try { await fsp.access(filePath); } catch { throw new NotFoundError('Image content not found'); }
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(asset.configJson ?? '{}') as Record<string, unknown>; } catch { /* Retained legacy files may be unverified. */ }
  if (typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)) {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new DocumentError('DOCUMENT_ASSET_INTEGRITY', 'Stored image is not a bounded immutable file.', 503);
    const bytes = await fsp.readFile(filePath);
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new DocumentError('DOCUMENT_ASSET_INTEGRITY', 'Stored image checksum differs from its immutable reference.', 503);
    res.setHeader('X-Content-SHA256', metadata.sha256);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(asset.name)}"`);
    const mediaType = typeof metadata.mediaType === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(metadata.mediaType) ? metadata.mediaType : path.extname(asset.name).toLowerCase() === '.png' ? 'image/png' : path.extname(asset.name).toLowerCase() === '.webp' ? 'image/webp' : 'image/jpeg';
    return res.type(mediaType).send(bytes);
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(asset.name)}"`);
  return res.sendFile(filePath);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid image id' } });
  }
  const asset = await databaseService.client.imageAsset.findFirst({ where: { id, userId: req.user!.id } });
  if (!asset) throw new NotFoundError('Image not found');
  await withDatabaseBusyRetry(() => databaseService.client.$transaction(async (tx) => {
    // Serialize deletion with document insertion using the same owned book
    // lock, then recheck the asset to close the preflight/commit race.
    if (asset.bookId !== null) await tx.$queryRaw`SELECT id FROM books WHERE id=${asset.bookId} FOR UPDATE`;
    const current = await tx.imageAsset.findFirst({ where: { id, userId: req.user!.id } });
    if (!current || current.bookId !== asset.bookId) throw new NotFoundError('Image not found');
    // Immutable revisions survive capability deactivation and retain block,
    // inline, table and layout-story assets. Inspect all canonical containers.
    const referenced = await tx.$queryRaw<Array<{ referenced: boolean }>>`SELECT EXISTS(SELECT 1 FROM scene_document_revisions WHERE book_id=${asset.bookId} AND jsonb_path_exists(document,'$.** ? (@.assetId == $id)',jsonb_build_object('id',${id}::integer))) OR EXISTS(SELECT 1 FROM book_document_scope_revisions WHERE book_id=${asset.bookId} AND kind IN ('layout','structure') AND (jsonb_path_exists(content,'$.** ? (@.assetId == $id)',jsonb_build_object('id',${id}::integer)) OR jsonb_path_exists(content,'$.** ? (@.selectedImageId == $id)',jsonb_build_object('id',${id}::integer)))) OR EXISTS(SELECT 1 FROM books WHERE selected_image_id=${id}) OR EXISTS(SELECT 1 FROM acts WHERE selected_image_id=${id}) OR EXISTS(SELECT 1 FROM chapters WHERE selected_image_id=${id}) OR EXISTS(SELECT 1 FROM scenes WHERE selected_image_id=${id}) AS referenced`;
    if (referenced[0]?.referenced) throw new DocumentError('DOCUMENT_ASSET_REFERENCED', 'Preserved document revisions reference this immutable asset.', 409);
    await tx.imageAsset.delete({ where: { id } });
  }));
  // Retain bytes even for an unreferenced deleted ID. Other assets or imports
  // may share the filename; physical cleanup requires a separate reachability
  // sweep rather than a racy filesystem action in this request.
  return respondSuccess(res, { deleted: true });
});

// Suggest an image prompt using AI based on book/act/chapter/scene context
router.post('/suggest-prompt', authenticateRequest, async (req, res) => {
  const userId = req.user!.id;
  const { bookId, targetType, info } = req.body as {
    bookId?: number;
    targetType?: 'book' | 'act' | 'chapter' | 'scene';
    info?: Record<string, unknown>;
  };
  const bid = Number(bookId);
  if (!bid || Number.isNaN(bid)) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid bookId' } });
    return;
  }
  if (!targetType) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing targetType' } });
    return;
  }

  const book = await databaseService.client.book.findFirst({ where: { id: bid, userId } });
  if (!book) throw new NotFoundError('Book not found');

  const contextParts: string[] = [];
  contextParts.push('You are an expert prompt writer for Qwen Image 2.1. Produce a single, concise prompt in JSON format.');
  contextParts.push('Model target: Qwen Image 2.1. Emphasize cinematic, evocative composition. Avoid copyrighted character names.');
  const baseMeta: string[] = [];
  if (book.title) baseMeta.push(`Title: ${book.title}`);
  if (book.tagline) baseMeta.push(`Tagline: ${book.tagline}`);
  if (book.summary) baseMeta.push(`Summary: "${book.summary}"`);
  if (book.genre) baseMeta.push(`Genre: ${book.genre}`);
  if (book.targetAudience) baseMeta.push(`Audience: ${book.targetAudience}`);
  if (baseMeta.length) contextParts.push(baseMeta.join('\n'));

  const extra = (info && typeof info === 'object') ? info : {};
  switch (targetType) {
    case 'book':
      contextParts.push('Goal: a compelling book cover illustration reflecting the story.');
      break;
    case 'act':
      contextParts.push('Goal: an act header image capturing the act\'s main theme.');
      if (extra.actTitle) contextParts.push(`Act: ${String(extra.actTitle)}`);
      if (extra.actSummary) contextParts.push(`Act summary: "${String(extra.actSummary)}"`);
      break;
    case 'chapter':
      contextParts.push('Goal: a chapter header image that hints the chapter mood.');
      if (extra.chapterTitle) contextParts.push(`Chapter: ${String(extra.chapterTitle)}`);
      if (extra.chapterSummary) contextParts.push(`Chapter summary: "${String(extra.chapterSummary)}"`);
      break;
    case 'scene':
      contextParts.push('Goal: a scene illustration that evokes a specific moment.');
      if (extra.sceneTitle) contextParts.push(`Scene: ${String(extra.sceneTitle)}`);
      if (extra.sceneSummary) contextParts.push(`Scene summary: "${String(extra.sceneSummary)}"`);
      break;
  }

  contextParts.push('Include: subject, setting, mood, lighting, color palette, camera angle, detail.');
  contextParts.push('Avoid: text overlays, watermarks, copyrighted character likenesses.');
  contextParts.push('Return ONLY valid minified JSON with this schema: {"prompt":"..."}. Do not include any extra text, code fences, or commentary.');

  const sysPrompt = contextParts.join('\n');
  const provider = defaultModelRouter.choose('generic');
  const timeoutMs = Number(process.env.AI_TIMEOUT_PROSE_MS ?? '120000') || 120000;

  let promptText = '';

  // First attempt
  try {
    const raw = await withRetry(
      (signal) => provider.generateText({ prompt: sysPrompt, signal }),
      2,
      (attempt, err) => logger.warn({ attempt, err, bookId: bid }, 'suggest-prompt retry'),
      { timeoutMs, jitter: true },
    );
    const parsed = extractJson<{ prompt?: string; suggestion?: string }>(raw);
    if (parsed && typeof parsed === 'object') {
      const val = parsed.prompt || parsed.suggestion;
      if (typeof val === 'string' && val.trim()) promptText = val.trim();
    }
  } catch (err) {
    logger.warn({ err, bookId: bid }, 'suggest-prompt first attempt failed');
  }

  // Retry with stricter instruction
  if (!promptText) {
    try {
      const retryPrompt = sysPrompt + '\n\nReply EXACTLY with minified JSON: {"prompt":"..."} and nothing else.';
      const raw = await withRetry(
        (signal) => provider.generateText({ prompt: retryPrompt, signal }),
        1,
        () => {},
        { timeoutMs, jitter: true },
      );
      const parsed = extractJson<{ prompt?: string; suggestion?: string }>(raw);
      if (parsed && typeof parsed === 'object') {
        const val = parsed.prompt || parsed.suggestion;
        if (typeof val === 'string' && val.trim()) promptText = val.trim();
      }
    } catch {
      // swallow retry error; we'll fall back below
    }
  }

  // Fallback: build from available context
  if (!promptText) {
    const bits: string[] = [];
    if (book.title) bits.push(`Cover for "${book.title}"`);
    if (book.tagline) bits.push(book.tagline);
    if (book.genre) bits.push(`Genre: ${book.genre}`);
    if (book.summary) bits.push(`Premise: ${book.summary}`);
    switch (targetType) {
      case 'book': bits.push('Cinematic book cover, richly detailed'); break;
      case 'act': bits.push('Act header artwork, thematic composition'); break;
      case 'chapter': bits.push('Chapter header artwork, evocative mood'); break;
      case 'scene': bits.push('Dramatic scene illustration, vivid moment'); break;
    }
    bits.push('Rich illustration, volumetric lighting, high detail, 35mm photograph, artstation, trending');
    promptText = bits.join(', ');
  }

  // Strip stray surrounding quotes
  promptText = promptText.replace(/^\s*"|"\s*$/g, '').trim();
  respondSuccess(res, { prompt: promptText, suggestion: promptText });
});

export default router;
