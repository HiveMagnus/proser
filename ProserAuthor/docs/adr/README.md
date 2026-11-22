# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Proser V2 project.

| ADR                                | Title                            | Status                                   |
| ---------------------------------- | -------------------------------- | ---------------------------------------- |
| [001](001-monorepo-turborepo.md)   | Monorepo with Turborepo and pnpm | Accepted; layout amended                 |
| [002](002-hono-api.md)             | Hono for the API layer           | Superseded by Factory proxy boundary     |
| [003](003-provider-agnostic-ai.md) | Provider-agnostic AI gateway     | Superseded by Factory model runtime      |
| [004](004-bullmq-workers.md)       | BullMQ for background processing | Superseded by Factory workers            |
| [005](005-mysql-qdrant-storage.md) | MySQL + Qdrant dual storage      | Superseded by Factory PostgreSQL storage |

ADRs preserve the decision context at the time they were written. A superseded ADR is historical and must not be used as current operational guidance; current runtime guidance lives in `AGENTS.md`, `README.md`, and the non-ADR files under `docs/`.
