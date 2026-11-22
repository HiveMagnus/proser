# ADR 004 — BullMQ for Background Processing

**Status:** Superseded
**Date:** 2025-01-15

> Background workers now live in ProserFactory. Its Workflow v1 worker uses BullMQ, but ProserAuthor must not run `apps/worker` or `proser-v2-worker`.

## Context

Several Proser operations are long-running: book-creation wizard workflows (multi-step AI generation), factory pipelines (bulk content creation), quality analysis, and vector indexing. These must not block HTTP requests.

## Decision

Use **BullMQ** with **Valkey** (Redis-compatible) for background job processing in `apps/worker`.

## Rationale

- **Reliable job processing** — BullMQ provides persistent queues, automatic retries, backoff strategies, and dead-letter handling out of the box.
- **Pipeline support** — the wizard and factory workflows are multi-step pipelines that benefit from BullMQ's flow/dependency features.
- **Valkey compatibility** — Valkey is an open-source, MIT-licensed Redis fork. BullMQ works with it transparently via `ioredis`.
- **Observable** — built-in events, progress tracking, and job lifecycle hooks for monitoring.
- **Alternative considered:** In-memory queue — fine for development (we support this via `InMemoryWorkflowEngine`) but unreliable for production. pg-boss — ties us to PostgreSQL. Temporal — powerful but overengineered for our scale.

## Consequences

- `apps/worker` runs as a separate process alongside the API
- Two pipelines registered: `wizard` (guided book creation) and `factory` (bulk generation)
- `USE_BULLMQ=true` enables BullMQ mode; without it, an in-memory engine is used for development
- Valkey must be running for production deployments
