/** Explicit historical preview / consented conversion. Never rewrites evidence. */
import 'dotenv/config';
import { databaseService } from '../src/lib/database';
import redis from '../src/lib/redis';
import { previewLegacyHistory, convertLegacyHistory } from '../src/documents/legacyHistory';
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const userId = Number(value('--user-id')); const bookId = Number(value('--book-id')); const revisionId = value('--revision-id');
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(bookId) || bookId < 1 || !revisionId || !/^[a-f0-9-]{36}$/.test(revisionId)) throw new Error('Required --user-id, --book-id and exact --revision-id.');
  await databaseService.connect();
  if (args.includes('--apply')) {
    const consent = value('--consent-report');
    if (!consent || !/^[a-f0-9]{64}$/.test(consent)) throw new Error('Required exact --consent-report SHA256 from preview.');
    process.stdout.write(JSON.stringify({ mode: 'apply', documentRevisionId: await convertLegacyHistory(userId, bookId, revisionId, consent) }) + '\n');
  } else process.stdout.write(JSON.stringify(await previewLegacyHistory(userId, bookId, revisionId)) + '\n');
}
main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : 'Historical conversion failed.') + '\n'); process.exitCode = 1; }).finally(async () => { try { await databaseService.disconnect(); } finally { redis.disconnect(); } });
