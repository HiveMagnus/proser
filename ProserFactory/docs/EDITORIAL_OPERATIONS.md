# Editorial operations

## Readiness and observability

`GET /api/readiness` validates the pass registry and benchmark corpus.
`GET /api/metrics` includes bounded, Redis-backed, incrementally maintained
editorial counters shared by the API and worker for starts, terminal outcomes,
application/skips, and duration. It does not scan editorial workflow tables at
scrape time. Production requires a
dedicated `METRICS_TOKEN`, supplied by scrapers through `x-metrics-token`.
The credential is timing-safe and failed scrapes are throttled. Terminal
editorial counters are published inside the same lease-checked transaction as
workflow completion, so a recovered stale worker cannot emit them. Workflow
events and artifacts are the detailed audit trail; logs must use IDs and hashes
rather than full prose.

Key production controls:

```text
EDITORIAL_MAX_ACTIVE_PER_USER=2
EDITORIAL_MAX_ACTIVE_GLOBAL=8
EDITORIAL_MAX_PROPOSALS=100
EDITORIAL_MAX_CANDIDATES_PER_PROPOSAL=2
EDITORIAL_MAX_CHANGED_PERCENT_SCENE=18
EDITORIAL_MAX_CHANGED_PERCENT_TOTAL=12
EDITORIAL_MAX_JUDGE_ESCALATIONS=1
EDITORIAL_MAX_INFERENCE_TOKENS=100000
EDITORIAL_MIN_CONFIDENCE=0.78
EDITORIAL_MIN_PREFERENCE_MARGIN=0.15
EDITORIAL_REFERENCE_OVERLAP_THRESHOLD=0.32
EDITORIAL_LIVE_BENCHMARK_TIMEOUT_MS=45000
```

Request budgets can only reduce or remain within server ceilings. Worker
leases, heartbeats, bounded deliveries, and the existing recovery sweeper apply
without a separate queue.

## Deploy and verify

```bash
bash scripts/deploy-to-proser.sh
bash scripts/deploy-hermes-proser-plugin-ubuntu24.sh --host agent-host --skip-env
```

The Factory deploy stops API then worker, starts and health-checks Compose
PostgreSQL, applies Prisma migrations and benchmark fixtures, creates a
checksummed `pg_dump` checkpoint, restarts both services, runs authenticated
smoke tests, and checks `REVISION`. It requires a PostgreSQL cutover receipt;
normal deployment never replaces a populated target based on missing local
state. The explicit `--record-existing-cutover <operation-id>` maintenance flow
checks source/checkpoint hashes, full row and key digests, null/aggregate
reports, target relationships, and representative reads before it records the
database receipt and signed evidence. Use the configured Hermes hosts from
`.env`; the plugin deploy validates discovery and its revision.

`--rotate-cutover-evidence-key <operation-id>` is a maintenance-only recovery
for a lost host HMAC key. It does not replace the receipt or import data: while
both services are quiesced, it verifies the matching receipt/evidence copies,
SQLite source SHA and embedded report, current database relationships and
representative reads, archives the old evidence, and installs a new signature.
Without that explicit option, any HMAC mismatch remains fatal.

For an incident, inspect `proser-factory` and `proser-worker`, the workflow
status/events, EditorialRun outcome, proposal skip reasons, source/result
revision ancestry, verification artifacts, and automatic rollback events.
Never repair a stale result by directly updating `Scene.prose`. Restore an
immutable revision or repeat the request with the same idempotency key when the
status says it is safe.
