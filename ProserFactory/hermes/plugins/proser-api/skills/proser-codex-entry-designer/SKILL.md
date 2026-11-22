---
name: proser-codex-entry-designer
description: Use Proser tools and bundled helper scripts to name, draft, validate, deduplicate, and save codex/story-bible entries.
version: 1.0.0
author: Proser
metadata:
  hermes:
    tags:
      - writing
      - codex
      - story-bible
      - worldbuilding
    requires_tools:
      - proser_context
      - proser_codex
      - proser_generate
---

# Proser Codex Entry Designer

## When to Use

Use this skill when the user asks Hermes to create, improve, rename, split, merge, or audit Proser codex entries for characters, locations, lore, items, factions, events, rules, cultures, or relationships.

Use Proser as the source of record. Local helper scripts are for drafting, naming, linting, shaping payloads, import planning, coverage checks, graphing, and visual prompt preparation before tool calls.

## Entry Contract

Proser codex create/update calls use this body shape:

```json
{
  "entryType": "character",
  "entryName": "Vespera Vale",
  "entryDescription": "A concise story-bible description.",
  "attributes": "{\"role\":\"protagonist\"}"
}
```

Valid `entryType` values are `character`, `location`, `lore`, `item`, `faction`, `event`, `rule`, `culture`, and `relationship`.

## Workflow

1. Identify the book.
   - Use `proser_books` through `proser-authoring` if the book is unknown.
   - Do not invent `bookId` values.

2. Read compact context.
   - Use `proser_context` `book_map` for title, genre, summary, and structure.
   - Use `proser_context` `codex_brief` to inspect existing entries.
   - Use `proser_codex` `search` before creating entries that may overlap existing canon.

3. Generate or choose names.
   - Use `scripts/proser_codex_nameforge.py` for quick local name candidates.
   - Use `proser_generate` `character`, `location`, `item`, or `codex` when the user wants model-written descriptions or canon-rich expansion.
   - Keep names stable after they appear in saved prose unless the user asks for a rename.

4. Draft the entry.
   - Keep descriptions specific, compact, and reusable by RAG.
   - Put structured traits, aliases, affiliations, rules, or state in `attributes` as a JSON string.
   - Prefer one durable fact per field over vague atmosphere.

5. Validate and deduplicate.
   - Run `scripts/proser_codex_payload_builder.py` on batch drafts before saving.
   - Run `scripts/proser_codex_workbench.py merge-plan` when there are existing codex entries to compare against draft entries.
   - Run `scripts/proser_codex_workbench.py lint` for a style and RAG-usefulness pass.
   - Compare candidate names against `codex_brief` and `search` results.
   - If the draft duplicates an existing entry, update the existing entry instead of creating a second near-copy.

6. Save only accepted work.
   - Use `proser_codex` `create_entry` for new entries.
   - Use `proser_codex` `update_entry` for canonical corrections, merges, or renames.
   - Do not persist speculative entries unless the user explicitly delegates that choice.

7. Verify.
   - Use `proser_context` `codex_brief` or `proser_codex` `get_entry`.
   - Report saved entry IDs, entry types, and any unresolved duplicate/merge decisions.

## Helper Scripts

Run from this skill directory, or use the full plugin path.

Generate candidate names:

```bash
python3 scripts/proser_codex_nameforge.py \
  --entry-type character \
  --genre "gothic fantasy" \
  --motif "glass orchard memory" \
  --count 12 \
  --seed "book-42-cast"
```

Validate and shape Markdown or JSON drafts:

```bash
python3 scripts/proser_codex_payload_builder.py --book-id 42 draft-codex.md
```

The payload builder returns normalized `entries` and, when `--book-id` is supplied, ready-to-copy `proser_codex` `create_entry` argument objects.

Run the workbench for broader codex planning:

```bash
python3 scripts/proser_codex_workbench.py preset --entry-type character
python3 scripts/proser_codex_workbench.py lint --entries codex.json
python3 scripts/proser_codex_workbench.py merge-plan --existing codex.json --draft draft.json --book-id 42
python3 scripts/proser_codex_workbench.py live-merge-plan --book-id 42 --draft draft.json
python3 scripts/proser_codex_workbench.py live-coverage --book-id 42
python3 scripts/proser_codex_workbench.py extract-mentions --source manuscript.md --existing codex.json
python3 scripts/proser_codex_workbench.py dry-run-upload --draft draft.json --existing codex.json --book-id 42
python3 scripts/proser_codex_workbench.py upload-execute --plan upload-plan.json --confirm EXECUTE
```

The workbench is non-mutating except for `upload-execute`, which refuses to run unless `--confirm EXECUTE` is supplied. Live commands read Proser through the deployed plugin's existing `proser_context`, `proser_codex`, and `proser_books` tool handlers.

`extract-mentions` returns capitalized `candidates`, non-capitalized `aliasCandidates` for known entries, and pronoun-linked `relationshipCandidates` plus reviewable relationship draft entries. Treat alias and relationship candidates as evidence, not automatic saves.

## Workbench Tasks

Use these subcommands for the common codex maintenance jobs:

| Task | Command |
| --- | --- |
| Duplicate merge planner | `merge-plan --existing codex.json --draft draft.json --book-id 42` |
| Live duplicate merge planner | `live-merge-plan --book-id 42 --draft draft.json` |
| Scene mention extractor | `extract-mentions --source manuscript.md --existing codex.json` |
| Relationship graph helper | `graph --entries codex.json` |
| Attribute preset generator | `preset --entry-type character` or `preset --entry-type all` |
| Canon coverage report | `coverage --entries codex.json --scenes scenes.json` |
| Live canon coverage report | `live-coverage --book-id 42` |
| Bulk codex dry-run uploader | `dry-run-upload --draft draft.json --existing codex.json --book-id 42` |
| Confirmed uploader | `upload-execute --plan upload-plan.json --confirm EXECUTE` |
| Codex rename impact scout | `rename-scout --old-name "Old Name" --new-name "New Name" --source export.md` |
| Live codex rename impact scout | `live-rename-scout --book-id 42 --old-name "Old Name" --new-name "New Name"` |
| Style-consistency linter | `lint --entries codex.json` |
| Cross-book codex importer | `import-plan --source source-codex.json --target-existing target-codex.json --book-id 42` |
| Visual prompt bridge | `visual-prompts --entries codex.json --type character --type location` |

## Draft Formats

The payload builder accepts JSON:

```json
[
  {
    "type": "character",
    "name": "Vespera Vale",
    "description": "A botanist who inherits an orchard of recorded sins.",
    "attributes": {
      "role": "protagonist",
      "voice": "precise, guarded"
    }
  }
]
```

It also accepts Markdown:

```markdown
- [character] Vespera Vale: A botanist who inherits an orchard of recorded sins.
- location | The Glass Orchard | Trees whose fruit replay buried memories. | {"danger":"psychic residue"}

## faction: The Amber Pruners
Caretakers who prune memory-bearing trees and suppress family scandals.
```

## Pitfalls

- Do not save generated names without checking existing codex names first.
- Do not create vague entries that only repeat the book premise.
- Do not store nested objects directly in `attributes`; serialize them as JSON strings.
- Do not use external network calls for sensitive manuscript or canon material unless the user explicitly requests it.
- Do not treat `proser_generate` output as saved codex. Save through `proser_codex`.
- Do not execute workbench `toolCall` output blindly; compare it to the user's requested scope first.
- Do not run `upload-execute` unless the user has explicitly accepted the dry-run plan.
