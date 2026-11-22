# Skill Ideas

Markdown checklist for ProserFactory Hermes Agent Skill enhancements.

## Implemented

- [x] Add `proser-codex-entry-designer` Skill for creating, naming, validating, deduplicating, and saving Proser codex entries.
- [x] Add `proser_codex_nameforge.py` for deterministic local name candidates by codex entry type, genre, motif, tone, seed, and avoid list.
- [x] Add `proser_codex_payload_builder.py` to normalize Markdown/JSON codex drafts into Proser `create_entry` bodies and flag invalid types, missing names, overlong fields, and duplicates.
- [x] Wire the new Skill into plugin registration and remote Hermes skill-discovery symlinks.
- [x] Document the new Skill and helper scripts in `HERMES_AGENT_PLUGIN.md`.
- [x] Codex duplicate merge planner: `proser_codex_workbench.py merge-plan` compares existing codex entries and draft batches, then recommends create/update actions without mutating data.
- [x] Scene mention extractor: `proser_codex_workbench.py extract-mentions` scans exported scenes or manuscripts for repeated capitalized entities that should become codex candidates.
- [x] Relationship graph helper: `proser_codex_workbench.py graph` emits JSON nodes/edges and Mermaid graph text from character, faction, relationship, and mention data.
- [x] Attribute preset generator: `proser_codex_workbench.py preset` provides per-type JSON attribute templates for characters, locations, factions, items, rules, cultures, and the other Proser codex types.
- [x] Canon coverage report: `proser_codex_workbench.py coverage` compares scene text against codex entries and flags weak scenes plus uncovered entries.
- [x] Bulk codex dry-run uploader: `proser_codex_workbench.py dry-run-upload` reads draft entries, checks duplicates when an existing codex export is supplied, and produces confirmed upload steps for Hermes tool calls.
- [x] Codex rename impact scout: `proser_codex_workbench.py rename-scout` searches scenes, notes, summaries, attributes, or exported files for old names before a rename.
- [x] Style-consistency linter: `proser_codex_workbench.py lint` detects descriptions that are vague, too short, too long for RAG, prose-toned, or missing useful structured attributes.
- [x] Cross-book codex importer: `proser_codex_workbench.py import-plan` maps exported entries from one Proser book into another with rename and duplicate controls.
- [x] Visual prompt bridge: `proser_codex_workbench.py visual-prompts` derives `proser_images` prompt seeds from character, location, item, faction, and culture entries.
- [x] Live API wrappers: `proser_codex_workbench.py live-merge-plan`, `live-coverage`, and `live-rename-scout` read directly through the deployed plugin's Proser tool handlers without saving intermediate JSON.
- [x] Fixture-backed unit tests: `tests/test_proser_codex_workbench.py` covers every `proser_codex_workbench.py` subcommand with local fixtures and a mocked upload executor.
- [x] Optional confirmed uploader: `proser_codex_workbench.py upload-execute` executes dry-run `proser_codex` calls only after explicit `--confirm EXECUTE`.
- [x] Richer entity extraction: `proser_codex_workbench.py extract-mentions` now includes non-capitalized alias candidates for known entries and pronoun-linked relationship candidates with draft relationship entries.

## Future Ideas

Future ideas, not part of the completed backlog:

- Add a Hermes-native approval prompt before `upload-execute` when the runtime supports interactive confirmations.
