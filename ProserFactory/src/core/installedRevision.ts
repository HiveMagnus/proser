import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The native release file takes precedence over historical environment labels. */
export function installedRevision(filename = path.resolve(process.cwd(), 'REVISION')): string | undefined {
  let revision: string;
  try { revision = readFileSync(filename, 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error('Installed Factory revision is invalid; reconcile the release before starting services.');
  return revision.toLowerCase();
}
