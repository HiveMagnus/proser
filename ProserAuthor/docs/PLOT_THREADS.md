# Plot Threads

Open **Plot Studio → Plot Threads** on desktop, or **Plot Threads** from mobile
Editorial. Phone requests to `/plot` map to `/m/plot`, preserving the selected
book and thread. The desktop override remains available.

1. Choose a manuscript and select **New Thread**. Enter a story question such as
   “Will the apprentice discover who betrayed her?” Save optional description
   and notes alongside it.
2. Link **Setup**, **Escalation**, and **Payoff** to saved scene text. Choose a
   scene, select text in its read-only passage, and save the linked excerpt.
   Each stage may have multiple excerpts. Alternatively, select text in the
   manuscript editor and use **Add selection to plot thread**. The editor saves
   first and verifies the acknowledged selection before linking it.
3. Inspect missing linked stages and narrative-order cautions. “No setup
   linked” describes this thread's evidence, not the entire manuscript.
4. Select **Review payoff**. Factory reviews only the disclosed linked excerpts
   and saves its assessment, cited observations, and revision guidance. Save
   **Your assessment** and review notes separately. AI never changes thread
   status or manuscript text merely by reviewing it.
5. Select **Offer a small revision** on a citation, **Prepare cited passage**,
   then **Request small revision**. Inspect before/after text, choose edits,
   and explicitly revalidate and apply. Changes become pending tracked edits;
   inspect and accept or reject them through the manuscript's existing controls.

**Open exact excerpt** restores its saved scene/run identities and selection.
When text, scene membership, or effective layout changes, the linked quotation
remains visible with a stale warning. Replace it by explicitly choosing new
saved text. Removing a link retains its original evidence; saved reviews retain
their frozen quotations. A review becomes stale after its thread inputs or
manuscript revision change. Refresh evidence and review before proposing edits.

Use the existing thread states: open, escalated, resolved, or abandoned. Stage
coverage, AI assessment, and author judgment are independent. Archive hides a
thread from active lists and generation memory without deleting it; **Show
archived threads** allows restoration. Author-managed questions cannot be
overwritten by automatic memory extraction.

## Recovery and limits

Thread changes and evidence links have exact operation receipts. Browser
recovery records are scoped to authenticated author and book, retained without
expiring an unresolved request. **Recover original request** checks its saved
receipt or provider result. An explicit **Retry identical recorded request**
uses the same operation ID and body; it cannot create another provider call for
an already-dispatched review. Unknown provider outcomes remain uncertain and
block another review of the same frozen source.

Recovery of creation or linking opens the original saved thread and closes its
pending form. Retry checks the original receipt first. If no receipt exists and
the identical request is rejected because its source changed, the recovery slot
is released so you can select current saved text. An unavailable service or
uncertain acknowledgment keeps the exact request. Another tab's pending request
is shown for recovery rather than overwritten.

Thread edits and author-assessment drafts block internal back/refresh and
navigation until saved or explicitly discarded. Reloading the excerpt picker
clears its old passage and selection. A stale review remains inspectable; its
saved revision panel also receives the current stale state and cannot apply it.
Use **Recover saved review** for a pending or unknown review retained in history.
Factory can finish validation from saved provider bytes after an interruption
without calling the model again. Cancellation before dispatch is terminal;
cancellation after dispatch stays unknown until the original outcome is proven.
Unchanged proposed edits are rejected. A known failed proposal can be followed
by an explicitly requested **Request another small revision**, retaining the
original failure; a pending or unknown provider outcome cannot use that action.

A thread supports 24 active excerpts, with at most 20,000 UTF-8 bytes per
excerpt. Review snapshots and prompts have a 64,000-byte ceiling and the configured model context limit; oversized
context is rejected rather than silently truncated. Small prose proposals have
a total limit of 600 removed/inserted characters. Existing document proposal
context limits also apply. The detail view includes the latest 20 saved reviews;
each older review remains available by its exact review ID.

## Verification

From the repository root, use `scripts/run-plot-thread-release-smoke.mjs` with an
explicit isolated `127.0.0.1:55441/proser_canvas_plot_*` database and
`127.0.0.1:56441` Redis. It starts Factory and Author on loopback ports 3466/3476
and supplies clearly identified synthetic provider outputs. Tests cover actual
browser creation, linking, lost acknowledgments, before/after approval, exact
selection navigation, editor capture, another browser context, narrow mobile,
keyboard focus, session preconditions, and the desktop override.

`scripts/test-plot-thread-release.mjs` also supports a production canary with
`PROSER_PLOT_LIVE=true`, `PROSER_RELEASE_SMOKE_BASE_URL` with the same HTTPS origin as
`PROSER_AUTHOR_ORIGIN`, private
`PROSER_RELEASE_SMOKE_OUTPUT`, and explicit `PLAYWRIGHT_IAM_USERNAME` /
`PLAYWRIGHT_IAM_PASSWORD`, or an owner-only `PROSER_CANARY_SESSION_FILE` created
by the existing disposable-session signer. Signed-session evidence does not
establish IAM password-login acceptance. This mode uses real configured inference and
tombstones its disposable book while retaining receipts. Never treat the
isolated synthetic provider test as live model proof. Browser emulation and
keyboard checks do not establish physical-device or actual screen-reader
certification.
