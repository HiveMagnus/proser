import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import app from '../index';
import { loadInferenceSettingsFile } from '../core/inferenceSettingsFile';

describe('authenticated and internal model routes', () => {
  const original = { ...process.env };
  let settingsDir = '';

  beforeEach(() => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proser-model-settings-'));
    process.env.OLLAMA_SETTINGS_FILE = path.join(settingsDir, '.env.local');
    process.env.OLLAMA_BASE_URL = 'http://configured.test:8000';
    process.env.INFERENCE_HOST = 'http://configured.test:8000';
    process.env.INFERENCE_API_KEY = 'test-inference-api-key-at-least-32-characters';
    process.env.VLLM_BASE_URL = 'http://configured.test:8000';
    process.env.OLLAMA_MODEL = 'configured-model';
    process.env.INTERNAL_API_SECRET = 'jest-internal-models';
    process.env.INFERENCE_ADMIN_HOST_ALLOWLIST = 'http://allowed.test:8000';
    (global.fetch as jest.Mock).mockReset();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }] }) });
  });

  afterEach(() => {
    fs.rmSync(settingsDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });

  it('requires authentication, ignores host overrides and probes only the configured backend', async () => {
    expect((await request(app).get('/api/models')).status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    const res = await request(app).get('/api/models').set({ 'X-User-Id': '1', 'X-Github-Id': 'fixture-user' }).query({ host: 'http://attacker.invalid:1234' });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith('http://configured.test:8000/v1/models', expect.any(Object));
    expect(global.fetch).toHaveBeenCalledWith(
      'http://configured.test:8000/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-inference-api-key-at-least-32-characters',
        }),
      }),
    );
  });

  it('rejects unauthenticated and unallowlisted internal probes', async () => {
    expect((await request(app).get('/api/admin/models/probe').query({ host: 'http://allowed.test:8000' })).status).toBe(401);
    const blocked = await request(app).get('/api/admin/models/probe')
      .set('X-Internal-Secret', 'jest-internal-models')
      .query({ host: 'http://metadata.google.internal' });
    expect(blocked.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('allows an internal probe and settings update only for allowlisted hosts', async () => {
    const auth = { 'X-Internal-Secret': 'jest-internal-models' };
    const probe = await request(app).get('/api/admin/models/probe').set(auth).query({ host: 'http://allowed.test:8000' });
    expect(probe.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith('http://allowed.test:8000/v1/models', expect.any(Object));

    const saved = await request(app).put('/api/admin/models/settings').set(auth).send({ host: 'http://allowed.test:8000', model: 'model-a' });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(process.env.OLLAMA_SETTINGS_FILE!, 'utf8')).toContain('VLLM_BASE_URL=http://allowed.test:8000');
  });

  it.each([
    'model-a\nFACTORY_AUTH_SECRET=replaced',
    'model-a\r\nNODE_ENV=development',
    'model-a # comment',
    'model "quoted"',
    '$(id)',
  ])('rejects a model name that could alter the settings file: %j', async (model) => {
    const res = await request(app).put('/api/admin/models/settings')
      .set('X-Internal-Secret', 'jest-internal-models')
      .send({ host: 'http://allowed.test:8000', model });
    expect(res.status).toBe(400);
    expect(fs.existsSync(process.env.OLLAMA_SETTINGS_FILE!)).toBe(false);
  });

  it('loads only inference keys from the settings file', () => {
    fs.writeFileSync(process.env.OLLAMA_SETTINGS_FILE!, [
      'OLLAMA_MODEL=model-b',
      'FACTORY_AUTH_SECRET=replaced-by-settings-file',
      'NODE_ENV=development',
      'DATABASE_URL=postgresql://elsewhere.invalid/proser',
    ].join('\n'));
    const environment: NodeJS.ProcessEnv = { OLLAMA_SETTINGS_FILE: process.env.OLLAMA_SETTINGS_FILE, NODE_ENV: 'production' };
    loadInferenceSettingsFile(environment);
    expect(environment).toEqual({ OLLAMA_SETTINGS_FILE: process.env.OLLAMA_SETTINGS_FILE, NODE_ENV: 'production', OLLAMA_MODEL: 'model-b' });
  });

  it('does not expose a public settings mutation route', async () => {
    const res = await request(app).put('/api/models/settings').send({ host: 'http://allowed.test:8000', model: 'model-a' });
    expect(res.status).toBe(404);
  });

  it('requires authentication before probing image readiness', async () => {
    const res = await request(app).get('/api/images/health');
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
