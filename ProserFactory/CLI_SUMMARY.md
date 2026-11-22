# CLI Summary

The CLI remains a bounded utility for book CRUD, outlines, codex work, direct generation, revision, export, and status inspection. It is not a second workflow orchestrator.

Whole-book creation and editorial processing use the authenticated Workflow v1 API or Hermes workflow tools. The retired `pipeline` and `resume` commands were removed with the legacy Factory orchestrator so background state, retries, checkpoints, revisions, and audit events have one source of truth.

Current command registration lives in `src/cli/index.ts`. Workflow operators should use the endpoints and examples in `docs/WORKFLOW_V1.md`.
