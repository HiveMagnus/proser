import pino from 'pino';
import { context, trace } from '@opentelemetry/api';
import fs from 'fs';
import path from 'path';

const isTest = process.env.NODE_ENV === 'test';

// Resolve log directory and files from env
const LOG_DIR = process.env.PROSER_LOG_DIR || process.env.LOG_DIR || '/tmp/proser';
const APP_LOG_FILE = process.env.PROSER_APP_LOG_FILE || 'backend.log';
const PROMPT_LOG_FILE = process.env.PROSER_PROMPT_LOG_FILE || 'prompts.log';

// Helper to add date suffix (YYYYMMDD) before extension (or append .log)
function withDateSuffix(fileName: string, d: Date = new Date()): string {
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const parsed = path.parse(fileName);
  const base = parsed.name; // without extension
  const ext = parsed.ext || '.log';
  return `${base}-${ymd}${ext}`;
}

// Ensure directory exists (best effort)
try { fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 }); } catch {}

const appLogDest = pino.destination({ dest: path.join(LOG_DIR, withDateSuffix(APP_LOG_FILE)), sync: false });
const promptLogPath = path.join(LOG_DIR, withDateSuffix(PROMPT_LOG_FILE));
const promptLogDest = pino.destination({ dest: promptLogPath, sync: false });
// CLI help/version may exit before asynchronous file descriptors open. Register
// all logger destinations at construction; services keep asynchronous logging.
const loggerDestinationReadiness: Promise<void>[] = [];
export function registerLoggerDestination(destination: ReturnType<typeof pino.destination>): void {
  const readyPromise = new Promise<void>((resolve, reject) => {
    const ready = () => { destination.off('error', failed); resolve(); };
    const failed = (error: Error) => { destination.off('ready', ready); reject(error); };
    destination.once('ready', ready);
    destination.once('error', failed);
  });
  void readyPromise.catch(() => undefined);
  loggerDestinationReadiness.push(readyPromise);
}
registerLoggerDestination(appLogDest);
registerLoggerDestination(promptLogDest);
export async function waitForLoggerDestinations(): Promise<void> {
  await Promise.all(loggerDestinationReadiness);
}

try {
  fs.chmodSync(promptLogPath, 0o600);
  const retentionHours = Math.max(1, Number.parseInt(process.env.AI_PROMPT_LOG_RETENTION_HOURS ?? '24', 10) || 24);
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const parsed = path.parse(PROMPT_LOG_FILE);
  for (const entry of fs.readdirSync(LOG_DIR)) {
    if (!entry.startsWith(`${parsed.name}-`) || path.extname(entry) !== (parsed.ext || '.log')) continue;
    const target = path.join(LOG_DIR, entry);
    if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
  }
} catch {}

const baseConfig: pino.LoggerOptions = {
  level: isTest ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    // Attach trace/span ids if a span is active
    try {
      const span = trace.getSpan(context.active());
      const spanContext = span?.spanContext();
      if (spanContext) {
        return {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
        };
      }
    } catch {
      // ignore if no context
    }
    return {};
  }
};

// Main application logger -> file
const logger = pino(baseConfig, appLogDest);

// Dedicated prompts logger -> separate file
const promptLogger = pino({ ...baseConfig, level: isTest ? 'silent' : 'info' }, promptLogDest);

export default logger;
export { promptLogger };
