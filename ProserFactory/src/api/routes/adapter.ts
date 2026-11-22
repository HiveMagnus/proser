/**
 * Adapter management routes — admin endpoints for loading/unloading
 * LoRA adapters in the active inference backend at runtime.
 *
 * All routes are protected by INTERNAL_API_SECRET (X-Internal-Secret header).
 * Used by ops scripts and local administration.
 */

import { Router, Response } from 'express';
import { authenticateInternal } from '../middleware/auth';
import { respondSuccess, respondError, ErrorCodes } from '../utils/response';
import { vllmService } from '../../lib/ai/vllm';
import logger from '../../lib/logger';

const router = Router();

// All adapter routes require internal secret
router.use(authenticateInternal);

/**
 * GET /api/admin/adapter/status
 *
 * Returns the currently active adapter.
 */
router.get('/status', async (_req, res: Response): Promise<void> => {
  try {
    const activeAdapter = vllmService.getActiveAdapterName();
    respondSuccess(res, {
      activeAdapter,
      baseModel: vllmService.getModel(),
      effectiveModel: activeAdapter
        ? `${vllmService.getModel()}:${activeAdapter}`
        : vllmService.getModel(),
      adapterRuntimeSupported: vllmService.supportsDynamicAdapters(),
      promotedAdapters: [],
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get adapter status');
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve adapter status', 500);
  }
});

/**
 * POST /api/admin/adapter/activate
 *
 * Body: { name: string; path?: string }
 *
 * Activates a named adapter from a local filesystem path.
 */
router.post('/activate', async (req, res: Response): Promise<void> => {
  try {
    if (!vllmService.supportsDynamicAdapters()) {
      respondError(res, ErrorCodes.VALIDATION_FAILED, 'Dynamic adapters are unavailable when llama.cpp or Ollama is the active inference backend', 400);
      return;
    }

    const { name, path: adapterPath } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      respondError(res, ErrorCodes.VALIDATION_FAILED, 'name is required', 400);
      return;
    }

    if (!adapterPath || typeof adapterPath !== 'string') {
      respondError(res, ErrorCodes.VALIDATION_FAILED, 'path is required in standalone mode', 400);
      return;
    }

    const ok = await vllmService.activateAdapter(name, adapterPath);
    if (!ok) {
      respondError(res, ErrorCodes.INTERNAL_ERROR, `Failed to load adapter "${name}" in the active inference backend`, 500);
      return;
    }

    logger.info({ name, path: adapterPath }, 'Adapter activated via API');
    respondSuccess(res, { activated: name, path: adapterPath });
  } catch (error) {
    logger.error({ error }, 'Failed to activate adapter');
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to activate adapter', 500);
  }
});

/**
 * POST /api/admin/adapter/deactivate
 *
 * Unloads the currently active adapter.
 */
router.post('/deactivate', async (_req, res: Response): Promise<void> => {
  try {
    if (!vllmService.supportsDynamicAdapters()) {
      respondError(res, ErrorCodes.VALIDATION_FAILED, 'Dynamic adapters are unavailable when llama.cpp or Ollama is the active inference backend', 400);
      return;
    }

    const name = vllmService.getActiveAdapterName();
    if (!name) {
      respondSuccess(res, { deactivated: null, message: 'No adapter was active' });
      return;
    }

    const ok = await vllmService.deactivateAdapter();
    if (!ok) {
      respondError(res, ErrorCodes.INTERNAL_ERROR, `Failed to unload adapter "${name}" from the active inference backend`, 500);
      return;
    }

    logger.info({ name }, 'Adapter deactivated via API');
    respondSuccess(res, { deactivated: name });
  } catch (error) {
    logger.error({ error }, 'Failed to deactivate adapter');
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to deactivate adapter', 500);
  }
});

/**
 * POST /api/admin/adapter/refresh-registry
 *
 * Compatibility endpoint retained for older admin clients.
 */
router.post('/refresh-registry', async (_req, res: Response): Promise<void> => {
  respondSuccess(res, { count: 0, adapters: [], message: 'No external adapter registry is configured in standalone mode.' });
});

export default router;
