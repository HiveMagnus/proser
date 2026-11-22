# ADR 001 — Monorepo with Turborepo and pnpm

**Status:** Accepted  
**Date:** 2025-01-15

> Current amendment: the Author workspace contains only `apps/web` plus eight shared packages (`ai-runtime`, `contracts`, `design-system`, `domain`, `editor`, `export`, `quality`, and `story-engine`). The API and worker live in the sibling `ProserFactory/` component of the unified Proser repository. pnpm workspaces and Turborepo remain the accepted Author build structure.

## Context

Proser V2 has three applications (web, api, worker) and six shared packages (domain, contracts, story-engine, ai-runtime, editor, design-system). We need a strategy for managing code sharing, builds, and dependency management across these.

## Decision

Use a **pnpm workspace monorepo** with **Turborepo** for build orchestration.

## Rationale

- **pnpm workspaces** provide strict dependency isolation via symlinks and a content-addressable store, preventing phantom dependency issues common with npm/yarn workspaces.
- **Turborepo** gives us incremental builds with remote caching, parallel task execution, and dependency-aware task ordering — critical when packages like `contracts` are consumed by both `api` and `web`.
- The shared packages (`domain`, `contracts`, `story-engine`, `ai-runtime`, `editor`, `design-system`) define clear boundaries and can be versioned or extracted independently if needed.
- Alternative considered: **Nx** — more powerful but heavier; Turborepo's simpler config was preferred for our team size.

## Consequences

- All apps and packages live in one repository
- `turbo.json` defines the task pipeline (build → test, build → lint)
- CI runs `pnpm install` once for the entire workspace
- Adding a new package requires updating `pnpm-workspace.yaml`
