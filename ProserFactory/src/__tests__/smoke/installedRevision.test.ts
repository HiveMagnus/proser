import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedRevision } from '@/core/installedRevision';

describe('installed Factory revision authority', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), 'proser-revision-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
  test('uses the installed release despite a stale environment label', async () => {
    const priorDirectory = process.cwd();
    const keys = ['GIT_COMMIT', 'COMMIT_SHA', 'DATABASE_URL', 'NODE_ENV'] as const;
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { GIT_COMMIT: 'a'.repeat(40), COMMIT_SHA: 'a'.repeat(40), DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55441/proser_canvas_revision_fixture', NODE_ENV: 'test' });
    try {
      writeFileSync(path.join(directory, 'REVISION'), 'b'.repeat(40) + '\n');
      process.chdir(directory);
      await jest.isolateModulesAsync(async () => {
        const { CONFIG } = await import('@/core/config');
        expect(CONFIG.GIT_COMMIT).toBe('b'.repeat(40));
        expect(CONFIG.COMMIT_SHA).toBe('b'.repeat(40));
      });
    } finally {
      process.chdir(priorDirectory);
      for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    }
  });
  test('permits development without a native release file', () => {
    expect(installedRevision(path.join(directory, 'REVISION'))).toBeUndefined();
  });
  test.each(['', 'not-a-commit', 'a'.repeat(39)])('refuses an invalid installed release instead of falling back', (value) => {
    writeFileSync(path.join(directory, 'REVISION'), value);
    expect(() => installedRevision(path.join(directory, 'REVISION'))).toThrow('Installed Factory revision is invalid');
  });
});
