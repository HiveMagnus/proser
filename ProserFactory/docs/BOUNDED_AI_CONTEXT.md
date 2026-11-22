# Bounded manuscript discussion

Factory accepts `localOperations` on the existing document-discussion request:
`{ operationId, operations }`. The operation ID is the same UUID the editor will
use to flush those intentions. Text, run-format and paragraph-format intentions
use the generated passage-operation contract and exact run, paragraph and
container hashes. Attribution, Canvas commands, assets and history are not inputs.
Factory derives the draft from the owned immutable saved scene and its owned
styles/layout; the request never needs a complete scene document.

The derivative is limited to 32 typed intentions and 256 KiB. Paragraph structure,
images, tables and review changes require an acknowledged save before context
preparation. Compatibility `localDocument` snapshots may alter text and supported
styles only; their paragraph/run identities, container structure, protected objects,
review records and layout must match the saved source.

The response discloses the final projection, exact saved revisions, draft digest,
draft operation UUID, frozen qualified selections, complete included paragraphs,
codex/history and omitted identities. A selected excerpt does not permit silently
truncating its paragraph. If complete target blocks exceed the conservative model
context budget, Factory returns `413 DOCUMENT_CONTEXT_TOO_LARGE` before creating
provider work. The author can select different complete blocks or save first.

Proposal inference retains the original bounded intentions and recreates them from
immutable owned source before validating model edits. The model supplies exact target
IDs, source text and replacement text; it cannot provide commands, markup, assets,
attribution or publication authority. Unknown provider effects remain recoverable
under their exact operation ID and never authorize an automatic repeat.

Application flushes the same draft operation, explicitly revalidates target text,
formatting, protected objects, containers and scene/chapter/act/layout provenance,
then creates tracked edits atomically. A changed or ambiguous target fails visibly.
Proposal application receipts contain revision references rather than whole scenes;
recovery uses the same immutable receipt. Accepting/rejecting a change and approving
quality/publication remain separate recorded actions.

The Author bounded discussion adapter receives passage excerpts, qualified target
coordinates, bounded intentions and the flush/reload interface. It shares the saved
discussion, cancellation, recovery and context disclosure UI with the existing editor.
Changing the passage, selection or intention UUID invalidates a prepared disclosure.
Clipped excerpt coordinates are not guessed after edits; the session must provide
canonical derivative offsets. These checks do not establish Microsoft Word behavior
or the separately deferred device and full performance acceptance.

## Owned layout-story discussion

Header/footer and front/back matter use explicit `sourceKind: layout-story`,
`storyId`, immutable book/layout revisions, canonical story hash and owned style,
object and parent-context hashes. They never borrow a scene ID. Schema migration
22 adds independent immutable discussion and validation evidence plus recoverable
proposal records; existing scene history remains unchanged.

`GET /api/books/:bookId/layout-stories/:storyId/document` returns an owned source;
optional `bookRevisionId` pins the exact historical manifest. The story discussion,
proposal, revalidation and tracked-apply endpoints follow the same inference policy,
budget, provider receipt, cancellation, admission fence and unknown-effect rules as
scene discussion. Conversation snapshots state their genuine layout source.

Author prepares at most 32/256 KiB typed text and supported style intentions against
exact saved paragraph/run/container hashes. Homogeneous Canvas text-run splits can
map to the original run only when styles, objects and review metadata agree.
Ambiguous styled identities, changed objects/structure and combined text/style
changes require a save before inference. Complete target paragraphs remain subject
to the model budget. No quotation search can relocate a story or target.

The existing layout recovery journal persists the story intention UUID and exact
request before dispatch. Application flushes that same typed operation, adopts the
immutable acknowledged layout source, revalidates the proposal, and applies tracked
changes. Sparse receipts identify exact book/layout revisions and story hashes;
other scenes, stories and layout settings remain preserved. Review resolution and
publication approval remain separate actions.
