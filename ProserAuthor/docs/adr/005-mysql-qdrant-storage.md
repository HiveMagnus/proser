# ADR 005 — MySQL + Qdrant Dual Storage

**Status:** Superseded
**Date:** 2025-01-15

> ProserFactory owns authoring storage in Prisma/PostgreSQL, including narrative-memory tables. ProserAuthor has no database and must not run its legacy Prisma API path.

## Context

Proser stores structured relational data (books, chapters, scenes, codex entries, users) alongside vector embeddings for semantic search (narrative memory, similarity matching). These are fundamentally different storage patterns.

## Decision

Use **MySQL 8.4** for relational data via **Prisma ORM** and **Qdrant** for vector storage and similarity search.

## Rationale

- **MySQL** — battle-tested relational database with excellent tooling. Prisma provides type-safe queries, schema migrations, and a visual studio. MySQL 8.4 supports JSON columns and full-text search for supplementary queries.
- **Qdrant** — purpose-built vector database with high-performance HNSW indexing, payload filtering, and a clean HTTP/gRPC API. Outperforms pgvector for our embedding workload.
- **Separation of concerns** — relational data and vector data have different access patterns, indexing needs, and scaling characteristics. Keeping them separate avoids compromises.
- **Alternative considered:** PostgreSQL + pgvector — single-database simplicity but pgvector performance lags Qdrant significantly at our embedding dimensions. SQLite — used in V1 but lacks concurrent write support needed for multi-worker setups.

## Consequences

- `apps/api/prisma/schema.prisma` defines the relational schema
- Qdrant collections are managed by `packages/ai-runtime` and `packages/story-engine`
- Database migrations use Prisma Migrate (`npx prisma migrate dev`)
- Both MySQL and Qdrant must be running for full functionality; the app degrades gracefully if Qdrant is unavailable (vector search returns empty results)
