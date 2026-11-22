# ADR 002 — Hono for the API Layer

**Status:** Superseded
**Date:** 2025-01-15

> ProserAuthor no longer runs its own Hono API. Active authoring API work belongs in the Express-based ProserFactory repository, with ProserAuthor using the Next.js `/api/*` proxy.

## Context

Proser V2 needs a performant, type-safe HTTP API layer to serve the Next.js front-end and BullMQ workers. The API handles CRUD operations, streaming AI responses (SSE), file exports, and health endpoints.

## Decision

Use **Hono** as the API framework running on Node.js via `@hono/node-server`.

## Rationale

- **Lightweight and fast** — Hono has minimal overhead compared to Express, which matters for streaming AI responses.
- **First-class TypeScript** — built-in type inference for routes, middleware, and context; no `@types` packages needed.
- **Familiar middleware model** — CORS, logging, error handling compose cleanly.
- **Runtime portable** — Hono runs on Node.js, Bun, Deno, and edge runtimes. Starting on Node.js leaves a migration path open.
- **Alternative considered:** Express — ubiquitous but lacks built-in TypeScript support and is heavier for streaming use cases. Fastify — strong contender but Hono's simpler API won out.

## Consequences

- API routes use Hono's `app.route()` pattern for modular registration
- Middleware is applied via `app.use()` with standard Hono middleware
- Streaming responses use Hono's built-in `stream()` helper
- The API is structured as route modules in `apps/api/src/routes/`
