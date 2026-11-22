import { codexRetrievalService, buildCodexContextSection } from '../services/codexRetrievalService';
import { databaseService } from '../lib/database';

beforeAll(async () => { if (!databaseService.isReady) await databaseService.connect(); });
afterAll(async () => { await databaseService.disconnect(); });

test('buildCodexContextSection formats entries compactly', () => {
  const txt = buildCodexContextSection([
    { id: 1, entry_type: 'character', entry_name: 'Arin', excerpt: 'A ranger of the north' },
    { id: 2, entry_type: 'location', entry_name: 'Frostmere', excerpt: 'Snowbound valley town' }
  ]);
  expect(txt).toContain('[Codex Context]');
  expect(txt).toContain('- Character: Arin —');
  expect(txt).toContain('- Location: Frostmere —');
  expect(txt.trim().endsWith('---')).toBe(true);
});

test('getRelevantCodex returns empty when no data', async () => {
  const out = await codexRetrievalService.getRelevantCodex({ bookId: 999999, outline: 'foo', summary: 'bar' });
  expect(Array.isArray(out)).toBe(true);
});
