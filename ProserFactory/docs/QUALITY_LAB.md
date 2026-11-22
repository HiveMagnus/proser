# Editorial Quality Lab

The Quality Lab is a versioned, source-controlled benchmark suite under
`evaluation/`. Public inputs and isolated hidden expectations are
loaded separately and hash-validated before the API reports ready.

Cases cover passage, scene, chapter, long-range, and full-book behavior,
including original retention, reference copying, voice flattening, continuity,
name collision, and hard-invariant traps. Hidden expected verdicts are loaded
only by the scorer after generation and judging and are never placed in
generator or judge context.

## Running it

```bash
npm run quality:corpus
npm run quality:deterministic
proser editorial benchmark-run --suite editorial-deterministic --maximum-cases 20
proser editorial benchmark-run --suite editorial-deterministic --maximum-cases 3 --live
```

The API equivalent is `POST /api/editorial/benchmarks`. Deterministic mode is
CI-safe and uses no provider. Live mode uses the configured inference backend,
is capped at five cases, has a server-bounded timeout per case, and preserves
the original if a provider fails or times out. The route also has shared,
fail-closed per-user concurrency and daily budgets, a request-size ceiling, and
an overall execution deadline. The benchmark runner consumes the deadline's
cancellation signal before every persisted case/result write and before the
terminal report update. Current values are generated into the root API contract.

Reports fingerprint suite/case versions, code and schema revision, model,
recipe, sampling, RAG, pass, policy, profile, and judge configuration. Metrics
include expected-match rate, improvement precision, original-retention
accuracy, invariant compliance, regression rate, disagreement, abstention,
latency, inference use, reference-copy detection, voice retention, style
flattening, and name-collision detection.

Release gates block on deterministic hard invariants, original retention,
expected-match minimums, and the checked-in baseline. Live-model variance is a
warning unless a release process explicitly promotes it. To prevent evaluator
gaming, do not expose `evaluation/hidden/`, expected hashes, or
scoring branches to prompts. Treat benchmark excerpts as private manuscript
data and do not send them to an unapproved provider.

## Domain-neutral corpus isolation profile

Other authoring systems may reuse the Quality Lab boundary without depending on
Proser at runtime. Keep public generator inputs, scorer-only hidden
expectations, a hash-pinned manifest, and reviewed baselines in distinct paths.
Load only public inputs into generation or repair context; load hidden
expectations only after the candidate output has been sealed. Deterministic CI
may enforce invariant and regression results, while provider-variance runs stay
separate from CI and cannot update a baseline automatically.

Modulatron Adventure Foundry follows this profile in its own repository. Proser
does not own its adventure corpus, schemas, evaluator, or promotion decisions.

## Troubleshooting

- `EDITORIAL_BENCHMARK_INVALID`: run `npm run quality:corpus` and inspect
  manifest paths/hashes.
- Readiness reports an invalid corpus: deploy the `evaluation/` directory with
  the application revision.
- Live timeout: check the configured inference backend/model and
  `EDITORIAL_LIVE_BENCHMARK_TIMEOUT_MS` (hard-capped at 60 seconds per case).
- Regression: compare the report’s configuration fingerprints and per-case
  evidence with `evaluation/baselines/editorial-deterministic-1.0.0.json`; update a baseline only
  after a deliberate reviewed improvement.

## Structured document acceptance

The structured suite is `evaluation/manifests/document-editing-v1.json` with
public inputs in `evaluation/suites/document-editing/` and separately loaded
expectations in `evaluation/hidden/document-editing/`. Exact input/expectation
SHA-256 values are pinned in the manifest. Corpus validation and readiness check
these bytes and canonical schemas; provider context never contains hidden
expectations or scorer hashes. The existing deterministic gate also runs all
16 document fixtures.

The suite tests formatting and protected-image/table/layout preservation,
exact table-cell targets, repeated quotations, Unicode UTF-16/grapheme boundaries,
run and paragraph formatting races, moved containers, changed identity, pending
review and incompatible styles. Each result records source/result/output hashes,
fixture versions, model provenance, known-response digest, usage and latency.
The benchmark report includes structured results and blocks completion when
preservation, expected rejection, or provider outcome verification fails.

Live evaluation invokes at most two structured targets, sharing the existing
five-call total with the plain-text corpus. For example, use
`proser editorial benchmark-run --maximum-cases 3 --live --operation-id RETAINED_KEY`
for three plain-text and two structured provider calls. Complete target blocks
and included/omitted identities are disclosed in the frozen input; every model
edit is checked against exact source text and target ID before formatting-aware
application to an in-memory fixture. Neither evaluation path writes manuscripts.
No transport replay is enabled. Each structured call has a 45-second bound;
caller cancellation also bounds a provider that ignores its abort signal.
Unknown or invalid model results fail acceptance and preserve the source fixture.
These executable fixture checks do not constitute an independent live-model
acceptance report until the configured provider has actually been exercised.

Retain the CLI's printed operation key before inference. Recover with the same
key and configuration; incompatible reuse fails visibly. Interrupted/cancelled
runs retain a terminal inspection record, and their key never replays provider
work. Original benchmark evidence and baselines are preserved.

The isolated real-provider canary is executable without writing production
records:

```bash
node scripts/run-document-live-canary.mjs \
  --isolated-postgres postgresql://postgres:canvas-fixture-only@127.0.0.1:55441/postgres \
  --record-dir /tmp/private-new-document-canary
```

It allocates a fresh database, deploys the current migrations, creates an owned
disposable structured book, and uses a loopback authenticated API with the normal
Redis budget and renewable capacity lease enabled. It requests one plain-text and
at most two structured model cases. The private directory retains the exact
operation, immutable source identities/hashes, provider responses/results and
terminal report. A plain-text literary baseline failure remains a failure even
when structured preservation passes. Read those results separately.

Use the same command with `--recover` to read the retained operation and owned
report without invoking inference. A directory with a retained operation refuses
another create. Lost or interrupted acknowledgements never authorize a new
provider effect. Synthetic fixture authentication is valid only for that isolated
process and database; the tool creates no delegated grants and changes no
production service, records, leases or credentials.
