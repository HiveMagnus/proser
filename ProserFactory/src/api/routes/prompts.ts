import { Router, type Request, type Response } from 'express';
import { respondError, respondSuccess, ErrorCodes } from '../utils/response';
import {
  getPrompt,
  getPromptVisibility,
  listPrompts,
  getAdditionalTemplate,
  type AdditionalTemplateName,
} from '@/prompts/service';
import { authenticateRequest } from '../middleware/auth';
import crypto from 'node:crypto';

const router = Router();
const PROMPT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Lightweight helpers for ETag/Cache headers
function makeWeakEtag(payload: string): string {
  const hash = crypto.createHash('sha1').update(payload).digest('hex');
  return `W/"${hash}"`;
}

function setCachingHeaders(res: Response, etag: string) {
  res.set('ETag', etag);
  // Prompt policy is authenticated and must never enter shared caches.
  res.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=86400');
}

function maybeNotModified(req: Request, res: Response, etag: string): boolean {
  const inm = req.headers['if-none-match'];
  setCachingHeaders(res, etag);
  if (typeof inm === 'string' && inm === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

router.use(authenticateRequest);

// GET /api/prompts - list all prompts (read-only)
router.get('/', (req, res) => {
  const prompts = listPrompts();
  const etag = makeWeakEtag(JSON.stringify(prompts));
  if (maybeNotModified(req, res, etag)) return;
  return respondSuccess(res, { prompts });
});

// GET /api/prompts/additional/:name - get additional template string (read-only)
router.get('/additional/:name', (req, res) => {
  const name = req.params.name as string;
  const allowed = new Set([
    'CHAPTER_OUTLINE_TEMPLATE',
    'SCENE_OUTLINE_TEMPLATE',
    'SCENE_SUMMARY_TEMPLATE',
    'SHORT_SUMMARY_TEMPLATE',
  ]);
  if (!allowed.has(name)) {
    return respondError(res, ErrorCodes.NOT_FOUND, 'Template not found', 404);
  }
  const tpl = getAdditionalTemplate(name as AdditionalTemplateName);
  const etag = makeWeakEtag(`${name}:${String(tpl)}`);
  if (maybeNotModified(req, res, etag)) return;
  return respondSuccess(res, { name, template: tpl, visibility: 'internal' });
});

// GET /api/prompts/:key - get one prompt by key (read-only)
router.get('/:key', (req, res) => {
  const key = req.params.key;
  if (!PROMPT_KEY.test(key)) {
    return respondError(res, ErrorCodes.NOT_FOUND, 'Prompt not found', 404);
  }
  const prompt = getPrompt(key);
  if (!prompt) return respondError(res, ErrorCodes.NOT_FOUND, 'Prompt not found', 404);
  const etag = makeWeakEtag(`${key}:${String(prompt)}`);
  if (maybeNotModified(req, res, etag)) return;
  return respondSuccess(res, { key, prompt, visibility: getPromptVisibility(key) });
});

export default router;
