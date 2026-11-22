/** Safe legacy bundle import. Preview is the default; commit requires explicit
 * source revisions, operation identity and consent to the retained report. */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { databaseService } from '../src/lib/database';
import redis from '../src/lib/redis';
import { documentService } from '../src/documents/service';
import { preserveImportOriginal, prepareLegacyBundleImport, readImportPreview, commitLegacyBundleImport } from '../src/documents/imports';
const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
async function main() {
  const bookId = Number(argument('--book-id')); const userId = Number(argument('--user-id'));
  if (!Number.isSafeInteger(bookId) || bookId < 1 || !Number.isSafeInteger(userId) || userId < 1) throw new Error('Supply an owned --book-id and --user-id. This importer never creates placeholder users or replaces existing books.');
  await databaseService.connect();
  const previewId = argument('--preview-id') ?? randomUUID();
  if (process.argv.includes('--apply')) {
    const receipt = await commitLegacyBundleImport(userId, bookId, previewId, { operationId: argument('--operation-id'), expectedRevisionId: argument('--expected-book-revision'), expectedScopes: { structure: argument('--expected-structure-revision'), canon: argument('--expected-canon-revision') }, consentReportHash: argument('--consent-report') });
    process.stdout.write(JSON.stringify(receipt) + '\n'); return;
  }
  if (process.argv.includes('--read-preview')) { process.stdout.write(JSON.stringify(await readImportPreview(userId, bookId, previewId)) + '\n'); return; }
  const sourceRoot = argument('--source-root') ?? process.env.PROSER_IMPORT_SOURCE_ROOT;
  if (!sourceRoot) throw new Error('Supply --source-root or PROSER_IMPORT_SOURCE_ROOT to preview an import.');
  const root = fs.realpathSync(sourceRoot);
  const files: Array<{ name: string; bytesBase64: string }> = []; let total = 0;
  const preserve = (name: string) => {
    const candidate = fs.realpathSync(path.join(root, name));
    if (!candidate.startsWith(root + path.sep)) throw new Error('An original source escapes the selected bundle directory.');
    const size = fs.statSync(candidate).size;
    if (files.length >= 10000 || total + size > 32 * 1024 * 1024) throw new Error('Source bundle exceeds import limits.');
    const bytes = fs.readFileSync(candidate); total += bytes.byteLength;
    if (total > 32 * 1024 * 1024) throw new Error('Source changed beyond import limits.');
    files.push({ name, bytesBase64: bytes.toString('base64') });
  };
  preserve('novel.md');
  for (const folder of ['characters','locations','lore','objects']) {
    const directory = path.join(root, folder); if (!fs.existsSync(directory)) continue;
    for (const child of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) if (child.isDirectory()) for (const name of ['entry.md','metadata.json']) if (fs.existsSync(path.join(directory, child.name, name))) preserve(`${folder}/${child.name}/${name}`);
  }
  const originalId = argument('--original-id') ?? randomUUID();
  const original = await preserveImportOriginal(userId, bookId, originalId, 'legacy-markdown-bundle-v1', Buffer.from(JSON.stringify({ schemaVersion: 1, files })));
  // Print recovery identity before conversion; malformed input still has an original.
  process.stdout.write(JSON.stringify({ original, previewId }) + '\n');
  const head = await documentService.manifest(userId, bookId);
  const preview = await prepareLegacyBundleImport(userId, bookId, { operationId: previewId, originalId, expectedRevisionId: argument('--expected-book-revision') ?? head.revisionId });
  process.stdout.write(JSON.stringify({ mode: 'preview', ...preview, expectedScopes: head.scopes }) + '\n');
}
main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : 'Import failed') + '\n'); process.exitCode = 1; }).finally(async () => { try { await databaseService.disconnect(); } finally { redis.disconnect(); } });
