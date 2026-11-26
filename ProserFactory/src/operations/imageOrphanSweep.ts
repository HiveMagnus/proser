/**
 * Find image files that no image record references, and optionally remove them.
 *
 *   node dist/operations/imageOrphanSweep.js                 # report only
 *   node dist/operations/imageOrphanSweep.js --apply         # remove the reported files
 *   node dist/operations/imageOrphanSweep.js --min-age-hours=48
 *
 * Deleting an image record keeps its file, because another record or import
 * may share the filename. A file is an orphan when no `images` row names it
 * (by `name` or by the last segment of `url`). Files newer than the minimum age
 * (24 hours by default) are left alone, since generation and DOCX imports write
 * the file before the record that references it commits. Hidden files are
 * skipped. With --apply, each file is checked again just before removal.
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface OrphanImage {
  file: string;
  bytes: number;
  modifiedAt: string;
}

export interface SweepOptions {
  root?: string;
  minAgeMs?: number;
  now?: number;
  apply?: boolean;
  /** Every filename an image record references. */
  referencedNames: () => Promise<Set<string>>;
  /** Whether a record references this filename right now. */
  isReferenced: (file: string) => Promise<boolean>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function referencedFilename(value: string | null | undefined): string | null {
  if (!value) return null;
  const name = path.posix.basename(value.split(/[?#]/, 1)[0] ?? '');
  return name && name !== '.' && name !== '..' ? name : null;
}

export async function sweepOrphanImages(options: SweepOptions): Promise<{ orphans: OrphanImage[]; removed: string[]; bytes: number }> {
  const root = options.root ?? path.resolve('public/images');
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? DAY_MS;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { orphans: [], removed: [], bytes: 0 };
    throw error;
  }
  const referenced = await options.referencedNames();
  const orphans: OrphanImage[] = [];
  for (const file of entries.sort()) {
    if (file.startsWith('.') || referenced.has(file)) continue;
    const stat = await lstat(path.join(root, file));
    if (!stat.isFile() || now - stat.mtimeMs < minAgeMs) continue;
    orphans.push({ file, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  const removed: string[] = [];
  if (options.apply) {
    for (const orphan of orphans) {
      if (await options.isReferenced(orphan.file)) continue;
      await unlink(path.join(root, orphan.file));
      removed.push(orphan.file);
    }
  }
  return { orphans, removed, bytes: orphans.reduce((total, orphan) => total + orphan.bytes, 0) };
}

async function main(argv: string[]): Promise<void> {
  const apply = argv.includes('--apply');
  const ageArgument = argv.find((argument) => argument.startsWith('--min-age-hours='));
  const hours = ageArgument ? Number(ageArgument.split('=')[1]) : 24;
  if (!Number.isFinite(hours) || hours < 1) throw new Error('--min-age-hours must be at least 1');
  const { databaseService } = await import('../lib/database');
  await databaseService.connect();
  try {
    const client = databaseService.client;
    const result = await sweepOrphanImages({
      apply,
      minAgeMs: hours * 60 * 60 * 1000,
      referencedNames: async () => {
        const rows = await client.imageAsset.findMany({ select: { name: true, url: true } });
        return new Set(rows.flatMap((row) => [referencedFilename(row.name), referencedFilename(row.url)]).filter((name): name is string => Boolean(name)));
      },
      isReferenced: async (file) => Boolean(await client.imageAsset.findFirst({
        where: { OR: [{ name: file }, { name: { endsWith: `/${file}` } }, { url: { endsWith: `/${file}` } }] },
        select: { id: true },
      })),
    });
    process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', minAgeHours: hours, orphanCount: result.orphans.length, orphanBytes: result.bytes, removed: result.removed.length, orphans: result.orphans }, null, 2)}\n`);
  } finally {
    await databaseService.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error) => {
    process.stderr.write(`Image orphan sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
