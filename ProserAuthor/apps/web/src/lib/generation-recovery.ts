import {
  getGenerationArtifact,
  lookupGenerationOperation,
  type GenerationOperationReceipt,
} from './api';
import { updateGenerationReceipt, type RetainedGenerationReceipt } from './generation-receipts';

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function recoverGenerationReceipt(
  record: RetainedGenerationReceipt,
): Promise<GenerationOperationReceipt> {
  const operation = await lookupGenerationOperation(record.idempotencyKey);
  if (operation.status === 'completed') {
    const recovered = await getGenerationArtifact(operation.operationId);
    if (
      recovered.operation.operationId !== operation.operationId ||
      !operation.artifactHash ||
      recovered.operation.artifactHash !== operation.artifactHash ||
      (await sha256Hex(recovered.artifact)) !== operation.artifactHash
    ) {
      throw new Error('Completed generation artifact failed verification');
    }
    updateGenerationReceipt(record.idempotencyKey, {
      state: 'completed',
      operationId: operation.operationId,
      operationStatus: operation.status,
      artifact: recovered.artifact,
      artifactHash: operation.artifactHash,
      terminalMessage: 'Generation completed while this page was away.',
    });
    return operation;
  }
  if (operation.status === 'failed' || operation.status === 'cancelled') {
    updateGenerationReceipt(record.idempotencyKey, {
      state: operation.status,
      operationId: operation.operationId,
      operationStatus: operation.status,
      terminalMessage:
        operation.status === 'failed'
          ? `Generation failed${operation.errorCode ? ` (${operation.errorCode})` : ''}.`
          : 'Generation was cancelled.',
    });
    return operation;
  }
  updateGenerationReceipt(record.idempotencyKey, {
    state: record.state === 'watching' ? 'watching' : 'detached',
    operationId: operation.operationId,
    operationStatus: operation.status,
  });
  return operation;
}
