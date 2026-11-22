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
      ai: { openaiKey: '', anthropicKey: '' },
      writing: { defaultGenre: '', writingStyle: '', targetAudience: '' },
    });
  });

  it('persists profile, ai, and writing settings by user', async () => {
    const saveRes = await request(app)
      .put('/api/settings')
      .set('x-user-id', '22')
      .set('x-github-id', 'jest-settings-save')
      .set('x-username', 'fixture-author')
      .send({
        profile: { displayName: 'Swarm Lord' },
        ai: { openaiKey: 'sk-openai', anthropicKey: 'sk-ant' },
        writing: {
          defaultGenre: 'fantasy',
          writingStyle: 'gothic dread',
          targetAudience: 'adult',
        },
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);
    expect(saveRes.body.data.profile.displayName).toBe('Swarm Lord');
    expect(saveRes.body.data.ai.openaiKey).toBe('sk-openai');
    expect(saveRes.body.data.writing.defaultGenre).toBe('fantasy');

    const getRes = await request(app)
      .get('/api/settings')
      .set('x-user-id', '22')
      .set('x-github-id', 'jest-settings-save')
      .set('x-username', 'fixture-author');

    expect(getRes.status).toBe(200);
    expect(getRes.body.data).toEqual({
      profile: { displayName: 'Swarm Lord' },
      ai: { openaiKey: 'sk-openai', anthropicKey: 'sk-ant' },
      writing: {
        defaultGenre: 'fantasy',
        writingStyle: 'gothic dread',
        targetAudience: 'adult',
      },
    });

    const savedFile = fs.readFileSync(process.env.USER_SETTINGS_FILE!, 'utf8');
    expect(savedFile).toContain('"22"');
    expect(savedFile).toContain('"displayName": "Swarm Lord"');
    expect(savedFile).toContain('"writingStyle": "gothic dread"');
  });
});
