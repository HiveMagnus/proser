---
name: proser-book-reader
description: Export finished Proser books without loading the manuscript into context, then read and present only the requested book, chapter, or scene.
version: 2.0.0
author: Proser
metadata:
  hermes:
    tags:
      - writing
      - books
      - reading
      - export
    requires_tools:
      - proser_books
      - proser_context
      - proser_exports
---

# Proser Book Reader

## When to Use

Use this skill when the user asks Hermes to export a finished Proser book or to read, quote, or present a book, chapter, or scene stored in Proser.

The export artifact stays on ProserFactory. `create_file` returns metadata and a table of contents, never the manuscript body. `read_file` returns only the selected scope. This keeps unrelated chapters out of the model context.

## Export Without Reading

1. Resolve the book with `proser_books` `list_books` or `proser_context` `book_map`. Never guess a book ID.
2. Negotiate `proser_books` `document_capabilities`. When structured authority is enabled, read `proser_exports` `capabilities` and `proser_books` `document_manifest`. For active schema version 1, retain its exact revision ID and a fresh operation UUID. Call `proser_exports`:

```json
{
  "action": "create_file",
  "bookId": 12,
  "body": {
    "format": "markdown",
    "operationId": "<stable UUID for this export>",
    "expectedRevisionId": "<revisionId from document_manifest>",
    "mode": "final",
    "preset": "saved"
  }
}
```

3. Return the artifact ID, exact source revision, filename, byte size, checksum, download path and specific fidelity losses. Include the review sidecar path for markup exports. Do not call `read_file` unless the user also asked to read content.

## Read a Chapter or Scene

1. Resolve the book ID.
2. Call `create_file` with `format: markdown`. Active authority requires the exact saved manifest revision and a retained operation UUID. A repeated request with the same operation and options recovers its original artifact; a new operation creates a distinct durable history record. After an unknown outcome, call `proser_exports` `get_job` with `jobId` equal to the retained operation UUID before retrying. A completed job returns its artifact UUID; a pending/running/failed result must be reconciled without inventing a new operation.
3. Use the returned `tableOfContents` to resolve the exact chapter or scene. Prefer stable `chapterId` or `sceneId`; use act/chapter/scene numbers only when unambiguous.
4. Read only the requested scope.

Chapter example:

```json
{
  "action": "read_file",
  "bookId": 12,
  "artifactId": "<artifact UUID from create_file>",
  "query": {
    "scope": "chapter",
    "chapterId": 34,
    "maxChars": 60000
  }
}
```

Scene example:

```json
{
  "action": "read_file",
  "bookId": 12,
  "artifactId": "<artifact UUID from create_file>",
  "query": {
    "scope": "scene",
    "sceneId": 56,
    "maxChars": 60000
  }
}
```

5. Present `result.content` verbatim to the user. Do not summarize, critique, rewrite, or add missing prose unless explicitly asked.
6. If `truncated` is true, call `read_file` again with `offset: nextOffset`. Present the chunks in order without duplicating boundaries.

## Read a Whole Book

Use `scope: book` only when the user explicitly asks to read or present the complete book. Retrieve bounded chunks with `maxChars`, follow `nextOffset`, and preserve order. For ordinary questions about a book, use `proser_context` rather than loading the manuscript.

## Freshness and Safety

- Active artifacts bind to immutable source manifest/scoped revisions and remain readable after newer edits. Their UUID identifies the artifact; the returned SHA-256 verifies bytes. Historical exports are not silently deleted or pruned.
- A final export projects unresolved changes without accepting them in the manuscript. Publication-ready release approval remains a separate gated action. `retain-review` includes explicit review sidecars where Markdown lacks native semantics.
- On `412`, explicitly reconcile the stale source and create a deliberate new request; never refresh preconditions automatically. On a lost acknowledgement, recover the original operation ID and options.
- Do not use the legacy `proser_books` `export_book` action for finished manuscripts; it returns the entire manuscript through the tool context.
- Do not include codex, metadata, or summaries unless the user asks for them.
- Active publication history is immutable; `delete_file` returns an explicit immutability conflict. Inactive legacy artifacts retain their previous cleanup behavior. Do not promise deletion of durable publication records.

## Verification

After export, confirm that the response contains metadata and `tableOfContents` but no `content` field. After a reading request, verify that `selection` identifies the requested chapter or scene and that `truncated` is false, or continue from `nextOffset` until complete.
