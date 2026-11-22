/** Word counts are derived authority. Preview is the default; apply uses the
 * complete document backfill and rejects drift on already migrated books. */
import 'dotenv/config';
import { databaseService } from '../src/lib/database';
import redis from '../src/lib/redis';
import { documentService } from '../src/documents/service';
async function main() {
  await databaseService.connect();
  const apply = process.argv.includes('--apply');
  const books = await databaseService.client.book.findMany({ where: { deletedAt: {} }, select: { id: true, userId: true, deletedAt: true } });
  const report = [];
  for (const book of books) {
    const head = await databaseService.client.bookDocumentHead.findUnique({ where: { bookId: book.id }, select: { revisionId: true } });
    if (apply) await documentService.initialize(book.userId, book.id, { includeDeleted: true, source: 'operator-backfill' });
    report.push({ bookId: book.id, archived: book.deletedAt !== null, status: head ? 'verify-existing-authority' : 'initialize-preserved-authority' });
  }
  process.stdout.write(JSON.stringify({ mode: apply ? 'apply' : 'preview', books: report }) + '\n');
}
main().catch(() => { process.stderr.write('Projection backfill failed; reconcile retained document evidence before retrying.\n'); process.exitCode = 1; }).finally(async () => { try { await databaseService.disconnect(); } finally { redis.disconnect(); } });
