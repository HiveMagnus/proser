import 'dotenv/config';
import { databaseService } from '@/lib/database';
import { browserRunReceiptExporter } from '@/services/browserRunReceiptService';

async function main(): Promise<void> {
  const [browserRunId, mode] = process.argv.slice(2);
  if (!browserRunId || (mode && mode !== '--materialize-existing')) {
    throw new Error('Usage: npm run browser-receipt:export -- <browser-run-id> [--materialize-existing]');
  }
  await databaseService.connect();
  try {
    if (mode === '--materialize-existing') {
      process.stdout.write(`${await browserRunReceiptExporter.materializeExisting(browserRunId)}\n`);
      return;
    }
    const result = await browserRunReceiptExporter.export(browserRunId);
    process.stdout.write(`${result.path}\n`);
  } finally {
    await databaseService.disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
