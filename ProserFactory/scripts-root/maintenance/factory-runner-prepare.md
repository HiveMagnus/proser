# Legacy Factory Runner preparation

This procedure is retired. The `FactoryRun`, `FactoryStep`, and `FactoryLog` tables and their queue were removed when Workflow v1 became the only durable orchestration platform.

For the current schema, run from `ProserFactory/`:

```bash
npm run db:generate
npm run db:deploy
```

The authoritative workflow models are in `prisma/schema.prisma` (`WorkflowRun`, `WorkflowTask`, `WorkflowEvent`, `WorkflowCheckpoint`, `WorkflowArtifact`, manuscript revisions, review runs/findings, ledgers, and publication records). Do not recreate `factory_*`, Wizard, NovelRun, or ReviewRun tables.

Optional scene word-count maintenance uses:

```bash
npm run db:backfill:scene-wc
npm run db:check:scene-wc
```

Production migration, database backup, WAL configuration, service restart, smoke testing, and revision verification are handled by `scripts/deploy-to-proser.sh`.
