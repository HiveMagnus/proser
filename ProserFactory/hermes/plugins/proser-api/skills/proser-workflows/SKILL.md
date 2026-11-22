---
name: proser-workflows
description: Guide authors through durable Full Book, Quality Review, Improve Quality, and Guided Improve workflows without carrying production state in conversation memory.
version: 1.0.0
author: Proser
metadata:
  hermes:
    tags: [writing, novels, quality, revision]
    requires_tools: [proser_full_book, proser_quality_review, proser_improve_quality, proser_guided_improve, proser_workflow_status, proser_workflow_checkpoint]
---

# Proser Workflows

Choose exactly one launch tool from the user's intent:

- `proser_full_book`: create a complete new manuscript with review and improvement integrated.
- `proser_quality_review`: read-only diagnosis. Start separate rounds when the user requests different models.
- `proser_improve_quality`: implement stored findings from named review run IDs.
- `proser_guided_improve`: implement a general author instruction without requiring review findings.

After launch, report the `runId` and use `proser_workflow_status` for compact progress. The server continues after the chat ends. Do not recreate task state from conversation history and do not submit prose or artifact JSON manually.

When status returns a checkpoint, summarize its proposal and use `proser_workflow_checkpoint` only after the author decides. Safe localized changes apply automatically; structural, canon, POV, tense, chronology, ending, and cross-chapter changes require approval.

On the managed Nova profile, the operator has delegated these author decisions
to Nova for the requested work. Read the exact proposal using
`proser_workflow_evidence`, evaluate its acceptance criteria, and record Nova's
reasoned approval or rejection without a routine human stop. Inspect publication
gates before `proser_workflow_finalize`. A rejected candidate remains evidence;
do not present it as applied. Cancel a rejected paused run before another edit,
then confirm its terminal state. Use the managed request/operation keys and
native image import/download tools for illustrated delivery.

Quality review never edits the manuscript. Its findings remain stored by model and revision. Improve Quality marks each finding implemented only after prose persistence, then records verification separately.
