import 'dotenv/config';
import { databaseService } from '../src/lib/database';
import redis from '../src/lib/redis';
import { backfillSelectedArtwork } from '../src/documents/selectedAssetBackfill';
import { documentService } from '../src/documents/service';
import { structureSelections } from '../src/documents/selectedAssets';
import { randomUUID } from 'node:crypto';

async function main() {
  const bookId = Number(process.argv.find((argument) => argument.startsWith('--book='))?.slice(7));
  if (!Number.isSafeInteger(bookId) || bookId < 1) throw new Error('Specify one owned --book=ID.');
  await databaseService.connect();
  const book = await databaseService.client.book.findFirstOrThrow({ where: { id: bookId, deletedAt: {} }, select: { userId: true } });
  const apply = process.argv.includes('--apply');
  const registration = await backfillSelectedArtwork(book.userId, bookId, apply);
  let structureUpgrade: { operationId: string; revisionId: string } | undefined;
  const head = await databaseService.client.bookDocumentHead.findUnique({ where: { bookId }, select: { revisionId: true } });
  if (apply && head) {
    const scope = await documentService.scope(book.userId, bookId, 'structure');
    if (registration.changed || structureSelections(scope.content).some((selection) => selection.selectedImageId !== 0 && (!selection.selectedImageAsset || selection.selectedImageAsset.width === undefined || selection.selectedImageAsset.height === undefined))) {
      const receipt = await documentService.mutateCatalog(book.userId, bookId, { operationId: randomUUID(), expectedRevisionId: head.revisionId, expectedScopes: { structure: scope.revisionId }, payload: { command: 'upgrade-selected-artwork-references' } }, async () => ({ result: null }));
      structureUpgrade = { operationId: receipt.operationId, revisionId: receipt.revisionId };
    }
  }
  process.stdout.write(JSON.stringify({ ...registration, ...(structureUpgrade ? { structureUpgrade } : {}) }) + '\n');
}
main().catch(() => { process.stderr.write('Selected artwork backfill failed; inspect private operator logs. Authority was not activated.\n'); process.exitCode = 1; }).finally(async () => { try { await databaseService.disconnect(); } finally { redis.disconnect(); } });
