import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { referencedFilename, sweepOrphanImages } from '../../operations/imageOrphanSweep';

describe('image orphan sweep', () => {
  const HOUR = 60 * 60 * 1000;
  let root: string;
  const now = Date.parse('2026-11-26T12:00:00Z');
  const write = (name: string, ageHours: number) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, 'image-bytes');
    const time = new Date(now - ageHours * HOUR);
    fs.utimesSync(file, time, time);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proser-orphans-'));
    write('kept.png', 48);
    write('orphan.png', 48);
    write('fresh.png', 1);
    write('.document-readiness-probe', 48);
    write('late-reference.png', 48);
  });

  const referenced = new Set(['kept.png']);
  const options = (apply: boolean, late = new Set<string>()) => ({
    root, now, apply,
    referencedNames: async () => referenced,
    isReferenced: async (file: string) => referenced.has(file) || late.has(file),
  });

  it('reports unreferenced files older than the grace period without removing them', async () => {
    const result = await sweepOrphanImages(options(false));
    expect(result.orphans.map((orphan) => orphan.file)).toEqual(['late-reference.png', 'orphan.png']);
    expect(result.removed).toEqual([]);
    expect(result.bytes).toBe(2 * 'image-bytes'.length);
    expect(fs.existsSync(path.join(root, 'orphan.png'))).toBe(true);
  });

  it('removes only files still unreferenced at removal time when applied', async () => {
    const result = await sweepOrphanImages(options(true, new Set(['late-reference.png'])));
    expect(result.removed).toEqual(['orphan.png']);
    for (const kept of ['kept.png', 'fresh.png', '.document-readiness-probe', 'late-reference.png'])
      expect(fs.existsSync(path.join(root, kept))).toBe(true);
    expect(fs.existsSync(path.join(root, 'orphan.png'))).toBe(false);
  });

  it('treats a missing image directory as empty and reads names from records', async () => {
    expect(await sweepOrphanImages({ ...options(false), root: path.join(root, 'missing') })).toEqual({ orphans: [], removed: [], bytes: 0 });
    expect(referencedFilename('/images/cover.png?v=2')).toBe('cover.png');
    expect(referencedFilename('import-abc.jpg')).toBe('import-abc.jpg');
    expect(referencedFilename('')).toBeNull();
  });
});
