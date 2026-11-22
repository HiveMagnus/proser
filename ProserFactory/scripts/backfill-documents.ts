/** Explicit, restart-safe backfill. Never trim or overwrite original prose. */
import 'dotenv/config';
import { databaseService } from '../src/lib/database';
import redis from '../src/lib/redis';
import { documentService } from '../src/documents/service';
async function main() {
  await databaseService.connect();
  const apply = process.argv.includes('--apply');
  const books = await databaseService.client.book.findMany({ where: { deletedAt: {} }, select: { id: true, userId: true, deletedAt: true } });
  let existing = 0; let missing = 0;
  for (const book of books) {
    const head = await databaseService.client.bookDocumentHead.findUnique({ where: { bookId: book.id } });
    if (head) existing++; else missing++;
    if (apply) await documentService.initialize(book.userId, book.id, { includeDeleted: true, source: 'operator-backfill' });
  }
  process.stdout.write(JSON.stringify({ mode: apply ? 'apply' : 'preview', books: books.length, active: books.filter((book) => !book.deletedAt).length, archived: books.filter((book) => book.deletedAt).length, existing, missing }) + '\n');
}
main().catch(() => { process.stderr.write('Document backfill failed. Inspect private operator logs; authority was not activated.\n'); process.exitCode = 1; }).finally(async () => { try { await databaseService.disconnect(); } finally { redis.disconnect(); } });
