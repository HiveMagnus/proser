#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createCommand } from './commands/create';
import { outlineCommand } from './commands/outline';
import { charactersCommand } from './commands/characters';
import { generateCommand } from './commands/generate';
import { reviewCommand } from './commands/review';
import { reviseCommand } from './commands/revise';
import { exportCommand } from './commands/export';
import { statusCommand } from './commands/status';
import { codexListCommand, codexAddCommand } from './commands/codex';
import { listCommand } from './commands/list';
import { applyCliOverrides } from './config';
import logger, { waitForLoggerDestinations } from '@/lib/logger';
import { documentOperationCommand } from './commands/documentOperation';
import { editorialCommand } from './commands/editorial';

// Global error handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught Exception');
  process.exit(1);
});

async function main(): Promise<void> {
await waitForLoggerDestinations();
yargs(hideBin(process.argv))
  .scriptName('proser-cli')
  .usage('$0 <command> [options]')
  // Global options (applied before any command)
  .option('model', {
    describe: 'Override AI model (e.g., qwen3.6-35b)',
    type: 'string',
    global: true,
  })
  .option('temperature', {
    describe: 'Override AI temperature (0.0 - 2.0)',
    type: 'number',
    global: true,
  })
  .option('inference-host', {
    describe: 'Override OpenAI-compatible inference host URL',
    type: 'string',
    global: true,
  })
  .middleware((argv) => {
    applyCliOverrides({
      model: argv.model as string | undefined,
      temperature: argv.temperature as number | undefined,
      inferenceHost: argv['inference-host'] as string | undefined,
    });
  })
  .command(createCommand)
  .command(outlineCommand)
  .command(charactersCommand)
  .command(generateCommand)
  .command(reviewCommand)
  .command(reviseCommand)
  .command(documentOperationCommand)
  .command(exportCommand)
  .command(statusCommand)
  .command(codexListCommand)
  .command(codexAddCommand)
  .command(listCommand)
  .command(editorialCommand)
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .alias('h', 'help')
  .alias('v', 'version')
  .version('1.0.0')
  .wrap(100)
  .parse();
}
void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'CLI startup failed'}\n`);
  process.exitCode = 1;
});
