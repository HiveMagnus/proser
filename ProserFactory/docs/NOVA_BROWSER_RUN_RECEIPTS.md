# Nova browser-run receipts

ProserFactory owns the durable evidence boundary for Nova's `proser_browser`
evaluations. Generic Playwright HTML output is diagnostic only and cannot be
signed. A trusted browser-runner process must create a `BrowserRun` before it
opens the browser, append one result for every precommitted case, and create one
terminal snapshot. The Nova exporter accepts only that run's identifier.

## Journal contract

Migration `20260920220000_browser_run_receipts` adds four insert-only tables:

- `browser_runs` stores the exact request, evaluation, package revision and
  digest, service-owned target identity, runner build, fixture, sorted case
  plan, and start time before execution.
- `browser_run_case_results` stores one `pass`, `fail`, or `blocked` result and
  immutable evidence SHA-256 for each planned case.
- `browser_run_terminals` stores the service-derived ordered cases, outcome,
  case-cohort digest, observation time, and result digest.
- `browser_run_receipts` stores the one signed receipt and its canonical JSON.

PostgreSQL triggers reject every `UPDATE`, `DELETE`, and `TRUNCATE` on these tables. Unique
keys prevent evaluation reuse, case replacement, repeated terminalization, and
re-signing. Failures and blocks are retained; `failed` takes precedence over
`blocked`, which takes precedence over `passed`.

The concrete runner is `NovaBrowserPlaywrightRunner` in
`src/services/novaBrowserPlaywrightRunner.ts`. Its operator CLI accepts only a
private binding file, a protected fixture, a private evidence directory, and an
optional private Playwright storage-state file. It hashes its own compiled runner
module for `runner_build_sha256`, hashes the exact fixture bytes for
`fixture_sha256`, sorts and precommits the fixture's case IDs, and opens Chromium
only after the run row exists. For every case it retains a canonical evidence
bundle and screenshot, hashes the exact evidence bytes, appends `pass`, `fail`,
or `blocked`, and terminalizes the run. Browser assertion misses are `fail`;
launch, navigation, action, screenshot, or infrastructure errors are `blocked`.

The binding file is mode 0600, owned by root or the runner account, and contains
only the Nova/package authority that the runner cannot derive from browser work:

```json
{"request_id":"nova-<32 lowercase hex>","evaluation_id":"evaluation-id","package_id":"package-id","package_revision":1,"package_digest":"<lowercase sha256>"}
```

The fixture is a non-symlinked regular file that is not group/world writable.
Case order in the source is irrelevant because the runner sorts IDs before the
journal write. Each case declares a same-origin path, a 1..60 second timeout,
optional `click`, `fill`, or `press` actions, and at least one `visible`, `text`,
or exact same-origin `url` assertion:

```json
{"version":1,"cases":[{"case_id":"workspace-loads","path":"/workspace","timeout_ms":10000,"actions":[],"assertions":[{"assertion":"visible","selector":"main"}]}]}
```

The target and issuer are never fixture, binding, or command-line input. They
come only from service configuration:

```dotenv
PROSER_BROWSER_RUN_ISSUER=proser-production
PROSER_BROWSER_TARGET_ORIGIN=https://proser.example.com
PROSER_BROWSER_TARGET_SERVICE_ID=proser-author
```

After the normal Factory build, run the trusted evaluation process:

```bash
mkdir -m 0700 /absolute/path/to/evidence
npm run browser-run:evaluate -- \
  --binding /absolute/path/to/evaluation-binding.json \
  --fixture /absolute/path/to/browser-fixture.json \
  --evidence-dir /absolute/path/to/evidence \
  --storage-state /absolute/path/to/playwright-storage-state.json
```

The evidence base directory must already exist, be mode 0700, and be owned by
root or the runner account. The runner creates one exclusive mode-0700 subfolder
per run and mode-0600 evidence files. Do not expose the runner or the underlying
`BrowserRunJournalService` as a browser or Nova-facing route. The process must
use a dedicated service identity with Factory database access. A test
coordinator, HTTP caller, or receipt consumer cannot choose build, fixture,
case, evidence, target, outcome, or receipt fields.

## Receipt export

An operator provisions one Ed25519 PKCS#8 PEM private key as an absolute,
mode-0600 regular file owned by root or the Factory service account. Do not put
the PEM in environment variables or the repository. Configure its path and a
pre-existing non-symlink output directory that is not group/world writable:

```dotenv
PROSER_BROWSER_RECEIPT_PRIVATE_KEY_FILE=/opt/proser-factory/secrets/nova-browser-runner-ed25519.pem
PROSER_BROWSER_RECEIPT_OUTPUT_DIR=/opt/proser-factory/state/nova-browser-receipts
```

After the additive migration is applied and a run is terminal, export exactly
one receipt:

```bash
npm run browser-receipt:export -- proser-browser:<uuid>
```

The exporter opens the private key without following symlinks, verifies its
type, owner, device, inode, link count, size, mode, uid/gid and change times
before and after the bounded read, derives the key ID from the 44-byte Ed25519
SPKI DER, and signs canonical UTF-8 JSON. It derives all receipt fields from the
journal and fixes expiry to 24 hours after the terminal observation.

The signed row commits before filesystem publication. Publication holds an fd
on the protected output directory, writes and fsyncs a random exclusive
temporary file through `/proc/self/fd`, changes it to mode 0644, atomically hard
links the final `<receipt_id>.json`, removes the temporary link, and fsyncs the
directory. A retry loads the exact stored canonical bytes without reading the
private key, accepts an already-published file only when byte-identical, and
repairs a crash-retained temporary hard link before revalidation. A different
existing file fails closed.

The receipt contains exactly the Nova v1 fields plus `signature`. Cases remain
sorted and preserve their original failure/block evidence. The result SHA-256
commits to the full service target, request/evaluation/package binding, runner,
fixture, pre-run case-plan digest, final cases, chronology, and outcome.

Normal export is idempotent: if signing was durably recorded but output creation
failed, rerunning the same command recovers only the stored canonical receipt
and never loads the private key or creates a new signature. The explicit
materialization form is also available for operator diagnostics:

```bash
npm run browser-receipt:export -- proser-browser:<uuid> --materialize-existing
```

Copy the resulting immutable file into Nova's provisioned
`state/nova-creative/runner-receipts/<issuer>/` inbox through the reviewed
read-only transport. Nova must independently pin the matching public key,
issuer, `proser_browser` surface, canonical origin, and `proser-author` service
identity. A receipt is evidence only; it never authorizes a run, publication,
promotion, or Senti acceptance.

## Activation boundary

This source change does not apply the migration, provision a key, enroll a Nova
issuer, execute browser cases, copy a receipt, or activate verification. Those
operations require the normal reviewed deployment and credential procedure. It
also does not install Playwright's pinned Chromium binary in the runner account;
that runtime dependency must be provisioned and verified before activating a
scheduled evaluation.
