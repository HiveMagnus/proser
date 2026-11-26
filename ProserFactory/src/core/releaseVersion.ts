import { readFileSync } from 'node:fs';
import path from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function readTrimmed(filename: string): string | undefined {
  try { return readFileSync(filename, 'utf8').trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/**
 * The Proser release this process belongs to. Release images carry the tag
 * version in a VERSION file next to REVISION; source checkouts fall back to
 * the Factory package version, which releases keep equal to the tag.
 */
export function releaseVersion(directory = process.cwd()): string {
  const stamped = readTrimmed(path.resolve(directory, 'VERSION'));
  if (stamped) {
    if (!SEMVER.test(stamped)) throw new Error('Installed Proser VERSION is invalid; reconcile the release before starting services.');
    return stamped;
  }
  try {
    const manifest = JSON.parse(readTrimmed(path.resolve(directory, 'package.json')) ?? '{}') as { version?: unknown };
    if (typeof manifest.version === 'string' && SEMVER.test(manifest.version)) return manifest.version;
  } catch { /* An unreadable manifest leaves the version unknown. */ }
  return 'unknown';
}
