import { hermesAgentCredentials } from './api/middleware/auth';
import express from 'express';
import { expensivePayloadGuard } from './api/middleware/expensiveRouteLimit';
import { createApiRateLimit } from './api/middleware/apiRateLimit';
import https from 'https';
import http from 'http';
import fs from 'fs';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import dotenv from 'dotenv';
import apiRouter from './api';
import logger from './lib/logger';
import { errorHandler } from './lib/errors';
import redis from './lib/redis';
import { databaseService } from './lib/database';
import { CONFIG } from './core/config';
import { isBullmqEnabled } from './queues/featureFlag';
import { getWorkflowQueue } from './queues/workflowQueue';
import { shutdownWorkflowQueue } from './queues/workflowQueue';
import { shutdownBullConnections } from './queues/connection';
import {
  startGenerationOperationSupervisor,
  stopGenerationOperationSupervisor,
} from './services/generationOperationRunner';

// Load env from .env and .env.local if present
const inheritedEnvironment = { ...process.env };
dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: true });
Object.assign(process.env, inheritedEnvironment);

/** True for http(s) origins on this machine, such as a local development UI. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function createApp() {
  const app = express();
  app.use(helmet());
  // CORS: development and tests accept browser origins on this machine only;
  // production accepts the configured allowlist. Author calls Factory server
  // side, so browsers normally never call Factory directly.
  const allowlist = (CONFIG.CORS_ALLOWLIST || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const sharedCorsHeaders = {
    credentials: true as const,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-username', 'x-email', 'x-avatar-url', 'X-Internal-Secret'],
    exposedHeaders: ['Content-Disposition'],
  };
  if (CONFIG.NODE_ENV !== 'production') {
    app.use(cors({ origin: (origin, callback) => callback(null, !origin || isLoopbackOrigin(origin)), ...sharedCorsHeaders } as CorsOptions));
  } else {
    const corsOptions: CorsOptions = {
      ...sharedCorsHeaders,
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // non-browser or same-origin
        if (allowlist.length === 0) return callback(null, false);
        const allowed = allowlist.includes(origin);
        return callback(allowed ? null : new Error('Not allowed by CORS'), allowed);
      },
    };
    app.use(cors(corsOptions));
  }
  app.use(compression());
  app.use(expensivePayloadGuard);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  // Backstop for every route below; expensive routes add their own tighter limits.
  app.use(createApiRateLimit());
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });
  app.use(pinoHttp({
    logger,
    // Reduce noise in tests: disable autoLogging when running under Jest
    autoLogging: process.env.NODE_ENV === 'test' ? false : {
      // Ignore very noisy endpoints like health/readiness/status routes
      ignore: (req) => {
        try {
          const url = (req.url || '').split('?')[0];
          const method = (req.method || 'GET').toUpperCase();
          if (method === 'OPTIONS') return true;
          // Common health/readiness endpoints
          const patterns = [
            /^\/health(\/.*)?$/,
            /^\/api\/health$/,
            /^\/api\/readiness$/,
            /^\/api\/images\/health$/,
            /^\/api\/workflows\/[A-Fa-f0-9-]+$/
          ];
          return patterns.some((re) => re.test(url));
        } catch {
          return false;
        }
      },
    },
  }));

  app.get('/health', async (req, res) => {
    let redisHealth: { status: string; error?: string } = { status: 'disabled' };
    try { const pong = await redis.ping(); redisHealth = { status: pong === 'PONG' ? 'healthy' : 'unhealthy' }; }
    catch (error) { redisHealth = { status: 'unhealthy', error: (error as Error).message }; }
    const dbHealth = await databaseService.healthCheck();
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      commit: CONFIG.GIT_COMMIT || CONFIG.COMMIT_SHA || (() => {
        try { return fs.readFileSync('REVISION', 'utf8').trim() || undefined; } catch { return undefined; }
      })(),
      build: CONFIG.BUILD_ID,
      services: { database: dbHealth, redis: redisHealth }
    };
    const isHealthy = dbHealth.status === 'healthy' && redisHealth.status === 'healthy';
    res.status(isHealthy ? 200 : 503).json(health);
  });

  // Optional: basic queue health (does not alter behavior)
  app.get('/health/queue', async (req, res) => {
    if (!isBullmqEnabled()) {
      return res.json({ status: 'disabled' });
    }
    try {
      const workflowQ = getWorkflowQueue();
  const counts = await workflowQ.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  const paused = await workflowQ.isPaused().catch(() => false);
      // Workers running (best-effort)
      let workers = 0;
      try {
        const ws = await (workflowQ as unknown as { getWorkers?: () => Promise<unknown[]> }).getWorkers?.();
        workers = Array.isArray(ws) ? ws.length : 0;
      } catch { /* ignore */ }
      // Approximate queue latency: median age of waiting/delayed jobs (ms)
      let latencyMsP50 = 0;
      try {
        const jobs = await workflowQ.getJobs(['waiting', 'delayed'], 0, 49, false);
        const now = Date.now();
        const ages = jobs.map(j => Math.max(0, now - (j.timestamp ?? now)));
        if (ages.length > 0) {
          ages.sort((a, b) => a - b);
          const mid = Math.floor(ages.length / 2);
          latencyMsP50 = ages.length % 2 === 0 ? Math.floor((ages[mid - 1] + ages[mid]) / 2) : ages[mid];
        }
      } catch { /* ignore */ }
      // Failure rate from retained completed/failed jobs
      const failed = counts.failed ?? 0;
      const completed = counts.completed ?? 0;
      const denom = failed + completed;
      const failureRate = denom > 0 ? failed / denom : 0;

  return res.json({ status: 'ok', workflows: { counts, workers, latencyMsP50, failureRate, paused } });
    } catch (error) {
      return res.status(503).json({ status: 'unhealthy', error: (error as Error).message });
    }
  });

  app.get('/health/redis', async (req, res) => {
    try { await redis.ping(); res.json({ status: 'redis connected' }); }
    catch (error) { const errorMessage = error instanceof Error ? error.message : 'Unknown error'; res.status(503).json({ status: 'redis disconnected', error: errorMessage }); }
  });

  app.use('/api', apiRouter);
  app.use(errorHandler);
  app.use((req, res) => { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }); });
  return app;
}

let activeServer: http.Server | https.Server | null = null;

export async function startServer(port: number | string = process.env.PORT || 3001, app = createApp()) {
  validateProductionMetricsConfig();
  hermesAgentCredentials(); // Refuse to start on a malformed per-agent credential set.
  await databaseService.connect();
  logger.info('Database connection established');
  try { await redis.ping(); logger.info('Redis connection verified'); } catch { logger.warn('Redis not available, continuing without caching'); }
  startGenerationOperationSupervisor();

  let server: http.Server | https.Server;
  if (CONFIG.TLS_ENABLED && CONFIG.TLS_CERT_FILE && CONFIG.TLS_KEY_FILE) {
    const tlsOptions: https.ServerOptions = {
      cert: fs.readFileSync(CONFIG.TLS_CERT_FILE),
      key: fs.readFileSync(CONFIG.TLS_KEY_FILE),
    };
    if (CONFIG.TLS_CA_FILE) {
      tlsOptions.ca = fs.readFileSync(CONFIG.TLS_CA_FILE);
    }
    server = https.createServer(tlsOptions, app).listen(port, () => {
      logger.info({ port, tls: true }, 'Server started with TLS');
      logger.info(`Health check available at https://localhost:${port}/health`);
    });
  } else {
    server = app.listen(port, () => {
      logger.info({ port, tls: false }, 'Server started (plain HTTP)');
      logger.info(`Health check available at http://localhost:${port}/health`);
    });
  }

  activeServer = server;

  return { app, server };
}

export function validateProductionMetricsConfig(
  env: { NODE_ENV?: string; METRICS_TOKEN?: string } = process.env,
): void {
  if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN?.trim()) {
    throw new Error('METRICS_TOKEN is required when NODE_ENV=production');
  }
}

export async function shutdown() {
  stopGenerationOperationSupervisor();
  const server = activeServer;
  activeServer = null;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await shutdownWorkflowQueue();
  await shutdownBullConnections();
  await databaseService.disconnect();
  await redis.disconnect();
}
