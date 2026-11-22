import { Request, Response } from 'express';
import logger from '../../lib/logger';
import { ValidationError } from '../../lib/errors';

type MetricEvent = {
  name: string;
  bookId?: number;
  value?: number;
  timestamp?: string;
};

const ALLOWED_KEYS = new Set(['name', 'bookId', 'value', 'timestamp']);
function isEvent(obj: unknown): obj is MetricEvent {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const event = obj as Record<string, unknown>;
  if (!Object.keys(event).every((key) => ALLOWED_KEYS.has(key))) return false;
  if (typeof event.name !== 'string' || !/^storyboard\.[a-z0-9_.-]{1,80}$/i.test(event.name)) return false;
  if (event.bookId !== undefined && (!Number.isSafeInteger(event.bookId) || Number(event.bookId) < 1)) return false;
  if (event.value !== undefined && (typeof event.value !== 'number' || !Number.isFinite(event.value))) return false;
  if (event.timestamp !== undefined && (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)))) return false;
  return true;
}

export const MetricsController = {
  ingest(req: Request, res: Response) {
    const body = req.body;
    if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events)) {
      throw new ValidationError('Invalid body: expected { events: MetricEvent[] }');
    }
    const events = (body as { events: unknown[] }).events;
    if (events.length < 1 || events.length > 50) {
      throw new ValidationError('events must contain between 1 and 50 entries');
    }
    if (!events.every(isEvent)) {
      throw new ValidationError('Each event must match the bounded storyboard metric schema');
    }
    // Log for now; future: emit to OTEL/custom sink
    for (const e of events as MetricEvent[]) {
      logger.info({ metric: e }, 'metric_event');
    }
    return res.status(204).end();
  }
};
