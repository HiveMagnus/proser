"""Hermes tool schemas for the Proser API plugin."""

_JSON_OBJECT = {
    "type": "object",
    "description": "JSON object sent as the Proser request body for the selected action.",
    "additionalProperties": True,
}

_QUERY_OBJECT = {
    "type": "object",
    "description": "Query string parameters for GET actions.",
    "additionalProperties": True,
}

_TIMEOUT_SECONDS = {
    "type": "number",
    "minimum": 1,
    "maximum": 600,
    "description": (
        "Optional request timeout in seconds. Suggested values: 15-30 for read-only context/model/status calls, "
        "60-180 for prose, feedback, and image calls, and 300+ for Wizard or batch workflows."
    ),
}

PROSER_BOOKS = {
    "name": "proser_books",
    "description": (
        "Use Proser book, structure, scene, note, and export endpoints. "
        "Negotiate document_capabilities before editing. Read manifest/scoped revisions; supply exact documentPreconditions in compatibility mutation bodies, including deletes. Recover lost saves by document_operation before retrying. Never refresh expected revisions automatically. Allowed actions do not include wizard, prompt, model, settings, or admin calls."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "list_books",
                    "get_book",
                    "create_book",
                    "update_book",
                    "delete_book",
                    "document_capabilities",
                    "document_manifest",
                    "scene_document",
                    "scene_comments",
                    "revalidate_scene_comment",
                    "resolve_scene_comment",
                    "layout_story_comments",
                    "revalidate_layout_story_comment",
                    "resolve_layout_story_comment",
                    "document_scope",
                    "document_commit",
                    "document_layout_commit",
                    "document_operation",
                    "document_inference_operation",
                    "cancel_document_inference_operation",
                    "create_document_discussion",
                    "document_discussion",
                    "discussion_proposals",
                    "request_document_proposal",
                    "document_proposal",
                    "cancel_document_proposal",
                    "revalidate_document_proposal",
                    "apply_document_proposal",
                    "document_restore",
                    "operator_operations",
                    "operator_operation",
                    "cancel_operator_operation",
                    "get_structure",
                    "save_structure",
                    "create_act",
                    "update_act",
                    "delete_act",
                    "create_chapter",
                    "update_chapter",
                    "delete_chapter",
                    "list_scenes",
                    "list_chapter_scenes",
                    "get_scene",
                    "create_scene",
                    "update_scene",
                    "delete_scene",
                    "regenerate_scene",
                    "latest_scene_trace",
                    "submit_prose_preference",
                    "list_notes",
                    "create_note",
                    "update_note",
                    "delete_note",
                    "export_book",
                ],
                "description": "The scoped Proser book API action to perform.",
            },
            "bookId": {"type": "integer", "description": "Proser book ID."},
            "actId": {"type": "integer", "description": "Proser act ID."},
            "chapterId": {"type": "integer", "description": "Proser chapter ID."},
            "sceneId": {"type": "integer", "description": "Proser scene ID."},
            "noteId": {"type": "integer", "description": "Proser note ID."},
            "commentId": {"type": "string", "description": "Stable canonical classic comment ID; never select by quotation."},
            "storyId": {"type": "string", "description": "Stable owned front/back/header/footer layout story ID."},
            "discussionId": {"type": "string", "format": "uuid", "description": "Owned disclosed document discussion UUID."},
            "proposalId": {"type": "string", "format": "uuid", "description": "Exact retained document proposal UUID."},
            "operationId": {"type": "string", "format": "uuid", "description": "Exact retained document save operation UUID for recovery."},
            "revisionId": {"type": "string", "format": "uuid", "description": "Exact immutable revision to inspect or restore."},
            "scope": {"type": "string", "enum": ["structure", "canon", "layout"]},
            "body": _JSON_OBJECT,
            "query": _QUERY_OBJECT,
            "idempotencyKey": {
                "type": "string",
                "description": "Optional Idempotency-Key header for retry-safe POST calls.",
            },
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
    },
}

PROSER_EXPORTS = {
    "name": "proser_exports",
    "description": (
        "Create revision-bound server-side Markdown export artifacts without returning the full manuscript, inspect artifact metadata, "
        "read only a selected book/chapter/scene slice, or delete an artifact. Prefer this over proser_books export_book "
        "for finished manuscripts and reading requests. Negotiate document_capabilities and read document_manifest first. Active create_file requires body.operationId and body.expectedRevisionId; keep the operation ID after lost acknowledgements and recover it rather than creating a new effect. body.mode selects final, original or retain-review. Active publication history is immutable and delete_file rejects."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["capabilities", "get_job", "create_file", "get_file", "read_file", "delete_file"],
                "description": "The context-efficient export artifact action to perform.",
            },
            "bookId": {"type": "integer", "minimum": 1},
            "jobId": {"type": "string", "format": "uuid", "description": "Retained publication operation UUID for exact save/export recovery."},
            "artifactId": {"type": "string", "pattern": "^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$", "description": "Owned immutable publication artifact UUID under active structured authority; legacy inactive exports may use SHA-256 IDs."},
            "body": _JSON_OBJECT,
            "query": _QUERY_OBJECT,
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
    },
}

PROSER_CONTEXT = {
    "name": "proser_context",
    "description": (
        "Use compact read-only Proser context views for long-form book work. "
        "Returns book maps, scene briefs, codex briefs, and scene search hits without flooding the model with full prose."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["book_map", "scene_brief", "codex_brief", "search_scenes"],
                "description": "The compact context action to perform.",
            },
            "bookId": {"type": "integer", "description": "Proser book ID."},
            "sceneId": {"type": "integer", "description": "Proser scene ID for scene_brief."},
            "query": {
                "type": "object",
                "description": (
                    "Options such as q/search text, limit, pageSize, contextChars, maxSummaryChars, "
                    "maxOutlineChars, and maxProseChars."
                ),
                "additionalProperties": True,
            },
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action", "bookId"],
    },
}


PROSER_CODEX = {
    "name": "proser_codex",
    "description": (
        "Use Proser codex endpoints for story bible entries and RAG search. "
        "Allowed actions are limited to codex calls."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "list_entries",
                    "search",
                    "create_entry",
                    "get_entry",
                    "update_entry",
                    "delete_entry",
                ],
                "description": "The scoped Proser codex action to perform.",
            },
            "bookId": {"type": "integer", "description": "Proser book ID."},
            "codexId": {"type": "integer", "description": "Proser codex entry ID."},
            "body": _JSON_OBJECT,
            "query": _QUERY_OBJECT,
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
    },
}

PROSER_GENERATE = {
    "name": "proser_generate",
    "description": (
        "Use Proser generation endpoints for characters, locations, items, generic codex entries, "
        "outlines, summaries, titles, taglines, inline suggestions, feedback, structure, prose, "
        "and prose revision. For revise_prose, command_revise, inline_suggestion and feedback, negotiate owned book document capabilities. Active authority requires sceneId plus body.documentPreview {discussionId, operationId} from an owned disclosed discussion; Legacy originalText/context/content is optional and must equal its target texts if supplied. Results are typed proposals with source revisions, never automatic plaintext replacement. This tool intentionally excludes factory, wizard, and prompt calls."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "character",
                    "location",
                    "item",
                    "codex",
                    "outline",
                    "summary",
                    "title",
                    "tagline",
                    "inline_suggestion",
                    "feedback",
                    "structure",
                    "prose",
                    "batch_prose",
                    "revise_prose",
                    "command_revise",
                ],
                "description": "The scoped Proser generation action to perform.",
            },
            "body": _JSON_OBJECT,
            "idempotencyKey": {
                "type": "string",
                "description": "Optional Idempotency-Key header for retry-safe generation calls.",
            },
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action", "body"],
    },
}



# Flat, dedicated review tools intentionally avoid conditional schemas and
# arbitrary JSON bodies. Hermes grammar sanitizers preserve these fields even
# for small models that struggle with multiplexed action/body tools.













PROSER_SETTINGS = {
    "name": "proser_settings",
    "description": "Use Proser per-user settings endpoints for the authenticated Hermes profile.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["get", "update"],
                "description": "Settings action to perform.",
            },
            "body": _JSON_OBJECT,
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
    },
}

PROSER_MODELS = {
    "name": "proser_models",
    "description": "Inspect the configured Proser inference model list and runtime status.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "status"],
                "description": "Model/runtime action to perform.",
            },
            "query": _QUERY_OBJECT,
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
    },
}

PROSER_IMAGES = {
    "name": "proser_images",
    "description": (
        "Use scoped Proser image endpoints backed by Leonardo Forge. Supports health, listing, prompt suggestion, "
        "standard Forge generation, and Flux generation. Use 120-300 timeoutSeconds for generation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["health", "list", "suggest_prompt", "generate", "generate_flux"],
                "description": "Image action to perform.",
            },
            "body": _JSON_OBJECT,
            "query": _QUERY_OBJECT,
            "idempotencyKey": {
                "type": "string",
                "description": "Optional Idempotency-Key header for retry-safe image generation calls.",
            },
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
    },
}





_NOVEL_ACTIONS = [
    "preflight", "create_run", "get_status", "get_next_task", "get_task_packet",
    "get_story_packet", "get_act_packet", "get_chapter_packet", "get_scene_packet",
    "get_character_packet", "get_revision_packet", "submit_artifact", "approve_artifact",
    "reject_artifact", "retry_task", "pause", "resume", "rollback", "evaluate", "finalize",
    "export_audit", "stream_progress", "abandon",
]

_NOVEL_SETTINGS = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "targetWords": {"type": "integer", "minimum": 10000, "maximum": 250000},
        "targetLength": {"oneOf": [{"type": "integer", "minimum": 10000, "maximum": 250000}, {"type": "string", "enum": ["novella", "short", "novel", "long", "epic"]}]},
        "scenePlan": {"type": "object", "additionalProperties": False, "properties": {"acts": {"type": "integer", "minimum": 1, "maximum": 8}, "chaptersPerAct": {"type": "integer", "minimum": 1, "maximum": 20}, "scenesPerChapter": {"type": "integer", "minimum": 1, "maximum": 10}}, "required": ["acts", "chaptersPerAct", "scenesPerChapter"]},
        "writingStyle": {"type": "string"}, "pov": {"type": "string"}, "tense": {"type": "string"},
        "audience": {"type": "string"}, "mustInclude": {"type": "array", "items": {"type": "string"}},
        "mustAvoid": {"type": "array", "items": {"type": "string"}},
        "codexTargets": {"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}},
        "candidateCount": {"type": "integer", "minimum": 2, "maximum": 4},
        "autonomyMode": {"type": "string", "enum": ["manual", "supervised", "autonomous"]},
        "contextBudgets": {"type": "object", "additionalProperties": {"type": "integer", "minimum": 1000, "maximum": 140000}},
    },
}







# Every multiplexed tool keeps a discoverable action enum for Hermes while
# adding action-specific required fields and rejecting unknown top-level keys.
_ACTION_REQUIRED = {
    "proser_books": {
        "create_document_discussion": ["bookId", "body"], "document_discussion": ["bookId", "discussionId"],
        "discussion_proposals": ["bookId", "discussionId"], "request_document_proposal": ["bookId", "discussionId", "body"],
        "document_proposal": ["bookId", "proposalId"], "cancel_document_proposal": ["bookId", "proposalId"],
        "revalidate_document_proposal": ["bookId", "proposalId", "body"], "apply_document_proposal": ["bookId", "proposalId", "body"],
        "document_capabilities": ["bookId"], "document_manifest": ["bookId"],
        "scene_document": ["bookId", "sceneId"], "document_scope": ["bookId", "scope"],
        "document_commit": ["bookId", "body"], "document_layout_commit": ["bookId", "body"],
        "operator_operations": ["bookId"], "operator_operation": ["bookId", "operationId"], "cancel_operator_operation": ["bookId", "operationId"],
        "document_inference_operation": ["bookId", "operationId"], "cancel_document_inference_operation": ["bookId", "operationId"],
        "document_operation": ["bookId", "operationId"], "document_restore": ["bookId", "revisionId", "body"],
        "get_book": ["bookId"], "update_book": ["bookId", "body"], "delete_book": ["bookId"],
        "get_structure": ["bookId"], "save_structure": ["bookId", "body"], "create_act": ["bookId", "body"],
        "update_act": ["bookId", "actId", "body"], "delete_act": ["bookId", "actId"],
        "create_chapter": ["bookId", "actId", "body"], "update_chapter": ["bookId", "chapterId", "body"],
        "delete_chapter": ["bookId", "chapterId"], "list_scenes": ["bookId"],
        "list_chapter_scenes": ["bookId", "chapterId"], "get_scene": ["bookId", "sceneId"],
        "create_scene": ["bookId", "chapterId", "body"], "update_scene": ["bookId", "sceneId", "body"],
        "delete_scene": ["bookId", "sceneId"], "regenerate_scene": ["bookId", "sceneId"],
        "latest_scene_trace": ["bookId", "sceneId"], "submit_prose_preference": ["bookId", "sceneId", "body"],
        "list_notes": ["bookId"], "create_note": ["bookId", "body"], "update_note": ["bookId", "noteId", "body"],
        "create_book": ["body"],
    },
    "proser_exports": {
        "capabilities": ["bookId"],
        "get_job": ["bookId", "jobId"],
        "create_file": ["bookId"],
        "get_file": ["bookId", "artifactId"],
        "read_file": ["bookId", "artifactId", "query"],
        "delete_file": ["bookId", "artifactId"],
    },
    "proser_context": {action: ["bookId"] for action in ["book_map", "codex_brief", "search_scenes"]} | {"scene_brief": ["bookId", "sceneId"]},
    "proser_codex": {"list_entries": ["bookId"], "search": ["bookId"], "create_entry": ["bookId", "body"], "get_entry": ["codexId"], "update_entry": ["codexId", "body"], "delete_entry": ["codexId"]},
    "proser_generate": {action: ["body"] for action in PROSER_GENERATE["parameters"]["properties"]["action"]["enum"]},
    "proser_settings": {"update": ["body"]},
}

_STANDARD_RETURN = {
    "type": "object",
    "required": ["ok", "status"],
    "properties": {
        "ok": {"type": "boolean"}, "status": {"type": "integer"}, "result": {},
        "error": {"type": "object", "properties": {"code": {"type": "string"}, "message": {"type": "string"}, "field": {"type": "string"}, "retryable": {"type": "boolean"}, "safeToRepeat": {"type": "boolean"}, "currentState": {}, "expectedState": {}, "recommendedAction": {"type": "string"}}},
    },
}

for _schema_name, _schema in list(globals().items()):
    if not _schema_name.startswith("PROSER_") or not isinstance(_schema, dict) or "parameters" not in _schema:
        continue
    _parameters = _schema["parameters"]
    _parameters["additionalProperties"] = False
    _tool_name = _schema.get("name")
    _requirements = _ACTION_REQUIRED.get(_tool_name, {}) if isinstance(_tool_name, str) else {}
    if _requirements:
        _parameters.setdefault("allOf", []).extend([
            {"if": {"properties": {"action": {"const": _action}}}, "then": {"required": ["action", *_fields]}}
            for _action, _fields in _requirements.items()
        ])
    _schema.setdefault("returns", _STANDARD_RETURN)

_WORKFLOW_SCOPE = {
    "type": "object", "additionalProperties": False,
    "properties": {"type": {"type": "string", "enum": ["book", "act", "chapter", "scene"]}, "id": {"type": "integer", "minimum": 1}},
    "required": ["type"],
}
_IDEMPOTENCY_KEY = {"type": "string", "minLength": 8, "maxLength": 200, "description": "Stable client operation key. Reuse exactly on retries."}

PROSER_FULL_BOOK = {
    "name": "proser_full_book",
    "description": "Start the durable end-to-end Full Book workflow. It continues in the background and pauses only at author checkpoints or failures.",
    "parameters": {"type": "object", "additionalProperties": False, "properties": {
        "premise": {"type": "string", "minLength": 10}, "bookId": {"type": "integer", "minimum": 1},
        "title": {"type": "string"}, "genre": {"type": "string"}, "audience": {"type": "string"},
        "targetWords": {"type": "integer", "minimum": 10000, "maximum": 250000}, "pov": {"type": "string"}, "tense": {"type": "string"}, "style": {"type": "string"},
        "mustInclude": {"type": "array", "items": {"type": "string"}}, "mustAvoid": {"type": "array", "items": {"type": "string"}},
        "candidateCount": {"type": "integer", "minimum": 2, "maximum": 4}, "reviewModels": {"type": "array", "maxItems": 3, "items": {"type": "string"}},
        "maxEditorialRounds": {"type": "integer", "minimum": 1, "maximum": 3}, "idempotencyKey": _IDEMPOTENCY_KEY, "timeoutSeconds": _TIMEOUT_SECONDS,
    }, "required": ["premise", "idempotencyKey"]}, "returns": _STANDARD_RETURN,
}

PROSER_QUALITY_REVIEW_V1 = {
    "name": "proser_quality_review",
    "description": "Start one immutable read-only quality review round against an exact manuscript revision. Use separate calls for different models.",
    "parameters": {"type": "object", "additionalProperties": False, "properties": {
        "bookId": {"type": "integer", "minimum": 1}, "model": {"type": "string", "minLength": 1}, "rubricVersion": {"type": "string"},
        "scopeType": {"type": "string", "enum": ["book", "act", "chapter", "scene"]}, "scopeId": {"type": "integer", "minimum": 1}, "idempotencyKey": _IDEMPOTENCY_KEY, "timeoutSeconds": _TIMEOUT_SECONDS,
    }, "required": ["bookId", "model", "idempotencyKey"]}, "returns": _STANDARD_RETURN,
}

PROSER_IMPROVE_QUALITY = {
    "name": "proser_improve_quality",
    "description": "Implement stored findings from one or more quality review rounds. Safe edits auto-apply; high-impact or conflicting advice creates a checkpoint.",
    "parameters": {"type": "object", "additionalProperties": False, "properties": {
        "bookId": {"type": "integer", "minimum": 1}, "reviewRunIds": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"type": "string", "format": "uuid"}},
        "findingIds": {"type": "array", "maxItems": 500, "items": {"type": "string", "format": "uuid"}}, "model": {"type": "string"}, "idempotencyKey": _IDEMPOTENCY_KEY, "timeoutSeconds": _TIMEOUT_SECONDS,
    }, "required": ["bookId", "reviewRunIds", "idempotencyKey"]}, "returns": _STANDARD_RETURN,
}

PROSER_GUIDED_IMPROVE = {
    "name": "proser_guided_improve",
    "description": "Apply a general author instruction to an existing book with safe auto-application and checkpoints for structural or canon changes.",
    "parameters": {"type": "object", "additionalProperties": False, "properties": {
        "bookId": {"type": "integer", "minimum": 1}, "instruction": {"type": "string", "minLength": 3}, "scopeType": {"type": "string", "enum": ["book", "act", "chapter", "scene"]},
        "scopeId": {"type": "integer", "minimum": 1}, "model": {"type": "string"}, "acceptanceCriteria": {"type": "array", "maxItems": 50, "items": {"type": "string"}}, "idempotencyKey": _IDEMPOTENCY_KEY, "timeoutSeconds": _TIMEOUT_SECONDS,
    }, "required": ["bookId", "instruction", "idempotencyKey"]}, "returns": _STANDARD_RETURN,
}

def _run_schema(name: str, description: str, extra: dict[str, object] | None = None) -> dict[str, object]:
    properties: dict[str, object] = {"runId": {"type": "string", "format": "uuid"}, "timeoutSeconds": _TIMEOUT_SECONDS}
    if extra: properties.update(extra)
    return {"name": name, "description": description, "parameters": {"type": "object", "additionalProperties": False, "properties": properties, "required": ["runId"]}, "returns": _STANDARD_RETURN}

PROSER_WORKFLOW_STATUS = _run_schema("proser_workflow_status", "Read compact workflow, manuscript, child-run, checkpoint, and finding progress.")
PROSER_WORKFLOW_PAUSE = _run_schema("proser_workflow_pause", "Pause a workflow at its next safe boundary.")
PROSER_WORKFLOW_RESUME = _run_schema("proser_workflow_resume", "Resume a paused or failed workflow with a fresh background job.")
PROSER_WORKFLOW_CANCEL = _run_schema("proser_workflow_cancel", "Cancel a workflow and preserve its audit trail.")
PROSER_PUBLICATION = _run_schema("proser_publication", "Read the release gates and publication package for a Full Book workflow.")
PROSER_WORKFLOW_CHECKPOINT = _run_schema("proser_workflow_checkpoint", "Approve or reject one pending author checkpoint.", {
    "checkpointId": {"type": "string", "format": "uuid"}, "decision": {"type": "string", "enum": ["approved", "rejected"]}, "reason": {"type": "string"},
})
PROSER_WORKFLOW_CHECKPOINT["parameters"]["required"] = ["runId", "checkpointId", "decision"]

PROSER_EDITORIAL_OPTIMIZE = {
    "name": "proser_editorial_optimize",
    "description": (
        "Start exactly one bounded, durable autonomous editorial workflow. "
        "Uncertain, stale, risky, or disputed edits are retained as original and reported; this workflow never requests a checkpoint."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "bookId": {"type": "integer", "minimum": 1},
            "scopeType": {"type": "string", "enum": ["book", "act", "chapter", "scene"]},
            "scopeId": {"type": "integer", "minimum": 1},
            "objective": {"type": "string", "minLength": 3, "maxLength": 4000},
            "passPack": {"type": "string", "enum": ["line_edit_safe", "dialogue", "voice_preservation", "scene_energy", "continuity", "name_originality", "final_polish", "custom"]},
            "autonomy": {"type": "string", "enum": ["review_only", "propose_only", "safe_auto", "max_quality_auto"]},
            "profileId": {"type": "string", "format": "uuid"},
            "protectedElements": {"type": "array", "maxItems": 100, "items": {"type": "string", "maxLength": 200}},
            "changeBudget": {"type": "object", "additionalProperties": False, "properties": {
                "maxChangedWordsPercentPerScene": {"type": "number", "minimum": 0, "maximum": 18},
                "maxChangedWordsPercentTotal": {"type": "number", "minimum": 0, "maximum": 12},
                "maxProposals": {"type": "integer", "minimum": 0, "maximum": 100},
                "maxCandidatesPerProposal": {"type": "integer", "minimum": 1, "maximum": 2},
                "maxInferenceTokens": {"type": "integer", "minimum": 0, "maximum": 100000},
                "maxJudgeEscalations": {"type": "integer", "minimum": 0, "maximum": 2},
            }},
            "modelPolicy": {"type": "object", "additionalProperties": False, "properties": {
                "generator": {"type": "string"}, "primaryJudge": {"type": "string"},
                "secondaryJudge": {"type": "string"}, "tieBreakerJudge": {"type": "string"},
                "longRangeCritic": {"type": "string"},
            }},
            "idempotencyKey": _IDEMPOTENCY_KEY,
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["bookId", "passPack", "autonomy", "idempotencyKey"],
    },
    "returns": _STANDARD_RETURN,
}

PROSER_EDITORIAL = {
    "name": "proser_editorial",
    "description": (
        "Read bounded editorial pass, profile, run, proposal, and Quality Lab evidence or record optional feedback. "
        "This tool never returns a whole manuscript or hidden benchmark expectations."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "action": {"type": "string", "enum": [
                "list_passes", "resolve_profile", "run_summary", "list_proposals", "get_proposal",
                "record_preference", "apply_proposal", "run_benchmark", "benchmark_status", "benchmark_report",
            ]},
            "bookId": {"type": "integer", "minimum": 1},
            "runId": {"type": "string", "format": "uuid"},
            "proposalId": {"type": "string", "format": "uuid"},
            "candidateId": {"type": "string", "format": "uuid"},
            "benchmarkRunId": {"type": "string", "format": "uuid"},
            "evidenceType": {"type": "string", "enum": ["choose_candidate", "choose_original", "reject_all", "undo_auto_edit", "manual_rewrite", "dismiss_finding", "explicit_profile_rule"]},
            "rationaleTags": {"type": "array", "maxItems": 8, "items": {"type": "string", "enum": ["clarity", "rhythm", "voice", "subtlety", "specificity", "pacing", "dialogue", "canon"]}},
            "suiteKey": {"type": "string"}, "passPack": {"type": "string"},
            "live": {"type": "boolean"}, "maximumCases": {"type": "integer", "minimum": 1, "maximum": 20},
            "query": {"type": "object", "additionalProperties": True},
            "idempotencyKey": _IDEMPOTENCY_KEY,
            "timeoutSeconds": _TIMEOUT_SECONDS,
        },
        "required": ["action"],
        "allOf": [
            {"if": {"properties": {"action": {"const": "resolve_profile"}}}, "then": {"required": ["bookId"]}},
            {"if": {"properties": {"action": {"enum": ["run_summary", "list_proposals"]}}}, "then": {"required": ["runId"]}},
            {"if": {"properties": {"action": {"enum": ["get_proposal", "record_preference", "apply_proposal"]}}}, "then": {"required": ["proposalId"]}},
            {"if": {"properties": {"action": {"const": "get_proposal"}}}, "then": {"required": ["runId"]}},
            {"if": {"properties": {"action": {"const": "record_preference"}}}, "then": {"required": ["evidenceType"]}},
            {"if": {"properties": {"action": {"const": "apply_proposal"}}}, "then": {"required": ["candidateId"]}},
            {"if": {"properties": {"action": {"const": "run_benchmark"}}}, "then": {"required": ["idempotencyKey"]}},
            {"if": {"properties": {"action": {"enum": ["benchmark_status", "benchmark_report"]}}}, "then": {"required": ["benchmarkRunId"]}},
        ],
    },
    "returns": _STANDARD_RETURN,
}
