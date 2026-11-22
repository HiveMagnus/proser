---
name: proser-authoring
description: Use Proser for book creation, read-only review, review-driven improvement, guided changes, and bounded authoring operations.
metadata:
  hermes:
    tags: [proser, authoring, workflow, quality]
    requires_tools: [proser_books, proser_generate, proser_full_book, proser_quality_review, proser_improve_quality, proser_guided_improve, proser_workflow_status, proser_workflow_checkpoint]
---

# Proser authoring

Choose exactly one durable workflow for background work:

- Create a complete manuscript: call `proser_full_book` once, then report its `runId` and checkpoint state.
- Diagnose quality without changing prose: call `proser_quality_review` once per requested model.
- Implement stored findings: call `proser_improve_quality` with review run IDs and optional finding IDs.
- Apply a free-form author request: call `proser_guided_improve`.

Do not construct or submit architecture, scene contracts, review artifacts, or prose payloads for these workflows. The server owns every internal task. Do not retry a start merely because generation is slow. Read `proser_workflow_status`; use pause, resume, cancel, or checkpoint tools only when the user requests the corresponding action or a pending checkpoint needs a decision.

For ordinary bounded reads and edits, use `proser_context`, `proser_books`, `proser_codex`, `proser_generate`, and `proser_exports`. Prefer compact context views over returning whole prose in chat.

Quality completion means the stored coverage includes every requested scene plus the required chapter, act, and book passes. Never infer that a zero score means unscanned chapters, and never claim a full-book scan from one or two scene results.

## Revision-bound bounded editing

Keep `proser_generate` tool names `revise_prose` and `command_revise`. Before a
bounded edit, use `proser_books` action `document_capabilities` for the exact
owned book. Require schema version 1, `revisionPreview: disclosed-proposal-v1`,
`revisionSource: immutable-manifest-v1` and `projection: final` when authority is
active. If this contract is unavailable, no inference may start. Raw `originalText` is not an inference
contract. Fetch `scene_document` and `document_manifest`, choose canonical block
identities and exact UTF-16 spans, and create `create_document_discussion` with
schema/version, operation/session UUIDs, expected book/scene revisions, document
hash, final projection and exact targets. Supply a local document only when the
user's unsaved derivative is intentionally included; Factory validates it.

Read the returned discussion snapshot. Disclose the complete target blocks,
selection, saved revision/local draft digest, included codex, and omitted
blocks/codex/earlier turns before requesting inference. Never silently truncate a
target or relocate it by searching for a repeated quotation.

Then call `proser_generate` with `sceneId`, `instruction`, and
`documentPreview: {discussionId, operationId}`. `originalText` is optional; when
provided it must equal the frozen target texts joined by two newlines. The result
is a typed proposal with its IDs and source revisions. It is not replacement
prose for a subsequent full-scene save. Alternatively use
`request_document_proposal` for the same owned discussion.

After a lost preview acknowledgement use `document_proposal` with
`proposalId` equal to the original `documentPreview.operationId`; proposal IDs
are the caller-retained inference operation IDs. `discussion_proposals` also
lists retained proposals. `cancel_document_proposal` accepts this same ID.
Recover the exact operation before retrying. Unknown or running provider effects must not be repeated.
`cancel_document_proposal` suppresses late application. Flush relevant user edits,
revalidate with `revalidate_document_proposal` using the resulting exact revisions,
and apply authorized targets with `apply_document_proposal` plus the returned
validation ID. Applying the proposal creates tracked changes. Accepting changes,
quality completion and approving publication remain separate actions; follow the
user's existing authorization and the server's release gates.

Compatibility mutations, including deletes, carry `documentPreconditions` in
their body. Lost save acknowledgements recover through `document_operation`
before any repeat. `operator_operations` / `operator_operation` expose retained
CLI effects; do not replace an unknown effect with a new operation ID.

Scene generation has a separate receipt family: `document_inference_operation`
and `cancel_document_inference_operation` use the original generation operation
ID. These routes do not recover document proposals.

Active `inline_suggestion` and `feedback` use the same disclosed discussion and
typed proposal contract. Include `bookId`, `sceneId`, and `documentPreview`; any
legacy `context` or `content` must equal the exact disclosed target texts. They
return a proposal for separate revalidation/application, without changing prose.


### Revision-bound reads and classic comment review

Active book/structure reads return canonical metadata and source revisions.
`proser_context` `book_map` reads metadata unless prose excerpts are requested;
its word totals use the captured manifest. `proser_books` `get_book` keeps its
compatibility prose behavior; pass `query: {includeProse: 0}` for bounded metadata.
For editing, prefer `scene_document` over these plain-text projections.

Use `scene_comments` or `layout_story_comments` to inspect explicit attached,
stale or orphaned state. Supply stable `sceneId` or `storyId` and `commentId` to
`revalidate_scene_comment` / `revalidate_layout_story_comment`, with exact
`expectedRevisionId` plus `expectedSceneRevisionId` / `expectedLayoutRevisionId`.
Reattachment must supply explicit current canonical anchors; never relocate a
comment by matching a quotation. Resolve/reopen/reanchor through the matching
`resolve_*_comment` action with a retained operation UUID and body action.
Recover a lost acknowledgement with `document_operation` using that UUID.
Resolution history preserves the old owned source proof. Comment resolution does
not accept tracked changes or approve publication.


`proser_context` `search_scenes` negotiates Factory's bounded global search.
Active results retain exact source manifest/scene hashes, original UTF-16 spans
and canonical anchors. Continue from `query.cursor` while `nextCursor` is present,
including empty pages. A page after a newer save can report `stale: true` while
still reading the original immutable manifest. Refresh explicitly before using a
result whose saved scene revision changed; never guess a replacement quotation.
Factory advertises `revision-gin-v1`, an immutable PostgreSQL index of exact
scene revisions and stable source maps. Search decodes no canonical bodies and
loads only bounded matching projections. A missing index returns
`DOCUMENT_SEARCH_INDEX_INCOMPLETE`; preserve the query/cursor and use the owned
`/api/books/:bookId/document-search-index/recover` POST with `{after?,limit?}`
(default eight, maximum 32), continuing `nextAfter` until complete, then retry the
same query. Recovery creates or verifies derived rows, never overwrites source
history or changes document heads. Invalid existing evidence fails visibly.


Tracked-change decisions are separate durable actions. Read the exact saved
`scene_document` (or owned layout scope), flush relevant typing, and commit the
canonical accept/reject result with book/scene or layout preconditions and a new
retained operation UUID. Preserve all existing `resolutionHistory` fields; only
Factory may append authenticated actor/source records. Pending target content
cannot be edited in the same decision. Do not flip resolved state; use exact owned
revision restoration when authorized. Recover a lost decision acknowledgement
through `document_operation`; never issue a replacement UUID for an unknown save.
Imported author/date metadata stays distinct from the local resolution actor.
