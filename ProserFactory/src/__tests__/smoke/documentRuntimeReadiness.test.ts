import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
jest.mock('@/lib/database', () => ({ databaseService: { client: { $queryRaw: jest.fn(), sceneDocumentRevision: { count: jest.fn(async () => 0) } } } }));
jest.mock('playwright', () => ({ chromium: { launch: jest.fn(async () => ({ version: () => '143.fixture', close: jest.fn(async () => undefined) })) } }));
jest.mock('@/documents/searchIndex', () => ({ searchIndexReadiness: jest.fn(async () => true) }));
jest.mock('@/documents/selectedAssets', () => ({ selectedArtworkReadiness: jest.fn(async () => true) }));
import { databaseService } from '@/lib/database';
import { documentRuntimeReadiness, verifyPublicationFonts } from '@/documents/runtimeReadiness';
import { publicReadinessView } from '@/api/readinessView';
import { searchIndexReadiness } from '@/documents/searchIndex';

describe('active document runtime prerequisites', () => {
  let directory: string;
  const previous = { enabled: process.env.DOCUMENT_AUTHORITY_ENABLED, fonts: process.env.PUBLICATION_FONT_MANIFEST };
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(),'proser-fonts-')); });
  afterEach(async () => { await rm(directory,{ recursive: true, force: true });
    if (previous.enabled === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previous.enabled;
    if (previous.fonts === undefined) delete process.env.PUBLICATION_FONT_MANIFEST; else process.env.PUBLICATION_FONT_MANIFEST = previous.fonts;
  });
  const fixture = async () => {
    const font = path.join(directory,'font.ttf'); const license = path.join(directory,'LICENSE'); const manifest = path.join(directory,'fonts.json');
    const bytes = Buffer.from('An isolated font checksum fixture.'); await writeFile(font,bytes); await writeFile(license,'Fixture license notice');
    await writeFile(manifest,JSON.stringify({ schemaVersion: 1, fonts: [{ name: 'Fixture', version: '1', path: font, sha256: createHash('sha256').update(bytes).digest('hex'), licensePath: license }] }));
    return { font, license, manifest };
  };
  test('font bytes and retained license are verified; tampering or missing pins fails', async () => {
    const files = await fixture(); expect(await verifyPublicationFonts(files.manifest)).toHaveLength(1);
    await writeFile(files.font,'Tampered'); await expect(verifyPublicationFonts(files.manifest)).rejects.toThrow('digest');
    await expect(verifyPublicationFonts('relative.json')).rejects.toThrow('manifest');
  });
  test('active schema requires complete book backfill, database enforcement and licensed renderer prerequisites', async () => {
    const files = await fixture(); process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; process.env.PUBLICATION_FONT_MANIFEST = files.manifest;
    (databaseService.client.$queryRaw as jest.Mock).mockResolvedValueOnce([{ schema: true, artifacts: true, enforcement: true }]).mockResolvedValueOnce([{ count: 0n }]).mockResolvedValueOnce([{ enabled: false, candidate_sha: null, rehearsal_sha256: null }]);
    const documents = await documentRuntimeReadiness(); expect(documents).toMatchObject({ documentSchema: 'ready', documentSearchIndex: 'ready', artifactStorage: 'ready', publicationFonts: 'ready', publicationRenderer: 'ready', documentEnforcement: 'unavailable' });
    expect(publicReadinessView({ databaseReady: true, redisStatus: 'disabled', editorialRegistryReady: true, editorialCorpusReady: true, documents }).ready).toBe(false);
  });
  test('missing current revision indexes independently block readiness', async () => {
    const files = await fixture(); process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; process.env.PUBLICATION_FONT_MANIFEST = files.manifest;
    (searchIndexReadiness as jest.Mock).mockResolvedValueOnce(false);
    (databaseService.client.$queryRaw as jest.Mock).mockResolvedValueOnce([{ schema: true, artifacts: true, enforcement: true }]).mockResolvedValueOnce([{ count: 0n }]).mockResolvedValueOnce([{ enabled: true, candidate_sha: 'a'.repeat(40), rehearsal_sha256: 'b'.repeat(64) }]);
    const documents = await documentRuntimeReadiness(); expect(documents.documentSearchIndex).toBe('unavailable');
    expect(publicReadinessView({ databaseReady: true, redisStatus: 'disabled', editorialRegistryReady: true, editorialCorpusReady: true, documents }).ready).toBe(false);
  });
  test('inactive compatibility release has disabled document requirements', async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'false';
    expect(Object.values(await documentRuntimeReadiness()).every((value) => value === 'disabled')).toBe(true);
  });
});
