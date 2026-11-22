# Canvas integration fixtures

The runtime is supplied by the exact `@hivemagnus/canvas-word-engine` dependency
maintained in `ChefTaco/canvas-word`. This directory retains browser acceptance
fixtures and historical license/provenance records. It contains no editor
runtime source or independent build. Fixtures import the installed package and
its diagnostic `testing` entry, so they exercise the same bytes as the app.

`UPSTREAM.md`, `LICENSE`, `NOTICES.md` and `notices/` describe the earlier retained
source snapshot. Current dependency provenance is recorded in
`ProserFactory/docs/canvas-dependencies.json` and the current release ledger.
