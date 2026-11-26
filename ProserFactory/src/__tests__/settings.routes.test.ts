import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import app from '../index';

describe('settings routes', () => {
  const originalSettingsFile = process.env.USER_SETTINGS_FILE;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proser-user-settings-'));
    process.env.USER_SETTINGS_FILE = path.join(tempDir, 'user-settings.json');
  });

  afterEach(() => {
    const settingsFile = process.env.USER_SETTINGS_FILE;
    if (settingsFile) {
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    }
    process.env.USER_SETTINGS_FILE = originalSettingsFile;
  });

  it('returns username-backed defaults before settings are saved', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('x-user-id', '21')
      .set('x-github-id', 'jest-settings-defaults')
      .set('x-username', 'fixture-author');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      profile: { displayName: 'fixture-author' },
      writing: { defaultGenre: '', writingStyle: '', targetAudience: '' },
    });
  });

  it('reports the running release version and revision to signed-in writers', async () => {
    expect((await request(app).get('/api/settings/about')).status).toBe(401);
    const res = await request(app)
      .get('/api/settings/about')
      .set('x-user-id', '21')
      .set('x-github-id', 'jest-settings-about')
      .set('x-username', 'fixture-author');
    expect(res.status).toBe(200);
    const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
    expect(res.body.data.version).toBe(manifest.version);
    expect(res.body.data).toHaveProperty('revision');

    const health = await request(app).get('/health');
    expect(health.body.version).toBe(manifest.version);
  });

  it('persists profile and writing settings by user', async () => {
    const saveRes = await request(app)
      .put('/api/settings')
      .set('x-user-id', '22')
      .set('x-github-id', 'jest-settings-save')
      .set('x-username', 'fixture-author')
      .send({
        profile: { displayName: 'Swarm Lord' },
        writing: {
          defaultGenre: 'fantasy',
          writingStyle: 'gothic dread',
          targetAudience: 'adult',
        },
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);
    expect(saveRes.body.data.profile.displayName).toBe('Swarm Lord');
    expect(saveRes.body.data.writing.defaultGenre).toBe('fantasy');

    const getRes = await request(app)
      .get('/api/settings')
      .set('x-user-id', '22')
      .set('x-github-id', 'jest-settings-save')
      .set('x-username', 'fixture-author');

    expect(getRes.status).toBe(200);
    expect(getRes.body.data).toEqual({
      profile: { displayName: 'Swarm Lord' },
      writing: {
        defaultGenre: 'fantasy',
        writingStyle: 'gothic dread',
        targetAudience: 'adult',
      },
    });

    const savedFile = fs.readFileSync(process.env.USER_SETTINGS_FILE!, 'utf8');
    expect(savedFile).toContain('"22"');
    expect(savedFile).toContain('"displayName": "Swarm Lord"');
    expect(fs.statSync(process.env.USER_SETTINGS_FILE!).mode & 0o777).toBe(0o600);
    expect(savedFile).toContain('"writingStyle": "gothic dread"');
  });

  it('never stores, returns or keeps cloud provider keys', async () => {
    fs.writeFileSync(process.env.USER_SETTINGS_FILE!, JSON.stringify({
      version: 1,
      users: { 23: { profile: { displayName: 'Earlier' }, ai: { openaiKey: 'sk-retired-openai', anthropicKey: 'sk-retired-ant' } } },
    }), { mode: 0o600 });

    const getRes = await request(app)
      .get('/api/settings')
      .set('x-user-id', '23')
      .set('x-github-id', 'jest-settings-retired-keys')
      .set('x-username', 'fixture-author');
    expect(getRes.status).toBe(200);
    expect(getRes.body.data).not.toHaveProperty('ai');
    expect(JSON.stringify(getRes.body)).not.toContain('sk-retired');
    expect(fs.readFileSync(process.env.USER_SETTINGS_FILE!, 'utf8')).not.toContain('sk-retired');

    const keysOnly = await request(app)
      .put('/api/settings')
      .set('x-user-id', '23')
      .set('x-github-id', 'jest-settings-retired-keys')
      .set('x-username', 'fixture-author')
      .send({ ai: { openaiKey: 'sk-new' } });
    expect(keysOnly.status).toBe(422);

    const mixed = await request(app)
      .put('/api/settings')
      .set('x-user-id', '23')
      .set('x-github-id', 'jest-settings-retired-keys')
      .set('x-username', 'fixture-author')
      .send({ profile: { displayName: 'Later' }, ai: { openaiKey: 'sk-new' } });
    expect(mixed.status).toBe(200);
    expect(mixed.body.data).not.toHaveProperty('ai');
    expect(fs.readFileSync(process.env.USER_SETTINGS_FILE!, 'utf8')).not.toContain('sk-new');
  });
});
