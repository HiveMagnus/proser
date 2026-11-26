# Canvas maintenance and diagnostic retention

Author and Factory use exact versions of the published Canvas Word engine and
DOCX codec. Their maintained source lives in
[canvas-word](https://github.com/ChefTaco/canvas-word). The component lockfiles
and [dependency provenance](../../ProserFactory/docs/canvas-dependencies.json)
identify the installed distributions, notices, and SBOM. Historical public
package provenance is retained under `docs/history/canvas-owned-forks-20261108/`.

## Updating the packages

Review the upstream source and published package integrity before updating the
component pins. Keep Factory's headless codec API and Author's browser editor
boundary. Preserve upstream notices, embedded runtime notices, and the public
source revisions in the release ledger.

From the repository root:

```bash
node scripts/check-canvas-shared-packages.mjs
npm --prefix ProserFactory run codec:build
node ProserFactory/scripts/generate-canvas-release-ledger.mjs --check
npm --prefix ProserFactory run codec:test
npm run documents:check
npm run test:canvas
npm run test:canvas-mobile -- --repeat 3
```

Run the [authenticated browser gate](../../scripts/DOCUMENT_BROWSER_ACCEPTANCE.md)
for candidate changes that affect writing, ownership, or operation recovery.
Render and inspect samples independently when changing import or publication.
Chromium/WebKit emulation, a physical device, and an actual screen reader
provide separate evidence. See the [acceptance record](../../docs/CANVAS_R2_ACCEPTANCE.md)
for the current limits.

## Diagnostic retention

Keep diagnostics and screenshots in ignored output directories. Use synthetic
fixtures and owner-only storage for any production evidence. Preserve the receipt,
its candidate identity, and unique evidence before pruning a disposable run.
Skip active browser or service paths. Retain manuscript originals, media,
operation receipts, uncertain provider effects, and production checkpoints.
