---
name: proser-editorial
description: Run one bounded autonomous Proser editorial pass, poll compact status, and report revision-safe evidence without fetching a manuscript or requesting checkpoints.
---

# Proser Editorial

Use this skill for prose polish, dialogue, voice, scene-energy, continuity, name-review, final-edit, and other bounded editorial requests.

## Route intent to one pass

- "polish", "tighten", "clean up", or "improve prose" → `line_edit_safe`
- "improve dialogue" or "make voices distinct" → `dialogue`
- "preserve voice", "stop generic prose", or "character voices" → `voice_preservation`
- "improve pacing", "strengthen scene", or "scene energy" → `scene_energy`
- "check continuity" or "fix contradictions" → `continuity`
- "review names" or "better character names" → `name_originality`
- "final edit" or "publication polish" → `final_polish`
- a specific bounded objective → `custom` with the objective copied precisely

## Operating contract

1. Resolve the book ID and the narrowest useful `scene`, `chapter`, `act`, or `book` scope. Never fetch whole manuscript prose.
2. Use `safe_auto` for requested line, dialogue, and final polish. Use `review_only` for broad diagnostics when the user did not ask to change text. Use `max_quality_auto` only when the user explicitly requests the strongest autonomous improvement.
3. Infer named protected elements from the request. Keep arrays bounded.
4. Create a stable request identity and call `proser_editorial_optimize` exactly once. Reuse the same idempotency key on retry.
5. Treat HTTP 202 as accepted background work. Poll `proser_workflow_status` compactly until `terminal` is true.
6. Never call `proser_workflow_checkpoint` for `editorial_optimize`. The engine preserves/skips uncertain work and cannot pause for approval.
7. Read the final compact summary with `proser_editorial action=run_summary`. Read proposal pages only when the user asks for evidence or optional post-run action.
8. Report source/result revision IDs and applied, original-retained, no-clear-winner, skipped, verification-failed, and unresolved counts.
9. Explain that skipped work retained the original. Optional preferences do not reopen the completed run.
10. Suggest another pass only after this run is terminal. Do not create an automatic pass chain.

Quality Lab requests use `proser_editorial action=run_benchmark` with a bounded deterministic suite by default. Hidden expected outcomes are scorer-only and must never be requested or exposed.
