# Copilot instructions — Proser

Proser is a unified repository with two strict runtime boundaries. Read `AGENTS.md` plus the component `AGENTS.md` before editing.

- `ProserFactory/` owns the Express API, persistence, workers, model/image integrations, CLI, and Hermes plugin.
- `ProserAuthor/` owns the authenticated Next.js browser shell, mobile routes, Auth.js sessions, and same-origin Factory proxy.

Do not move Factory responsibilities into Author or recreate the retired Author API/worker. Keep browser requests relative, service secrets server-side, image bytes behind authenticated routes, and durable workflow execution in `proser-worker`.

Use npm within `ProserFactory/` and pnpm within `ProserAuthor/`. Root scripts provide combined checks but do not replace component lockfiles.
