import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';

let sdk: NodeSDK | null = null;

function isEnabled() {
  const v = (process.env.OTEL_ENABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export async function initTelemetry() {
  if (!isEnabled()) return;

  const serviceName = process.env.OTEL_SERVICE_NAME || 'proser-factory';
  const serviceVersion = process.env.npm_package_version || '0.0.0';
  const environment = process.env.NODE_ENV || 'development';

  // Ensure service attributes are visible via env to default resource detectors
  process.env.OTEL_SERVICE_NAME = serviceName;
  process.env.OTEL_RESOURCE_ATTRIBUTES = [
    `service.version=${serviceVersion}`,
    `deployment.environment=${environment}`,
  ].join(',');

  // Prefer explicit traces endpoint, else derive from base endpoint
  const tracesUrl = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`
      : 'http://localhost:4318/v1/traces');

  const traceExporter = new OTLPTraceExporter({ url: tracesUrl });

  // Metrics setup (optional, controlled by OTEL_METRICS_ENABLED)
  const metricsEnabled = ((process.env.OTEL_METRICS_ENABLED || '').toLowerCase() === 'true') ||
    (process.env.OTEL_METRICS_ENABLED === '1');
  let metricReader: PeriodicExportingMetricReader | undefined;
  if (metricsEnabled) {
    const metricsUrl = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
      || (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/metrics`
        : 'http://localhost:4318/v1/metrics');
    const metricExporter = new OTLPMetricExporter({ url: metricsUrl });
    metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter });
  }

  // Logs setup (optional, controlled by OTEL_LOGS_ENABLED)
  const logsEnabled = ((process.env.OTEL_LOGS_ENABLED || '').toLowerCase() === 'true') ||
    (process.env.OTEL_LOGS_ENABLED === '1');
  let logRecordProcessor: BatchLogRecordProcessor | undefined;
  if (logsEnabled) {
    const logsUrl = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      || (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/logs`
        : 'http://localhost:4318/v1/logs');
    const logExporter = new OTLPLogExporter({ url: logsUrl });
    logRecordProcessor = new BatchLogRecordProcessor({ exporter: logExporter });
  }

  sdk = new NodeSDK({
    traceExporter,
    metricReaders: metricReader ? [metricReader] : [],
    logRecordProcessors: logRecordProcessor ? [logRecordProcessor] : [],
    instrumentations: [
      new PrismaInstrumentation(),
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  // Start SDK first
  await sdk.start();
}

export async function shutdownTelemetry() {
  try {
    if (sdk) {
      await sdk.shutdown();
      sdk = null;
    }
  } catch {
    // ignore
  }
}
