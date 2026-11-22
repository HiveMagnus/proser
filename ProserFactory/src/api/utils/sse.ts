import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { InferenceTerminalError } from '@/lib/ai/terminalReason';
import logger from '@/lib/logger';

export type PublicStreamErrorCode =
  | 'STREAM_TRUNCATED'
  | 'STREAM_BLOCKED'
  | 'STREAM_PROTOCOL_ERROR'
  | 'STREAM_UNAVAILABLE'
  | 'STREAM_FAILED';

const publicMessages: Record<PublicStreamErrorCode, string> = {
  STREAM_TRUNCATED: 'Generation stopped before the response was complete.',
  STREAM_BLOCKED: 'Generation was blocked and requires review.',
  STREAM_PROTOCOL_ERROR: 'Generation ended with an invalid response.',
  STREAM_UNAVAILABLE: 'Generation is temporarily unavailable.',
  STREAM_FAILED: 'Generation could not be completed.',
};

export function writeSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writePublicStreamError(
  res: Response,
  error: unknown,
  context: { operationId: string; route: string },
): string {
  const payload = publicStreamError(error, context);
  writeSseEvent(res, 'error', payload);
  return payload.correlationId;
}

export function publicStreamError(
  error: unknown,
  context: { operationId: string; route: string },
): { operationId: string; code: PublicStreamErrorCode; message: string; correlationId: string; partial: 'discard' } {
  const correlationId = randomUUID();
  let code: PublicStreamErrorCode = 'STREAM_FAILED';
  if (error instanceof InferenceTerminalError) {
    if (error.code === 'INFERENCE_TRUNCATED') code = 'STREAM_TRUNCATED';
    else if (error.code === 'INFERENCE_BLOCKED') code = 'STREAM_BLOCKED';
    else code = 'STREAM_PROTOCOL_ERROR';
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (/protocol|malformed|premature eof|terminal/i.test(message)) code = 'STREAM_PROTOCOL_ERROR';
    else if (/unavailable|timeout|circuit|ECONN|HTTP 5\d\d/i.test(message)) code = 'STREAM_UNAVAILABLE';
  }
  logger.error({ error, correlationId, ...context }, 'Generation stream failed');
  return {
    operationId: context.operationId,
    code,
    message: publicMessages[code].slice(0, 160),
    correlationId,
    partial: 'discard',
  };
}
