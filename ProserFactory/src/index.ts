import { createApp, startServer, shutdown } from './server';
import logger from './lib/logger';
import { initTelemetry, shutdownTelemetry } from './telemetry';

const PORT = process.env.PORT || 3001;
const app = createApp();

if (process.env.NODE_ENV !== 'test') {
  // Initialize OpenTelemetry before starting the server (no-op unless OTEL_ENABLED=true)
  initTelemetry()
    .then(() => startServer(PORT, app))
    .catch((error) => {
    logger.error({ error: error.message }, 'Unhandled error during startup');
      process.exit(1);
    });

  process.on('SIGTERM', async () => { logger.info('SIGTERM received, shutting down gracefully'); await shutdown(); await shutdownTelemetry(); process.exit(0); });
  process.on('SIGINT', async () => { logger.info('SIGINT received, shutting down gracefully'); await shutdown(); await shutdownTelemetry(); process.exit(0); });
}

export default app;
