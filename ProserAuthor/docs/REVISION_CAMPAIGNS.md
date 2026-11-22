# Whole-book revision campaigns

Open **Editorial → Plan a revision campaign**, choose a manuscript and describe
one goal. Starting points cover antagonists, character arcs, pacing and theme.
Phones use `/m/editorial/campaigns`; desktop override and selected book/campaign
links are preserved.

1. Create the campaign and select **Scan whole manuscript**. Factory freezes the
   canonical book revision, ordered active scenes, codex, layout and Plot Thread
   evidence. Each saved text range is scanned, including tables. Empty scenes,
   unavailable sources, failed scans and budget limits remain distinguishable.
2. Inspect the ordered plan, exact quotations, predicted consequences,
   prerequisites, narrative uncertainties and coverage. Literal neighboring
   chapter endings/openings are included as evidence. A passage scan can propose
   edits only within its own text range. Factory retains a suggestion aimed at a
   disclosed neighboring edge for audit and relies on that scene's independent
   scan for editable steps. Consequences are predictions.
3. Select **Use cited protection suggestions**, inspect/edit the fact and voice
   descriptions, then **Save confirmed protections and goal**. The original
   cited passages remain the protection baseline as the manuscript changes.
   Refresh the plan after changing protections, then approve the current plan.
4. Prepare the first supported prose step, request a proposal, select edits and
   preview consequences. Factory checks the actual candidate against the confirmed
   facts/voice and saves semantic and deterministic verification. Missing,
   failed or inconclusive required verification blocks application. Proposals
   must preserve the exact wording of confirmed facts that appear verbatim in
   the passage.
5. Explicitly revalidate and apply the selected edits. This creates pending
   tracked edits. In the manuscript, select **Markup** under **Review view**,
   then use **Accept change** or **Reject change** on each pending insertion
   or deletion. If the acknowledgement is interrupted, select **Check original
   receipt** to recover the saved decision. After reloading, use **Recover
   original operation**. Return to the campaign, record the resolved step and
   re-review downstream evidence before approving and preparing another step.
6. Complete the campaign only after a fresh whole-book review has no unresolved
   required steps, coverage gaps or structural follow-up. Voice acceptance remains
   the author's judgment, supported by the cited comparisons.

Plan approval never approves prose application. Structural recommendations are
manual follow-up. Skipped prerequisites block dependents; requesting plan changes
revokes its approval. Any manuscript, canon, layout, Plot Thread or campaign-rule
change invalidates actionable plans, including changes outside the target scene.
Each analysis saves a cited re-review for every disclosed plot link and chapter
boundary. Current campaign reviews preserve original Plot Thread quotations and
mark stale links explicitly; they never silently replace those links.
Historical snapshots and quotations remain available; Factory never relocates
an edit by searching for its quotation. The exact historical-plan route is
`GET /api/books/:bookId/revision-campaigns/:campaignId/plans/:planId`.

## Recovery and bounded work

The campaign polls for running analysis results without disabling the focused
control. An explicit refresh still reports loading and read errors. Mutations
that depend on saved metadata wait for the acknowledged version.

Campaign, analysis launch and decision mutations have exact operation receipts.
Author records requests before dispatch in an authenticated-user/book-specific
journal separate from Plot Threads. Recover the original request after reload,
account switching, another tab's pending request or a lost acknowledgment.
An explicit retry uses the same UUID and body and first checks the original
receipt. Unknown provider outcomes do not authorize another analysis or inference
call. The existing Workflows page exposes pause/resume/cancel and retained effects;
resuming reuses completed provider outputs. Partial scan results remain inspectable.

Factory runs `revision_campaign_analysis` in the existing `book-workflow-v1`
queue; it creates no second queue or manuscript authority. Each analysis runs
against one immutable snapshot and produces append-only plan/evidence records.
Candidate previews bind the exact selected edits, candidate digest and source
revision. Changing the selected subset requires a matching preview.

The model selects server-issued citation references; Factory resolves them to
exact frozen identities and offsets rather than asking the model to calculate
positions. Original provider bytes and the complete versioned prompt are retained.

Scan chunks contain at most 8,000 UTF-8 bytes without splitting Unicode
graphemes. Synthesis uses bounded hierarchical groups containing every successful
scan summary. Each inference reserves its full prompt-byte upper bound plus output
and safety capacity; the default campaign ceiling is 2,000,000 conservative tokens.
Operators may set `REVISION_CAMPAIGN_MAX_INFERENCE_TOKENS` from 8,192 through
8,000,000. Model context limits apply independently. Capture/result limits and
unsupported reductions become explicit failures/gaps; no prose is silently
truncated to claim complete coverage. Proposals reuse existing context/target
limits and deterministic preservation checks, including a 30% candidate change
ceiling and style-drift checks. Repeated short excerpts can need smaller edits.

## Verification

Run all root gates using the required isolated PostgreSQL/Redis services.
`revisionCampaigns.test.ts` includes a seeded three-chapter application and
re-review, source changes, receipts, prerequisites, provider uncertainty,
retained-output recovery, Unicode coverage and budget exhaustion.

For browser acceptance, run `scripts/run-revision-campaign-release-smoke.mjs`
with explicit `127.0.0.1:55441/proser_canvas_campaign_*` PostgreSQL and
`127.0.0.1:56441` Redis plus `PROSER_RELEASE_SMOKE_OUTPUT` in a private evidence
directory. It starts isolated Factory/Author and a real BullMQ workflow consumer,
using clearly identified synthetic model outputs. The browser creates the
campaign, loses acknowledgments, confirms protections and explicitly applies
three chapter edits. Tracked resolution uses canonical API operations; the
existing workspace browser gates exercise the manuscript's review controls.
Set `PROSER_CAMPAIGN_KEYBOARD=true` to activate every campaign button with Enter
after normal enabled-state checks, and `PROSER_CAMPAIGN_MOBILE=true` to complete
the primary workflow at 390px with an emulated mobile user agent. These modes
exercise the same shared campaign controls; they do not certify physical devices.
A temporary incomplete scan remains observable while its workflow is running;
terminal missing coverage fails acceptance and keeps approval blocked.

`scripts/test-revision-campaign-release.mjs` supports a canonical production
canary with `PROSER_CAMPAIGN_LIVE=true`,
`PROSER_RELEASE_SMOKE_BASE_URL` with the same HTTPS origin as
`PROSER_AUTHOR_ORIGIN`, private
`PROSER_RELEASE_SMOKE_OUTPUT` and explicit IAM credentials or the existing
disposable-session signer. Live mode uses real configured inference. It retires
its disposable book while retaining manuscript revisions, receipts and campaign
history. Signed sessions do not establish IAM password-login acceptance.

Automated browser, keyboard, accessibility and exact recovery checks gate release.
Run available screen-reader checks; unavailable physical-device and actual
screen-reader certification remains explicitly incomplete and nonblocking by
current author direction. Browser emulation does not establish that certification.
