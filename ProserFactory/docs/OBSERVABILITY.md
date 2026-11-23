# Observability (OpenTelemetry)

This guide pairs a native Factory development process with an OpenTelemetry
Collector and Jaeger on loopback. Run the commands from `ProserFactory/`.
For Factory in the [root Compose stack](../../docs/COMPOSE.md), supply the
telemetry settings in a private Compose override for the API and worker and
use a collector endpoint reachable from those containers.

## Env variables

Set these when running the backend to enable OTel (e.g., in `.env.local`):

- OTEL_ENABLED=true
- OTEL_SERVICE_NAME=proser-factory
- OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
- OTEL_TRACES_SAMPLER=parentbased_traceidratio
- OTEL_TRACES_SAMPLER_ARG=1.0

Optional proxies:

- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
- OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
- OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs

## Start local Collector + Jaeger

```bash
docker compose -f docker-compose.observability.yml up -d
```

Open [Jaeger](http://localhost:16686).

## Run backend against the collector

Ensure the env vars above are set, then run the backend with `npm run dev` (and `npm run worker` from a built checkout when workflow-worker telemetry is required).

Expect to see:

- HTTP/Express spans for API routes
- Prisma DB spans
- Workflow-run API spans and worker logs
- Metrics at Collector's Prometheus endpoint: http://localhost:8889/metrics

## Dashboards and Alerts

The retired Wizard queue dashboard and alerts were removed with the legacy orchestrator. Workflow v1 exposes durable heartbeat, progress, retry, task, event, and checkpoint state through its authenticated API and the Book Factory UI. The provided `docker-compose.observability.yml` still scrapes the Collector's Prometheus exporter on port 8889 for HTTP, process, and custom application telemetry.

## Health and readiness endpoints

- Liveness: `GET /health`
  - Returns enriched status with DB/Redis sub-status, build/version metadata.
  - 200 when DB and Redis are healthy; 503 if a dependency is down.

- Readiness: `GET /api/readiness`
  - Checks DB and Redis, but treats Redis as optional when not configured.
  - Response shape: `{ success: boolean, data: { db: { status }, redis: { status }, ready: boolean } }`
  - Status codes:
    - 200 when DB is healthy AND (Redis is healthy OR disabled)
    - 503 otherwise

Notes

- Redis is considered "disabled" if `REDIS_URL` (or `REDIS_HOST`) is not set. This allows local/dev/test runs without Redis to be Ready while still exposing liveness nuance on `/health`.
- Logs include `trace_id`/`span_id` for trace correlation.
- Adjust sampling with `OTEL_TRACES_SAMPLER[_ARG]` to reduce volume.

## Rate limiting semantics (client-facing)

The API enforces per-user rate limiting and returns standardized headers when a request is limited:

- `Retry-After`: Seconds to wait before retrying
- `X-RateLimit-Limit`: Total requests allowed in the window
- `X-RateLimit-Remaining`: Requests remaining in the current window
- `X-RateLimit-Reset`: Epoch seconds when the window resets

Deployment verification calls the internal-secret-protected
`POST /api/auth/diagnostics/rate-limit`. It runs the same atomic Redis consume
primitive with a disposable diagnostic key, reports the exact allowed and
rejected counts plus reset time, verifies an ordinary-style namespace remained
untouched, and deletes its probe key. It does not invoke inference or consume a
user route budget.

Error envelope on 429:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "details": {}
  }
}
```

UI behavior

- The UI HTTP client automatically handles 429s by reading `Retry-After`, applying a bounded backoff, and retrying up to 3 attempts. No changes are needed in callers.
- For long-running actions, surface a friendly toast if retries are exhausted; this is already standardized via `getErrorMessage`.

## Metrics endpoints (backend and UI ingest)

- `GET /api/metrics`
  - Returns a Redis-backed JSON summary of incrementally maintained timings and
    counters shared by API and worker processes, without scanning workflow
    tables at scrape time.
  - Production startup fails unless `METRICS_TOKEN` is configured. Scrapers
    must send it in the `x-metrics-token` header. Credential verification uses
    a constant-time digest comparison, and repeated failures are rate limited
    per source without logging or echoing the supplied token.
  - `inferenceOutcomes` separates provider failures, protocol failures, truncations, terminal-policy rejections, and content-filter outcomes; the same classifications are exported through the `inference.outcomes.total` OpenTelemetry counter.

- `POST /api/metrics/ingest`
  - Accepts batched UI events: `{ events: MetricEvent[] }`.
  - The UI metrics client buffers and flushes with backoff; failures are retried with short delays, and a pause window is observed to avoid thundering herds.

## Tracing correlation

- Pino logs include `trace_id` and `span_id` when telemetry is enabled, allowing you to pivot from logs to traces.
- In Jaeger, select service `proser-factory` and search by operation or time window; use the IDs from logs to locate specific traces.

## Validation checklist

1. Collector and Jaeger are up, and backend is started with OTEL env vars set.
2. Hit `/health` and confirm JSON shows `services.database.status === 'healthy'` and Redis status reflects your environment.
3. Hit `/api/readiness` and confirm:
   - 200 if DB is healthy and Redis is healthy or disabled
   - 503 otherwise
4. Trigger a burst of API calls to observe a 429 response; verify headers `Retry-After` and `X-RateLimit-*` are present and that the UI gracefully retries.
5. Open Jaeger and confirm route spans and Prisma spans are visible.

## Notes

- Telemetry is gated by `OTEL_ENABLED`. Without it, the app runs normally.
- Standardized error responses follow `{ success: false, error: { code, message, details? } }`.
- For streaming/generation features, consider SSE for progressive updates; if enabled, monitor route spans and client log timings to assess TTFB improvements.
- For targeted AI debugging, `AI_CAPTURE_REASONING_ENABLED=true` preserves provider reasoning and token usage in server-side debug metadata/logs only. Leave it off by default because it may record hidden chain-of-thought.
