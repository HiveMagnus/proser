import fs from 'fs';
import path from 'path';
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { authenticateInternal, authenticateRequest } from '../middleware/auth';
import logger from '../../lib/logger';
import {
  DEFAULT_INFERENCE_BASE_URL,
  DEFAULT_INFERENCE_BACKEND,
  DEFAULT_INFERENCE_MODEL,
  fetchInferenceModelIds,
  resolveInferenceBaseUrl,
  resolveInferenceModel,
} from '../../lib/ai/vllm';
import { respondError, ErrorCodes } from '../utils/response';

const router = Router();
export const adminModelsRouter = Router();

const DEFAULT_INFERENCE_PORT = '8000';

type InferenceModel = { id: string; name: string };

function getSettingsFilePath(): string {
  return process.env.OLLAMA_SETTINGS_FILE || path.resolve(process.cwd(), 'data/ollama-settings.env');
}

function normalizeInferenceHost(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return normalizeInferenceHost(resolveInferenceBaseUrl() || DEFAULT_INFERENCE_BASE_URL);
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try { url = new URL(withProtocol); } catch { throw new Error('Enter a valid inference host.'); }
  if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS inference host.');
  if (url.username || url.password) throw new Error('Inference host credentials are not allowed in the URL.');
  if (!url.port) url.port = DEFAULT_INFERENCE_PORT;
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function normalizeInferenceModel(input: unknown): string {
  return String(input ?? '').trim() || resolveInferenceModel() || DEFAULT_INFERENCE_MODEL;
}

function getCurrentInferenceSettings() {
  return {
    host: normalizeInferenceHost(resolveInferenceBaseUrl() || DEFAULT_INFERENCE_BASE_URL),
    model: normalizeInferenceModel(resolveInferenceModel()),
  };
}

function allowedAdminHosts(): Set<string> {
  const values = String(process.env.INFERENCE_ADMIN_HOST_ALLOWLIST || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  return new Set([getCurrentInferenceSettings().host, ...values.map(normalizeInferenceHost)]);
}

function requireAllowedAdminHost(input: unknown): string {
  const host = normalizeInferenceHost(input);
  if (!allowedAdminHosts().has(host)) throw new Error('Inference host is not in INFERENCE_ADMIN_HOST_ALLOWLIST.');
  return host;
}

function writeEnvFile(filePath: string, updates: Record<string, string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  fs.writeFileSync(filePath, `${nextLines.filter((line, index, all) => !(line === '' && index === all.length - 1)).join('\n')}\n`, 'utf8');
}

function persistInferenceSettings(settings: { host: string; model: string }): void {
  const updates = {
    INFERENCE_BACKEND: DEFAULT_INFERENCE_BACKEND,
    OLLAMA_BASE_URL: settings.host,
    OLLAMA_HOST: settings.host,
    INFERENCE_HOST: settings.host,
    VLLM_BASE_URL: settings.host,
    OLLAMA_MODEL: settings.model,
    VLLM_MODEL: settings.model,
  };
  writeEnvFile(getSettingsFilePath(), updates);
  Object.assign(process.env, updates);
}

async function fetchInferenceModels(host: string): Promise<InferenceModel[]> {
  return (await fetchInferenceModelIds(host)).filter(Boolean).map((id) => ({ id, name: id }));
}

function sendSuccess(res: Response, data: unknown): void {
  res.json({ ok: true, success: true, data });
}

async function sendModels(req: AuthenticatedRequest, res: Response, host: string): Promise<void> {
  try {
    const models = await fetchInferenceModels(host);
    logger.info({ userId: req.user?.id, host, modelCount: models.length }, 'Retrieved available models');
    sendSuccess(res, models);
  } catch (error) {
    logger.error({ error, host }, 'Failed to get available models');
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve available models', 502);
  }
}

async function sendStatus(req: AuthenticatedRequest, res: Response, host: string, model: string): Promise<void> {
  try {
    const models = await fetchInferenceModels(host);
    sendSuccess(res, req.novaGrant
      ? { connected: true, model, modelCount: models.length }
      : { connected: true, host, model, models, modelCount: models.length });
  } catch (error) {
    logger.warn({ error, host }, 'Inference status check failed');
    sendSuccess(res, req.novaGrant
      ? { connected: false, model, modelCount: 0, error: 'Connection failed' }
      : { connected: false, host, model, models: [], modelCount: 0, error: 'Connection failed' });
  }
}

// Authenticated inspection is pinned to the configured backend. Query-supplied hosts are ignored.
// Nova receives capability data without the private backend address.
router.get(['/', '/models'], authenticateRequest, (req: AuthenticatedRequest, res) => sendModels(req, res, getCurrentInferenceSettings().host));
router.get('/settings', authenticateRequest, (req: AuthenticatedRequest, res) => {
  const settings = getCurrentInferenceSettings();
  sendSuccess(res, req.novaGrant ? { model: settings.model, hostConfigured: true } : settings);
});
router.get('/status', authenticateRequest, (req: AuthenticatedRequest, res) => {
  const settings = getCurrentInferenceSettings();
  return sendStatus(req, res, settings.host, settings.model);
});

// Arbitrary probes and global mutations are internal operations and host-allowlisted.
adminModelsRouter.use(authenticateInternal);
adminModelsRouter.get(['/probe', '/status'], async (req: AuthenticatedRequest, res) => {
  try {
    const host = requireAllowedAdminHost(req.query.host);
    if (req.path.endsWith('/status')) return sendStatus(req, res, host, normalizeInferenceModel(req.query.model));
    return sendModels(req, res, host);
  } catch (error) {
    respondError(res, ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : 'Host is not allowed', 403);
  }
});
adminModelsRouter.put('/settings', (req: AuthenticatedRequest, res) => {
  try {
    const settings = { host: requireAllowedAdminHost(req.body?.host), model: normalizeInferenceModel(req.body?.model) };
    persistInferenceSettings(settings);
    logger.info({ host: settings.host, model: settings.model }, 'Saved inference settings via internal admin API');
    sendSuccess(res, settings);
  } catch (error) {
    respondError(res, ErrorCodes.VALIDATION_FAILED, error instanceof Error ? error.message : 'Invalid inference settings', 400);
  }
});

export default router;
