import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Argv, CommandModule } from 'yargs';

import { resolveCliUser } from '../auth';
import { closeDatabase, getDb, initDatabase } from '../utils/database';
import { output } from '../utils/output';
import { editorialProfileService } from '@/services/editorial/editorialProfileService';
import { applyEditorialPatches } from '@/services/editorial/editorialApplicationService';
import { EDITORIAL_PASSES } from '@/services/editorial/passRegistry';
import { benchmarkRunner } from '@/services/editorial/qualityLab/benchmarkRunner';
import type { EditorialAutonomy, EditorialPassKey } from '@/services/editorial/contracts';
import { workflowService, TERMINAL_WORKFLOW_STATUSES } from '@/services/workflowService';
import { manuscriptRevisionService } from '@/services/manuscriptRevisionService';
import { parseEditorialScope } from '../editorialScope';

interface EditorialArgs {
  action: 'passes' | 'optimize' | 'status' | 'summary' | 'proposals' | 'apply' | 'profile-list' | 'profile-show' | 'profile-create' | 'profile-activate' | 'benchmark-run' | 'benchmark-status' | 'benchmark-report' | undefined;
  book?: number;
  scope: string;
  pass?: EditorialPassKey;
  autonomy: EditorialAutonomy;
  objective?: string;
  profile?: string;
  file?: string;
  suite: string;
  live: boolean;
  'operation-id'?: string;
  'maximum-cases': number;
  wait: boolean;
  'wait-seconds': number;
  'user-id'?: number;
  json: boolean;
  id?: string;
  candidate?: string;
  apply?: boolean;
}

async function waitForRun(userId: number, runId: string, maximumSeconds: number) {
  const deadline = Date.now() + Math.min(Math.max(maximumSeconds, 1), 600) * 1_000;
  while (Date.now() < deadline) {
    const status = await workflowService.status(userId, runId);
    if (TERMINAL_WORKFLOW_STATUSES.has(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Editorial wait bound expired; the durable run continues in the background');
}

export const editorialCommand: CommandModule<object, EditorialArgs> = {
  command: 'editorial <action> [id]',
  describe: 'Discover, launch, inspect, and benchmark autonomous editorial work',
  builder: ((yargs: Argv<object>) => yargs
    .positional('action', { choices: ['passes', 'optimize', 'status', 'summary', 'proposals', 'apply', 'profile-list', 'profile-show', 'profile-create', 'profile-activate', 'benchmark-run', 'benchmark-status', 'benchmark-report'] as const })
    .positional('id', { type: 'string', describe: 'Run, profile, or benchmark ID for inspection actions' })
    .option('book', { type: 'number', describe: 'Book ID' })
    .option('scope', { type: 'string', default: 'book', describe: 'book, act:ID, chapter:ID, or scene:ID' })
    .option('pass', { choices: ['line_edit_safe', 'dialogue', 'voice_preservation', 'scene_energy', 'continuity', 'name_originality', 'final_polish', 'custom'] as const })
    .option('autonomy', { choices: ['review_only', 'propose_only', 'safe_auto', 'max_quality_auto'] as const, default: 'safe_auto' })
    .option('objective', { type: 'string' })
    .option('profile', { type: 'string', describe: 'Editorial profile UUID' })
    .option('file', { type: 'string', describe: 'JSON profile file' })
    .option('suite', { type: 'string', default: 'editorial-deterministic' })
    .option('live', { type: 'boolean', default: false })
    .option('operation-id', { type: 'string', describe: 'Retained benchmark UUID or workflow idempotency key; reuse exactly after a lost acknowledgement.' })
    .option('maximum-cases', { type: 'number', default: 20, describe: 'Plain-text corpus bound (live total remains capped at five calls).' })
    .option('wait', { type: 'boolean', default: false, describe: 'Poll within a bounded wait instead of returning after launch' })
    .option('wait-seconds', { type: 'number', default: 300 })
    .option('candidate', { type: 'string', describe: 'Candidate UUID for explicit post-run apply' })
    .option('apply', { type: 'boolean', default: false, describe: 'Required confirmation for post-run proposal apply' })
    .option('user-id', { type: 'number' })
    .option('json', { type: 'boolean', default: false }) as unknown as Argv<EditorialArgs>),
  handler: async (argv) => {
    try {
      await initDatabase();
      const db = getDb();
      const { id: userId } = await resolveCliUser(db, argv['user-id']);
      let result: unknown;
      if (argv.action === 'passes') result = EDITORIAL_PASSES.filter((item) => item.enabled);
      else if (argv.action === 'optimize') {
        if (!argv.book || !argv.pass) throw new Error('optimize requires --book and --pass');
        const key = argv['operation-id'] ?? `cli-editorial:${randomUUID()}`;
        process.stderr.write(`Retain editorial operation ID: ${key}\n`);
        result = await workflowService.start(userId, 'editorial_optimize', {
          bookId: argv.book, scope: parseEditorialScope(argv.scope), passPack: argv.pass,
          autonomy: argv.autonomy ?? 'safe_auto', objective: argv.objective, profileId: argv.profile,
        }, undefined, true, undefined, key);
        if (argv.wait) result = await waitForRun(userId, (result as { runId: string }).runId, argv['wait-seconds'] ?? 300);
      } else if (argv.action === 'status') {
        if (!argv.id) throw new Error('status requires a run ID');
        result = await workflowService.status(userId, argv.id);
      } else if (argv.action === 'summary') {
        if (!argv.id) throw new Error('summary requires a run ID');
        result = await db.editorialRun.findFirst({ where: { workflowRunId: argv.id, workflowRun: { userId } }, select: { evidenceSummary: true, status: true, outcome: true } });
      } else if (argv.action === 'proposals') {
        if (!argv.id) throw new Error('proposals requires a run ID');
        result = await db.editorialProposal.findMany({ where: { editorialRun: { workflowRunId: argv.id, workflowRun: { userId } } }, orderBy: { createdAt: 'asc' }, take: 100, select: { id: true, scopeId: true, passKey: true, risk: true, confidence: true, status: true, skipReason: true, verificationStatus: true } });
      } else if (argv.action === 'apply') {
        if (!argv.apply || !argv.id || !argv.candidate) throw new Error('apply requires PROPOSAL_ID, --candidate ID, and explicit --apply');
        const proposal = await db.editorialProposal.findFirst({
          where: { id: argv.id, editorialRun: { workflowRun: { userId } } },
          include: { candidates: true },
        });
        if (!proposal || !proposal.scopeId) throw new Error('Editorial proposal not found');
        const candidate = proposal.candidates.find((item) => item.id === argv.candidate && item.candidateType !== 'original');
        if (!candidate) throw new Error('Editorial candidate not found');
        const current = await manuscriptRevisionService.currentAncestry(proposal.bookId);
        if (current.current !== proposal.sourceRevisionId) throw new Error('EDITORIAL_PROPOSAL_STALE');
        const applied = await applyEditorialPatches({
          userId, bookId: proposal.bookId, expectedRevisionId: proposal.sourceRevisionId,
          patches: [{
            sceneId: proposal.scopeId, originalText: proposal.originalText, candidateText: candidate.outputText,
            sourceHash: proposal.sourceHash, startOffset: proposal.startOffset, endOffset: proposal.endOffset,
            beforeAnchor: proposal.beforeAnchor, afterAnchor: proposal.afterAnchor,
            protectedElements: proposal.protectedClaims as string[], maxChangedPercent: 25,
          }],
        });
        await db.editorialProposal.update({ where: { id: proposal.id }, data: {
          status: 'optionally_applied', appliedRevisionId: applied.revisionId, verificationStatus: 'passed',
        } });
        result = { proposalId: proposal.id, resultRevisionId: applied.revisionId, applied: true };
      } else if (argv.action === 'profile-list') result = await editorialProfileService.list(userId);
      else if (argv.action === 'profile-show') {
        if (!argv.id) throw new Error('profile-show requires a profile ID');
        result = await editorialProfileService.owned(userId, argv.id);
      } else if (argv.action === 'profile-create') {
        if (!argv.file) throw new Error('profile-create requires --file');
        const profile = JSON.parse(await readFile(argv.file, 'utf8')) as { name: string; bookId?: number; config: Record<string, unknown>; active?: boolean };
        result = await editorialProfileService.create(userId, profile);
      } else if (argv.action === 'profile-activate') {
        if (!argv.book || !argv.profile) throw new Error('profile-activate requires --book and --profile');
        result = await editorialProfileService.activate(userId, argv.book, argv.profile);
      } else if (argv.action === 'benchmark-run') {
        const key = argv['operation-id'] ?? `cli-benchmark:${randomUUID()}`;
        if (!Number.isSafeInteger(argv['maximum-cases']) || argv['maximum-cases'] < 1 || argv['maximum-cases'] > 50) throw new Error('--maximum-cases must be between 1 and 50');
        process.stderr.write(`Retain benchmark operation ID: ${key}\n`);
        result = await benchmarkRunner.run(userId, key, { suiteKey: argv.suite, passKey: argv.pass, live: argv.live, maximumCases: argv['maximum-cases'] });
      } else if (argv.action === 'benchmark-status' || argv.action === 'benchmark-report') {
        if (!argv.id) throw new Error(`${argv.action} requires a benchmark run ID`);
        result = await db.evaluationRun.findFirst({ where: { id: argv.id, userId }, select: argv.action === 'benchmark-report' ? { id: true, status: true, reportHash: true, report: true } : { id: true, status: true, suiteKey: true, suiteVersion: true, metrics: true, reportHash: true } });
      }
      if (argv.json) output.json(result);
      else {
        output.section('Editorial');
        output.json(result);
      }
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  },
};
