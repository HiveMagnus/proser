import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
jest.mock('@/operations/releaseAdmission', () => ({ withReleaseRecovery: (action: () => Promise<unknown>) => action() }));
jest.mock('@/documents/service', () => ({ documentService: { sideRecord: jest.fn(), registerSelectedArtworkForRelease:jest.fn() } }));
import { documentService } from '@/documents/service';
import { backfillSelectedArtwork,registerSelectedArtworkEvidence } from '@/documents/selectedAssetBackfill';

describe('pre-activation selected artwork registration', () => {
  const previous = process.env.DOCUMENT_AUTHORITY_ENABLED;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  let file: string; let asset: { id: number; name: string; url: string; configJson: string }; let tx: { $queryRaw: jest.Mock; imageAsset: { findFirst: jest.Mock; update: jest.Mock }; auditLog: { create: jest.Mock } };
  beforeEach(async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'false'; const name = `backfill-fixture-${randomUUID()}.png`; file = path.resolve('public/images', name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    asset = { id: 11, name, url: `/images/${name}`, configJson: '{ "legacy": "keep exact metadata" }' };
    tx = { $queryRaw: jest.fn().mockResolvedValueOnce([{ installed: false }]).mockResolvedValueOnce([{ id: 11 }]), imageAsset: { findFirst: jest.fn(async () => asset), update: jest.fn(async ({ data }: { data: { configJson: string } }) => { asset.configJson = data.configJson; }) }, auditLog: { create: jest.fn() } };
    (documentService.registerSelectedArtworkForRelease as jest.Mock).mockImplementation((_user:number,_book:number)=>registerSelectedArtworkEvidence(tx as never,_user,_book,true));
    (documentService.sideRecord as jest.Mock).mockImplementation(async (_user: number, _book: number, action: (client: typeof tx) => Promise<unknown>) => action(tx));
  });
  afterEach(async () => { await unlink(file).catch(() => undefined); if (previous === undefined) delete process.env.DOCUMENT_AUTHORITY_ENABLED; else process.env.DOCUMENT_AUTHORITY_ENABLED = previous; });
  test('preview leaves metadata intact; apply retains exact previous bytes and is idempotent', async () => {
    const original = asset.configJson;
    expect(await backfillSelectedArtwork(7, 8)).toMatchObject({ mode: 'preview', examined: 1, changed: 1 }); expect(asset.configJson).toBe(original); expect(tx.auditLog.create).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValueOnce([{ installed: false }]).mockResolvedValueOnce([{ id: 11 }]);
    expect(await backfillSelectedArtwork(7, 8, true)).toMatchObject({ mode: 'apply', changed: 1 });
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.oldConfigJson).toBe(original);
    expect(JSON.parse(asset.configJson)).toMatchObject({ legacy: 'keep exact metadata', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', byteLength: bytes.length, width: 1, height: 1 });
    tx.$queryRaw.mockResolvedValueOnce([{ installed: false }]).mockResolvedValueOnce([{ id: 11 }]);
    expect(await backfillSelectedArtwork(7, 8, true)).toMatchObject({ changed: 0 }); expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  test('a mismatched registered digest fails before metadata or audit writes', async () => {
    asset.configJson = JSON.stringify({ sha256: 'a'.repeat(64) });
    await expect(backfillSelectedArtwork(7, 8, true)).rejects.toMatchObject({ code: 'DOCUMENT_SELECTED_ASSET_INVALID' }); expect(tx.imageAsset.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  test('application and database activation each fence registration', async () => {
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'true'; await expect(backfillSelectedArtwork(7, 8, true)).rejects.toMatchObject({ code: 'DOCUMENT_ASSET_BACKFILL_ACTIVATED' });
    process.env.DOCUMENT_AUTHORITY_ENABLED = 'false'; tx.$queryRaw.mockReset().mockResolvedValueOnce([{ installed: true }]).mockResolvedValueOnce([{ enabled: true }]);
    await expect(backfillSelectedArtwork(7, 8, true)).rejects.toMatchObject({ code: 'DOCUMENT_ASSET_BACKFILL_ACTIVATED' }); expect(tx.imageAsset.update).not.toHaveBeenCalled();
  });
});
