import 'dotenv/config';
import { databaseService } from '@/lib/database';
import {
  loadNovaBrowserEvaluationBinding,
  NovaBrowserPlaywrightRunner,
} from '@/services/novaBrowserPlaywrightRunner';

function argument(name: string, required = true): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const allowed = new Set(['--binding', '--fixture', '--evidence-dir', '--storage-state']);
  const args = process.argv.slice(2);
  if (args.length % 2 !== 0 || args.some((value, index) => index % 2 === 0 && !allowed.has(value))) {
    throw new Error('Usage: npm run browser-run:evaluate -- --binding FILE --fixture FILE --evidence-dir DIR [--storage-state FILE]');
  }
  const binding = await loadNovaBrowserEvaluationBinding(argument('--binding')!);
  await databaseService.connect();
  try {
    const result = await new NovaBrowserPlaywrightRunner().run({
      binding,
      fixtureFile: argument('--fixture')!,
      evidenceDirectory: argument('--evidence-dir')!,
      storageStateFile: argument('--storage-state', false),
    });
    process.stdout.write(`${JSON.stringify({
      browser_run_id: result.browserRunId,
      outcome: result.terminal.outcome,
      result_sha256: result.terminal.resultSha256,
    })}\n`);
  } finally {
    await databaseService.disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
