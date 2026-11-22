import type { Response } from 'express';

import type { ApiResponse, AuthenticatedRequest } from '../types';
import { respondError, respondSuccess, ErrorCodes } from '../utils/response';
import { proseTraceService } from '../../services/proseTraceService';
import logger from '../../lib/logger';
import { writePublicStreamError, writeSseEvent } from '../utils/sse';

export class ProseController {
  static async getTrace(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const traceId = String(req.params.traceId);
    const trace = await proseTraceService.getTraceForUser(userId, traceId);
    if (!trace) {
      respondError(res, ErrorCodes.NOT_FOUND, 'Prose trace not found', 404);
      return;
    }
    respondSuccess(res, trace);
  }

  static async streamTrace(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const traceId = String(req.params.traceId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    let lastSnapshot = '';

    const sendCurrentTrace = async () => {
      const trace = await proseTraceService.getTraceForUser(userId, traceId);
      if (!trace) {
        writeSseEvent(res, 'error', { message: 'Prose trace not found' });
        writeSseEvent(res, 'done', '[DONE]');
        res.end();
        closed = true;
        return;
      }

      const nextSnapshot = JSON.stringify(trace);
      if (nextSnapshot !== lastSnapshot) {
        lastSnapshot = nextSnapshot;
        writeSseEvent(res, 'trace', trace);
      }

      if (trace.status === 'ready' || trace.status === 'failed') {
        writeSseEvent(res, 'done', '[DONE]');
        res.end();
        closed = true;
      }
    };

    try {
      await sendCurrentTrace();
      if (closed) return;

      const poll = setInterval(() => {
        if (closed) return;
        void sendCurrentTrace().catch((error) => {
          logger.warn({ error, traceId }, 'Failed to stream prose trace update');
          if (!closed) {
            writePublicStreamError(res, error, { operationId: traceId, route: 'prose.trace.stream' });
            res.end();
            closed = true;
          }
        });
      }, 1000);

      const heartbeat = setInterval(() => {
        if (!closed) {
          writeSseEvent(res, 'ping', 'keepalive');
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(poll);
        clearInterval(heartbeat);
      });
    } catch (error) {
      if (!closed) {
        writePublicStreamError(res, error, { operationId: traceId, route: 'prose.trace.stream' });
        res.end();
      }
    }
  }

  static async getLatestTraceForScene(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = Number(req.params.bookId);
    const sceneId = Number(req.params.sceneId);
    const trace = await proseTraceService.getLatestTraceForScene(userId, bookId, sceneId);
    respondSuccess(res, trace);
  }

  static async getBookQualityOverview(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = Number(req.params.bookId);
    const overview = await proseTraceService.getBookQualityOverview(userId, bookId);
    respondSuccess(res, overview);
  }

  static async submitPreference(req: AuthenticatedRequest, res: Response<ApiResponse>): Promise<void> {
    const userId = req.user!.id;
    const bookId = Number(req.params.bookId);
    const sceneId = Number(req.params.sceneId);
    const { traceId, compareCardId, chosen, applyChosen, rationale, operationId, expectedRevisionId, expectedSceneRevisionId, validationId } = req.body as {
      traceId: string;
      compareCardId: number;
      chosen: 'a' | 'b';
      applyChosen: boolean;
      rationale?: string;
      operationId?: string; expectedRevisionId?: string; expectedSceneRevisionId?: string; validationId?: string;
    };

    const trace = await proseTraceService.recordPreference({
      userId,
      bookId,
      sceneId,
      traceId,
      compareCardId,
      chosen,
      applyChosen,
      rationale,
      operationId, expectedRevisionId, expectedSceneRevisionId, validationId,
    });

    if (!trace) {
      respondError(res, ErrorCodes.NOT_FOUND, 'Preference target not found', 404);
      return;
    }

    respondSuccess(res, trace);
  }
}
