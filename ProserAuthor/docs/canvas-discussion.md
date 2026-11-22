# Canvas manuscript discussion

`BoundedDocumentDiscussion` receives owned passage excerpts and qualified canonical
selection coordinates. Unsaved text/style context uses the Factory-generated typed
operation contract, with the same operation UUID that autosave/flush will commit.
No complete scene snapshot is constructed or sent by this adapter.

Prepare context before sending an instruction. Factory discloses complete included
paragraphs and codex/history, omitted sections, source revision and unsaved status.
Changing the draft or selection requires a new disclosure. A tiny selection in a
paragraph that exceeds the model budget fails explicitly instead of being truncated.

Applying a response first flushes and revalidates the exact saved target, then records
tracked changes. Resolving those changes remains a separate manuscript action. Saved
discussions and exact proposal recovery survive restart; an unknown provider outcome
is never repeated automatically. Account-scoped editor sessions remount the panel to
invalidate visible recovery state on account changes.

Structure, protected objects and review mutations must be saved before preparing
unsaved discussion context. Unsupported draft coordinates fail visibly. All browser
requests stay on the authenticated relative `/api/*` proxy; model inference and
publication authority stay in Factory.

Owned header/footer and front/back matter discussion uses explicit story identity
and exact book/layout revisions. The same panel supports bounded unsaved text and
supported formatting; it never supplies a scene ID for a layout story. Other page,
style and story edits must be saved first. Applying a reply flushes the same typed
intention UUID through the existing layout recovery journal, revalidates the target,
and records tracked changes.

Opening retained discussion history restores original draft intentions from the
owned immutable Factory request. It checks the historical source and the current
local draft before restoring UUIDs; changed or ambiguous drafts are rejected. A
saved application recovers its original exact manifest receipt. Neither action
repeats an unknown provider effect or implicitly accepts a review change.
