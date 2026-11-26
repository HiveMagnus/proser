import {releaseAdmissionsOpen,admitReleaseMutation,bindReleaseAdmission,withReleaseAdmission,runReleaseProviderEffect,providerWasNotStarted} from '@/operations/releaseAdmission';
import logger from '../lib/logger';
import { databaseService } from '../lib/database';
import { publicStreamError } from '../api/utils/sse';
import { SceneProseService, type SceneProseContext } from './sceneProseService';
import {
  GenerationOutputLimitError,
  generationReplayService,
} from './generationReplayService';
import { assertSharedResourceOperationCurrent, sharedResourceExecutionOperation } from './sharedResourceService';
import { assertBookAiAllowed, isBookAiDisabledError } from '@/lib/ai/bookAiPolicy';

let supervisorTimer: ReturnType<typeof setInterval> | null = null;
let scheduling = false;
const localRuns = new Set<Promise<void>>();
const localControllers = new Map<string, AbortController>();

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

async function runOperation(operationId: string): Promise<void> {
  const claimed = await generationReplayService.getRequestForRunner(
    operationId,
    generationReplayService.instanceId,
  );
  if (!claimed) return;

  const controller = new AbortController();
  localControllers.set(operationId, controller);
  const cancellationTimer = setInterval(async () => {
    try {
      if (await generationReplayService.isCancellationRequested(operationId)) {
        controller.abort(new DOMException('Generation cancelled', 'AbortError'));
      } else if (!await generationReplayService.renewLease(operationId)) {
        controller.abort(new DOMException('Generation lease lost', 'AbortError'));
      }
    } catch (error) {
      logger.warn({ error, operationId }, 'Failed to refresh generation operation lease');
    }
  }, 1_000);
  cancellationTimer.unref();

  try {
    const request = claimed.request;
    if (claimed.route !== 'generate.prose') throw new Error('Unsupported generation operation route');
    const bookId = numberValue(request.bookId);
    if (!bookId) throw new Error('Generation operation has no book ID');
    const book = await databaseService.client.book.findFirst({
      where: { id: bookId, userId: claimed.userId },
    });
    if (!book) throw new Error('Book not found');
    await assertBookAiAllowed([bookId]);
    const delegated = await sharedResourceExecutionOperation('generation', operationId);
    if (delegated) await assertSharedResourceOperationCurrent(delegated.operationId);
    controller.signal.throwIfAborted();

    await generationReplayService.append(operationId, 'start', {
      replayLimit: generationReplayService.maxReplayEvents,
      replayByteLimit: generationReplayService.maxReplayBytes,
      outputByteLimit: generationReplayService.maxOutputBytes,
    }, generationReplayService.instanceId);

    const prompt = stringValue(request.prompt);
    const context: SceneProseContext = {
      bookId,
      sceneId: numberValue(request.sceneId),
      title: book.title || 'Untitled',
      genre: stringValue(request.genre) || book.genre || undefined,
      summary: book.summary || undefined,
      targetAudience: book.targetAudience || undefined,
      useCodexRAG: request.useCodexRAG === true || request.useCodexRAG === 1,
      codexTypes: stringList(request.codexTypes),
      codexK: numberValue(request.codexK),
      tokenBudget: numberValue(request.tokenBudget),
      instructions: stringValue(request.instructions) || prompt,
      additionalContext: prompt,
      targetWords: numberValue(request.targetWords),
      pov: stringValue(request.pov),
      tense: stringValue(request.tense),
      mustInclude: stringList(request.mustInclude),
      mustAvoid: stringList(request.mustAvoid),
      qualityMode: request.qualityMode === 'strict' ? 'strict' : undefined,
    };

    const service = SceneProseService.getInstance();
    const result = await runReleaseProviderEffect(()=>service.generateProse(context, {
      selectedModel: stringValue(request.selectedModel),
      timeoutMs: numberValue(process.env.AI_TIMEOUT_PROSE_MS) || 120_000,
      retries: 1,
      noTransportReplay:true,
      signal: controller.signal,
    }),{kind:'generation',id:operationId,bookId:context.bookId});
    controller.signal.throwIfAborted();
    if (await generationReplayService.isCancellationRequested(operationId)) {
      throw new DOMException('Generation cancelled', 'AbortError');
    }

    if (Buffer.byteLength(result.prose, 'utf8') > generationReplayService.maxOutputBytes) {
      throw new GenerationOutputLimitError();
    }
    if (delegated) await assertSharedResourceOperationCurrent(delegated.operationId);
    const artifactHash = await generationReplayService.setArtifact(operationId, result.prose);
    const chunks = result.prose.match(/.{1,180}(\s|$)/g) ?? [result.prose];
    for (const chunk of chunks) {
      controller.signal.throwIfAborted();
      if (await generationReplayService.isCancellationRequested(operationId)) {
        throw new DOMException('Generation cancelled', 'AbortError');
      }
      await generationReplayService.append(
        operationId,
        'token',
        { text: chunk },
        generationReplayService.instanceId,
      );
    }
    if (await generationReplayService.isCancellationRequested(operationId)) {
      throw new DOMException('Generation cancelled', 'AbortError');
    }
    await generationReplayService.append(operationId, 'meta', {
      wordCount: result.wordCount,
      codexUsed: result.codexUsed,
      model: result.model,
      traceId: result.traceId,
      genreKey: result.genreKey,
      recipeVersion: result.recipeVersion,
      judgeStatus: result.judgeStatus,
      adapterUsed: result.adapterUsed,
      validatorResults: result.validatorResults,
      revisionApplied: result.revisionApplied,
      terminalReason: 'stop',
      authoritative: true,
      artifactHash,
    }, generationReplayService.instanceId);
    if (delegated) await assertSharedResourceOperationCurrent(delegated.operationId);
    const terminalStatus = await generationReplayService.complete(operationId);
    if (!terminalStatus) throw new DOMException('Generation worker lease lost', 'AbortError');
  } catch (error) {
    if(providerWasNotStarted(error)){await generationReplayService.releaseLease(operationId,true);return;}
    const cancellationRequested =
      await generationReplayService.isCancellationRequested(operationId).catch(() => false);
    if (!cancellationRequested && !controller.signal.aborted) {
      const code = error instanceof GenerationOutputLimitError
        ? 'GENERATION_OUTPUT_LIMIT'
        : isBookAiDisabledError(error) ? 'BOOK_AI_DISABLED' : 'GENERATION_FAILED';
      const payload = publicStreamError(error, { operationId, route: 'generate.prose' });
      await generationReplayService.fail(operationId, code, payload.message, payload.correlationId);
      logger.error({ error, operationId }, 'Durable generation operation failed');
    } else if (!cancellationRequested) {
      await generationReplayService.releaseLease(operationId);
    }
  } finally {
    clearInterval(cancellationTimer);
    localControllers.delete(operationId);
  }
}

export async function scheduleGenerationOperations(): Promise<void> {
  if (scheduling) return;
  scheduling = true;
  try {
    if(!await releaseAdmissionsOpen())return;
    await generationReplayService.expireIdleOperations();
    while (localRuns.size < generationReplayService.maxConcurrency) {
      if(!await generationReplayService.hasPending())break;
      const admission=await admitReleaseMutation('generation-claim','pending-queue',{instanceId:generationReplayService.instanceId});
      const operationId = await generationReplayService.claimNext();
      if (!operationId) break;
      const run = withReleaseAdmission(admission.id,async()=>{await databaseService.client.$transaction(tx=>bindReleaseAdmission(tx,'generation-execution',operationId));return runOperation(operationId);})
        .catch((error) => logger.error({ error, operationId }, 'Generation runner crashed'))
        .finally(() => {
          localRuns.delete(run);
          setImmediate(() => void scheduleGenerationOperations());
        });
      localRuns.add(run);
    }
  } catch(error){if(!providerWasNotStarted(error)&&!(error instanceof Error&&'code' in error&&String(error.code).startsWith('DOCUMENT_ADMISSIONS_')))throw error;
  } finally {
    scheduling = false;
  }
}

export function startGenerationOperationSupervisor(): void {
  if (supervisorTimer) return;
  void scheduleGenerationOperations();
  supervisorTimer = setInterval(() => void scheduleGenerationOperations(), 1_000);
  supervisorTimer.unref();
}

export function stopGenerationOperationSupervisor(): void {
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = null;
  for (const controller of localControllers.values()) {
    controller.abort(new DOMException('Factory is shutting down', 'AbortError'));
  }
}
