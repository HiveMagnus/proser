# Autonomous editorial engine

`editorial_optimize` is the fifth Workflow v1 type. It runs on the existing
`book-workflow-v1` queue and always reaches `completed`, `failed`, or
`cancelled`; it never creates or waits on a workflow checkpoint.

```text
API / CLI / Hermes / Author
          |
          v
 WorkflowRun + EditorialRun -- exact source revision and profile hash
          |
          v
 scope -> detectors -> contextual critics -> passage candidates
          |                                  |
          +---------- original candidate <---+
                                             |
                                  blind, bounded judging
                                             |
                   skip original <--- policy ---> select safe winner
                                             |
                              invariant checks + atomic revision
                                             |
                              post-persistence verification
                                             |
                               summary + evidence artifacts
```

## Safety and terminal policy

Every proposal is anchored by source hash, offsets, and surrounding anchors.
The original is always candidate zero. Judges receive randomized labels and
candidate order, not producer identity, original identity, or generator
rationale. Low confidence, disagreement, unsupported claims, excessive risk,
overlapping edits, stale text, and exceeded budgets retain the original.

`review_only` records findings; `propose_only` also creates and evaluates
alternatives; `safe_auto` accepts only conservative low-risk winners; and
`max_quality_auto` permits bounded additional judging and medium-risk local
edits. None introduces a human gate. Optional failures are recorded and
skipped. Persistence, ownership, migration, or revision-integrity failures
fail the workflow.

Accepted edits use `manuscriptRevisionService` through the editorial
application service. A late result cannot overwrite a newer revision.
Post-persistence hash failure automatically restores the source snapshot and
records the rollback. Interrupted pre-persistence deliveries are rebuilt from
the immutable source; a delivery interrupted after persistence reconciles the
result revision owned by the same workflow.

## Surfaces

- API: `POST /api/workflows/editorial-optimize`, `/api/editorial/*`, and
  `/api/books/:bookId/editorial-*`.
- CLI: `proser editorial passes|run|status|summary|proposals|benchmark`.
- Hermes: primary `proser_editorial_optimize` plus compact `proser_editorial`
  discovery and evidence actions.
- Author: `/editorial`, `/editorial/runs/:runId`,
  `/editorial/profiles`, `/editorial/quality-lab`, and `/m/editorial`.

Run summaries include revision IDs, pass/policy/profile versions, applied and
skipped counts, original wins, disagreement, verification evidence, change
size, unresolved categories, and artifact IDs. Manuscript text is never
returned in the compact Hermes summary.
