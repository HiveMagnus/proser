import {releaseAdmissionMiddleware} from '@/operations/releaseAdmission';
import booksRouter from './routes/books';
import promptsRouter from './routes/prompts';
import { Router } from 'express';
import generateRouter from './routes/generate';
import imagesRouter from './routes/images';
import metricsRouter from './routes/metrics';
import modelsRouter, { adminModelsRouter } from './routes/models';
import codexRouter from './routes/codex';
import authRouter from './routes/auth';
import adapterRouter from './routes/adapter';
import proseRouter from './routes/prose';
import settingsRouter from './routes/settings';
import plotRouter from './routes/plot';
import workflowsRouter, { workflowBookRouter, workflowReviewRouter, workflowFindingRouter } from './routes/workflows';
import swaggerUi from 'swagger-ui-express';
import { getSummary, getTimings } from '../lib/metrics';
import { getInferenceOutcomeCounts } from '../metrics/inference';
import { getGenerationOperationMetrics } from '../metrics/generationOperations';
import { databaseService } from '../lib/database';
import redis from '../lib/redis';
import { CONFIG, PROSER_VERSION } from '../core/config';
import { openApiSpec } from './docs/openapi';
import { aiRequestQueue } from '../lib/ai/requestQueue';
import editorialRouter, { editorialBookRouter } from './routes/editorial';
import sharedResourceOperationsRouter from './routes/sharedResourceOperations';
import { validatePassRegistry } from '../services/editorial/passRegistry';
import { cachedCorpusValidation } from '../services/editorial/qualityLab/corpusLoader';
import { editorialMetricsSnapshot } from '../services/editorial/metrics';
import { requireMetricsToken } from './middleware/metricsAuth';
import { publicReadinessView } from './readinessView';
import { workersReady } from '@/workers/heartbeat';
import { isBullmqEnabled } from '@/queues/featureFlag';
import { documentRuntimeReadiness } from '@/documents/runtimeReadiness';
import { resolveServicePrincipal } from './middleware/servicePrincipal';
import { NovaGrantError, registerNovaBookReadGrant, registerNovaCapabilitiesGrant, registerNovaGenerationReadGrant, registerNovaGenerationCreateGrant, registerNovaWorkflowPublishGrant, registerNovaWorkflowReadGrant } from './middleware/novaGrant';

const router = Router();
router.use(releaseAdmissionMiddleware);

// API version and basic info
router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      service: 'Proser Backend API',
      version: PROSER_VERSION,
      revision: CONFIG.GIT_COMMIT || CONFIG.COMMIT_SHA || null,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      endpoints: {
        books: '/api/books',
        generate: '/api/generate',
        images: '/api/images',
        workflows: '/api/workflows',
        models: '/api/models',
        auth: '/api/auth',
        codex: '/api/codex'
      }
    }
  });
});

// Docs
router.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
// Raw JSON spec
router.get('/docs.json', (req, res) => { res.json(openApiSpec); });

router.get('/metrics', requireMetricsToken, async (_req, res) => {
  res.json({ success: true, data: {
    summary: getSummary(),
    recent: getTimings(50),
    ai: aiRequestQueue.stats,
    inferenceOutcomes: getInferenceOutcomeCounts(),
    generationOperations: getGenerationOperationMetrics(),
    editorial: await editorialMetricsSnapshot(),
  } });
  return;
});

// Liveness
router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } });
});

// Readiness is separate from liveness and inference availability.
router.get('/readiness', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = await databaseService.healthCheck();
  // Treat Redis as optional if no REDIS_URL (or REDIS_HOST) configured
  const redisOptional = !isBullmqEnabled() && !CONFIG.REDIS_URL && !process.env.REDIS_HOST;
  let redisPersistenceReady = false;
  let workerStatus: 'ready' | 'disabled' | 'unavailable' = isBullmqEnabled() ? 'unavailable' : 'disabled';
  let redisStatus: { status: string; details?: string } = { status: redisOptional ? 'disabled' : 'unknown' };
  if (!redisOptional) {
    try {
      const pong = await redis.ping();
      redisStatus = { status: pong === 'PONG' ? 'healthy' : 'unhealthy' };
      const persistence = await redis.info('persistence');
      const settings = await redis.config('GET', 'save', 'appendonly') as string[];
      const configuration = new Map(Array.from({ length: settings.length / 2 }, (_, index) => [settings[index * 2], settings[index * 2 + 1]]));
      redisPersistenceReady = (configuration.get('appendonly') === 'yes' || Boolean(configuration.get('save')))
        && /^rdb_last_bgsave_status:ok\r?$/m.test(persistence)
        && /^aof_last_write_status:ok\r?$/m.test(persistence);
      if (isBullmqEnabled()) workerStatus = await workersReady() ? 'ready' : 'unavailable';
    } catch (err) {
      redisStatus = { status: 'unhealthy', details: (err as Error).message };
    }
  }
  const editorialRegistry = validatePassRegistry();
  const editorialCorpus = await cachedCorpusValidation().catch((error) => ({ valid: false, error: error instanceof Error ? error.message : String(error) }));
  const readiness = publicReadinessView({
    databaseReady: db.status === 'healthy', redisStatus: redisStatus.status,
    editorialRegistryReady: editorialRegistry.valid, editorialCorpusReady: editorialCorpus.valid,
    workerStatus, redisPersistenceReady, documents: await documentRuntimeReadiness(),
  });
  const fullyReady = readiness.ready;
  res.status(fullyReady ? 200 : 503).json({
    success: fullyReady,
    data: readiness,
  });
});

// Mount route modules
for (const [name, register] of [
  ['capabilities-read', registerNovaCapabilitiesGrant],
  ['books-read', registerNovaBookReadGrant],
  ['generation-read', registerNovaGenerationReadGrant],
  ['generation-create', registerNovaGenerationCreateGrant],
  ['workflow-read', registerNovaWorkflowReadGrant],
  ['workflow-publish', registerNovaWorkflowPublishGrant],
] as const) router.post(`/nova-grants/${name}`, (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const caller = String(req.headers['x-nova-caller'] || '');
  const requestId = String(req.headers['x-nova-request'] || '');
  const principal = resolveServicePrincipal(token, 'POST', `/api/nova-grants/${name}`, caller);
  if (principal?.name !== 'nova-creative' || !/^nova-[a-f0-9]{32}$/.test(requestId)) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } }); return;
  }
  if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > 8192) {
    res.status(413).json({ success: false, error: { code: 'REQUEST_TOO_LARGE' } }); return;
  }
  try {
    const result = register(req.body, caller, requestId);
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: { grantId: result.grantId, duplicate: result.duplicate } });
  } catch (error) {
    const code = error instanceof NovaGrantError ? error.code : 'REGISTRATION_UNAVAILABLE';
    res.status(code === 'REGISTRATION_UNAVAILABLE' || code === 'INVALID_DELEGATION_CONFIG' ? 503 : 403)
      .json({ success: false, error: { code } });
  }
});
router.use('/shared-resource-operations', sharedResourceOperationsRouter);
router.use('/books', booksRouter);
router.use('/prompts', promptsRouter);
router.use('/generate', generateRouter);
router.use('/images', imagesRouter);
// Mount metrics before aliasing feedback at root so /metrics/* stays public
router.use('/metrics', metricsRouter);
// Alias singular form for convenience and compatibility with earlier notes
router.use('/image', imagesRouter);
router.use('/models', modelsRouter);
// Backward-compat alias: /api/ollama/models → /api/models
router.use('/ollama', modelsRouter);
router.use('/settings', settingsRouter);
router.use('/plot', plotRouter);
router.use('/codex', codexRouter);
router.use('/auth', authRouter);
router.use('/prose', proseRouter);
router.use('/workflows', workflowsRouter);
router.use('/editorial', editorialRouter);
router.use('/editorial-runs', (req, res, next) => {
  req.url = `/runs${req.url}`;
  editorialRouter(req, res, next);
});
router.use('/books', workflowBookRouter);
router.use('/books', editorialBookRouter);
router.use('/reviews', workflowReviewRouter);
router.use('/findings', workflowFindingRouter);
router.use('/admin/adapter', adapterRouter);
router.use('/admin/models', adminModelsRouter);
// knowledge routes removed

export default router;
