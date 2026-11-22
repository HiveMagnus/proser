-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "github_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "genre" TEXT,
    "target_audience" TEXT,
    "draft_status" TEXT DEFAULT 'draft',
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "tagline" TEXT,
    "story_outline" TEXT,
    "story_archetype_key" TEXT,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_entries" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "entry_type" TEXT NOT NULL,
    "entry_name" TEXT NOT NULL,
    "entry_description" TEXT,
    "attributes" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "codex_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acts" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "act_number" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "acts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" SERIAL NOT NULL,
    "act_id" INTEGER NOT NULL,
    "chapter_number" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenes" (
    "id" SERIAL NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "scene_number" INTEGER NOT NULL,
    "outline" TEXT,
    "beats_meta" JSONB,
    "summary" TEXT,
    "prose" TEXT,
    "word_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_codex_usage" (
    "id" SERIAL NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "codex_id" INTEGER NOT NULL,
    "used_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "rationale" TEXT,

    CONSTRAINT "scene_codex_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_history" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER,
    "prompt" TEXT NOT NULL,
    "generated_content" TEXT NOT NULL,
    "model_used" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prose_traces" (
    "id" SERIAL NOT NULL,
    "trace_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER NOT NULL,
    "act_id" INTEGER,
    "chapter_id" INTEGER,
    "scene_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "judge_status" TEXT,
    "recipe_version" TEXT,
    "genre_key" TEXT,
    "adapter_used" TEXT,
    "model_used" TEXT,
    "prompt_text" TEXT,
    "brief" TEXT,
    "prompt_context_json" TEXT,
    "validator_results_json" TEXT,
    "judge_summary_json" TEXT,
    "trainer_training_run_id" TEXT,
    "trainer_preference_pair_id" TEXT,
    "trainer_online_run_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prose_traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prose_trace_candidates" (
    "id" SERIAL NOT NULL,
    "prose_trace_id" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "candidate_type" TEXT NOT NULL,
    "selection_label" TEXT,
    "accepted" BOOLEAN,
    "rejected" BOOLEAN,
    "output_text" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "overall_score" DOUBLE PRECISION,
    "tier" TEXT,
    "metadata_json" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prose_trace_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prose_findings" (
    "id" SERIAL NOT NULL,
    "prose_trace_id" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "finding_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT,
    "message" TEXT NOT NULL,
    "excerpt" TEXT,
    "suggestion" TEXT,
    "rationale" TEXT,
    "from_offset" INTEGER,
    "to_offset" INTEGER,
    "metadata_json" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prose_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prose_compare_cards" (
    "id" SERIAL NOT NULL,
    "prose_trace_id" INTEGER NOT NULL,
    "prose_finding_id" INTEGER,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "excerpt" TEXT,
    "option_a_label" TEXT NOT NULL DEFAULT 'Keep',
    "option_a_text" TEXT NOT NULL,
    "option_b_label" TEXT NOT NULL DEFAULT 'Revise',
    "option_b_text" TEXT NOT NULL,
    "recommended_option" TEXT,
    "rationale" TEXT,
    "from_offset" INTEGER,
    "to_offset" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "metadata_json" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prose_compare_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prose_actions" (
    "id" SERIAL NOT NULL,
    "prose_trace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "prose_finding_id" INTEGER,
    "prose_compare_card_id" INTEGER,
    "action_type" TEXT NOT NULL,
    "metadata_json" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prose_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "config_json" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_cache" (
    "id" SERIAL NOT NULL,
    "model" TEXT NOT NULL,
    "recipe_version" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "ttl_sec" INTEGER NOT NULL DEFAULT 604800,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_hit_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_chunks" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding" JSONB,
    "embed_model" TEXT,
    "embed_version" TEXT,
    "token_count" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_eval_results" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "eval_type" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "orchestrator" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_memory_events" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "actors" JSONB NOT NULL,
    "location" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scene_memory_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_states" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "codex_id" INTEGER NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "state_key" TEXT NOT NULL,
    "state_value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plot_threads" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "thread_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "description" TEXT,
    "first_scene_id" INTEGER,
    "last_scene_id" INTEGER,
    "due_horizon" TEXT,
    "actors" JSONB,
    "notes" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plot_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_runs" (
    "id" SERIAL NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "skill_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "latency_ms" INTEGER,
    "findings" JSONB,
    "input_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_corpus_cases" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "genre" TEXT,
    "suite_key" TEXT NOT NULL DEFAULT 'legacy',
    "suite_version" TEXT NOT NULL DEFAULT '1.0.0',
    "case_version" TEXT NOT NULL DEFAULT '1.0.0',
    "tags" JSONB,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "input" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "invariant_rules" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL DEFAULT '',
    "expected_hash" TEXT NOT NULL DEFAULT '',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "updated_by_build_revision" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_corpus_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_runs" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "suite_key" TEXT NOT NULL,
    "suite_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "config" JSONB NOT NULL,
    "code_revision" TEXT NOT NULL,
    "schema_revision" TEXT NOT NULL,
    "metrics" JSONB,
    "report_hash" TEXT,
    "report" JSONB,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_results" (
    "id" TEXT NOT NULL,
    "evaluation_run_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "source_revision_id" TEXT,
    "pass_key" TEXT NOT NULL,
    "pass_version" TEXT NOT NULL,
    "model" TEXT,
    "recipe_version" TEXT,
    "sampling_hash" TEXT,
    "rag_hash" TEXT,
    "policy_version" TEXT NOT NULL,
    "profile_version" TEXT,
    "judge_profile" TEXT,
    "verdict" TEXT NOT NULL,
    "expected_match" BOOLEAN,
    "hard_invariants" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "inference_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflow_type" TEXT NOT NULL,
    "parent_run_id" TEXT,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_revision_id" TEXT,
    "result_revision_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "status_version" INTEGER NOT NULL DEFAULT 0,
    "phase" TEXT NOT NULL DEFAULT 'queued',
    "settings" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL DEFAULT '',
    "idempotency_key" TEXT NOT NULL,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "execution_parent_run_id" TEXT,
    "recovery_lease_owner" TEXT,
    "recovery_lease_expires_at" TIMESTAMP(3),
    "progress" JSONB,
    "model_policy" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "failure_class" TEXT,
    "last_heartbeat_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_tasks" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "task_key" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT,
    "ordinal" INTEGER NOT NULL,
    "dependencies" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "model_used" TEXT,
    "input_revision_id" TEXT,
    "output_revision_id" TEXT,
    "validation_result" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "lease_owner" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_artifacts" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "task_id" TEXT,
    "artifact_type" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "source_revision_id" TEXT,
    "result_revision_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_checkpoints" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "checkpoint_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposal" JSONB NOT NULL,
    "decision" TEXT,
    "reason" TEXT,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMP(3),
    "lease_owner" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_enqueue_outbox" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_enqueue_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" SERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manuscript_revisions" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "parent_revision_id" TEXT,
    "workflow_run_id" TEXT,
    "lease_owner" TEXT,
    "content_hash" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "changed_scopes" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manuscript_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_review_runs_v1" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "source_revision_id" TEXT NOT NULL,
    "model_used" TEXT NOT NULL,
    "rubric_version" TEXT NOT NULL,
    "prompt_recipe" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "coverage" JSONB NOT NULL,
    "score" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_review_runs_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_findings_v1" (
    "id" TEXT NOT NULL,
    "review_run_id" TEXT NOT NULL,
    "related_fingerprint" TEXT,
    "fingerprint" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" TEXT,
    "recommendation" TEXT,
    "implemented" BOOLEAN NOT NULL DEFAULT false,
    "implemented_at" TIMESTAMP(3),
    "implementing_workflow_run_id" TEXT,
    "implemented_revision_id" TEXT,
    "changed_scopes" JSONB,
    "diff_summary" TEXT,
    "verification_status" TEXT NOT NULL DEFAULT 'not_implemented',
    "verification_evidence" TEXT,
    "verified_at" TIMESTAMP(3),
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "waiver_reason" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "detector_key" TEXT,
    "detector_version" TEXT,
    "risk_level" TEXT NOT NULL DEFAULT 'medium',
    "autofix_eligible" BOOLEAN NOT NULL DEFAULT false,
    "editorial_pass_key" TEXT,
    "editorial_pass_version" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_findings_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_runs" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "source_revision_id" TEXT NOT NULL,
    "result_revision_id" TEXT,
    "profile_id" TEXT,
    "profile_version" TEXT,
    "profile_hash" TEXT,
    "pass_pack_key" TEXT NOT NULL,
    "pass_pack_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "autonomy" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "outcome" TEXT,
    "request_config" JSONB NOT NULL,
    "metrics" JSONB,
    "evidence_summary" JSONB,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_proposals" (
    "id" TEXT NOT NULL,
    "editorial_run_id" TEXT NOT NULL,
    "source_revision_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "pass_key" TEXT NOT NULL,
    "pass_version" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "fingerprint" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "original_text" TEXT NOT NULL,
    "before_anchor" TEXT,
    "after_anchor" TEXT,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "expected_benefits" JSONB NOT NULL,
    "protected_claims" JSONB NOT NULL,
    "finding_ids" JSONB NOT NULL,
    "detector_ids" JSONB NOT NULL,
    "auto_applied" BOOLEAN NOT NULL DEFAULT false,
    "verification_status" TEXT NOT NULL DEFAULT 'pending',
    "verification_evidence" JSONB,
    "applied_revision_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_candidates" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "candidate_type" TEXT NOT NULL,
    "producer_profile" TEXT,
    "producer_model" TEXT,
    "recipe_version" TEXT,
    "sampling_hash" TEXT,
    "rag_hash" TEXT,
    "output_text" TEXT NOT NULL,
    "output_hash" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_evaluations" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "evaluator_profile" TEXT NOT NULL,
    "evaluator_version" TEXT NOT NULL,
    "evaluator_model" TEXT,
    "prompt_recipe" TEXT NOT NULL,
    "candidate_order" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "preferred_candidate_id" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "preference_margin" DOUBLE PRECISION NOT NULL,
    "dimension_scores" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "hard_check_summary" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_profiles" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_preference_evidence" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "editorial_run_id" TEXT,
    "proposal_id" TEXT,
    "candidate_id" TEXT,
    "action_id" INTEGER,
    "evidence_type" TEXT NOT NULL,
    "pass_key" TEXT,
    "feature_vector" JSONB,
    "weight" DOUBLE PRECISION NOT NULL,
    "rationale_tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "editorial_preference_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_fingerprints" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "revision_id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "fingerprint_version" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "vector_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_ledgers_v1" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "ledger_type" TEXT NOT NULL,
    "ledger_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "introduced_scene_id" INTEGER,
    "due_scene_id" INTEGER,
    "resolved_scene_id" INTEGER,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "narrative_ledgers_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_packages_v1" (
    "id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "gate_report" JSONB NOT NULL,
    "artifact_manifest" JSONB NOT NULL,
    "validation_report" JSONB NOT NULL,
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_packages_v1_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE INDEX "idx_books_user_id" ON "books"("user_id");

-- CreateIndex
CREATE INDEX "idx_codex_book_entry_type" ON "codex_entries"("book_id", "entry_type");

-- CreateIndex
CREATE INDEX "idx_acts_book_id" ON "acts"("book_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_act_book_act_number" ON "acts"("book_id", "act_number");

-- CreateIndex
CREATE INDEX "idx_chapters_act_id" ON "chapters"("act_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_chapter_act_chapter_number" ON "chapters"("act_id", "chapter_number");

-- CreateIndex
CREATE INDEX "idx_scenes_chapter_id" ON "scenes"("chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_scene_chapter_scene_number" ON "scenes"("chapter_id", "scene_number");

-- CreateIndex
CREATE INDEX "idx_scu_scene" ON "scene_codex_usage"("scene_id");

-- CreateIndex
CREATE INDEX "idx_scu_codex" ON "scene_codex_usage"("codex_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_scu_scene_codex" ON "scene_codex_usage"("scene_id", "codex_id");

-- CreateIndex
CREATE INDEX "idx_generation_history_user_entity_type" ON "generation_history"("user_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "prose_traces_trace_id_key" ON "prose_traces"("trace_id");

-- CreateIndex
CREATE INDEX "idx_prose_traces_user_created" ON "prose_traces"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_prose_traces_book_created" ON "prose_traces"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_prose_traces_scene_created" ON "prose_traces"("scene_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_prose_trace_candidates_trace_stage" ON "prose_trace_candidates"("prose_trace_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_prose_trace_candidates_trace_ordinal" ON "prose_trace_candidates"("prose_trace_id", "ordinal");

-- CreateIndex
CREATE INDEX "idx_prose_findings_trace_source" ON "prose_findings"("prose_trace_id", "source");

-- CreateIndex
CREATE INDEX "idx_prose_compare_cards_trace_status" ON "prose_compare_cards"("prose_trace_id", "status");

-- CreateIndex
CREATE INDEX "idx_prose_actions_trace_created" ON "prose_actions"("prose_trace_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_prose_actions_scene_created" ON "prose_actions"("scene_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_notes_book_id" ON "notes"("book_id");

-- CreateIndex
CREATE INDEX "idx_images_book_id" ON "images"("book_id");

-- CreateIndex
CREATE INDEX "idx_images_user_id" ON "images"("user_id");

-- CreateIndex
CREATE INDEX "idx_ai_cache_created" ON "ai_cache"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_ai_cache_key" ON "ai_cache"("model", "recipe_version", "prompt_hash");

-- CreateIndex
CREATE INDEX "idx_audit_log_user" ON "audit_log"("user_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_entity" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_created" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "idx_rag_chunks_book_source_type" ON "rag_chunks"("book_id", "source_type");

-- CreateIndex
CREATE INDEX "idx_rag_chunks_source_id" ON "rag_chunks"("source_id");

-- CreateIndex
CREATE INDEX "idx_rag_chunks_book_id" ON "rag_chunks"("book_id");

-- CreateIndex
CREATE INDEX "idx_rag_eval_book_id" ON "rag_eval_results"("book_id");

-- CreateIndex
CREATE INDEX "idx_rag_eval_type" ON "rag_eval_results"("eval_type");

-- CreateIndex
CREATE INDEX "idx_rag_eval_created" ON "rag_eval_results"("created_at");

-- CreateIndex
CREATE INDEX "idx_memory_events_book_id" ON "scene_memory_events"("book_id");

-- CreateIndex
CREATE INDEX "idx_memory_events_scene_id" ON "scene_memory_events"("scene_id");

-- CreateIndex
CREATE INDEX "idx_memory_events_book_type" ON "scene_memory_events"("book_id", "event_type");

-- CreateIndex
CREATE INDEX "idx_char_state_book_codex" ON "character_states"("book_id", "codex_id");

-- CreateIndex
CREATE INDEX "idx_char_state_scene" ON "character_states"("scene_id");

-- CreateIndex
CREATE INDEX "idx_char_state_book_key" ON "character_states"("book_id", "state_key");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_char_state" ON "character_states"("book_id", "codex_id", "scene_id", "state_key");

-- CreateIndex
CREATE INDEX "idx_plot_threads_book_id" ON "plot_threads"("book_id");

-- CreateIndex
CREATE INDEX "idx_plot_threads_book_status" ON "plot_threads"("book_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_plot_thread" ON "plot_threads"("book_id", "thread_key");

-- CreateIndex
CREATE INDEX "idx_skill_runs_book_id" ON "skill_runs"("book_id");

-- CreateIndex
CREATE INDEX "idx_skill_runs_scene_id" ON "skill_runs"("scene_id");

-- CreateIndex
CREATE INDEX "idx_skill_runs_skill_name" ON "skill_runs"("skill_name");

-- CreateIndex
CREATE INDEX "idx_skill_runs_created" ON "skill_runs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_corpus_cases_name_key" ON "evaluation_corpus_cases"("name");

-- CreateIndex
CREATE INDEX "idx_evaluation_case_suite" ON "evaluation_corpus_cases"("suite_key", "suite_version", "active");

-- CreateIndex
CREATE INDEX "idx_evaluation_run_suite" ON "evaluation_runs"("suite_key", "suite_version", "created_at");

-- CreateIndex
CREATE INDEX "idx_evaluation_run_user_status" ON "evaluation_runs"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_evaluation_run_idempotency" ON "evaluation_runs"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "idx_evaluation_result_run" ON "evaluation_results"("evaluation_run_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_evaluation_result_case_pass" ON "evaluation_results"("case_id", "pass_key");

-- CreateIndex
CREATE INDEX "idx_evaluation_result_model" ON "evaluation_results"("model");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_evaluation_result_matrix" ON "evaluation_results"("evaluation_run_id", "case_id", "pass_key", "pass_version", "model");

-- CreateIndex
CREATE INDEX "idx_workflow_book_created" ON "workflow_runs"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_workflow_user_status" ON "workflow_runs"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_workflow_parent" ON "workflow_runs"("parent_run_id");

-- CreateIndex
CREATE INDEX "idx_workflow_dedupe" ON "workflow_runs"("user_id", "workflow_type", "config_hash", "status");

-- CreateIndex
CREATE INDEX "idx_workflow_lease" ON "workflow_runs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "idx_workflow_parent_status" ON "workflow_runs"("parent_run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_workflow_idempotency" ON "workflow_runs"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "idx_workflow_task_status" ON "workflow_tasks"("run_id", "status", "ordinal");

-- CreateIndex
CREATE INDEX "idx_workflow_task_input_revision" ON "workflow_tasks"("input_revision_id");

-- CreateIndex
CREATE INDEX "idx_workflow_task_output_revision" ON "workflow_tasks"("output_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_workflow_task_key" ON "workflow_tasks"("run_id", "task_key");

-- CreateIndex
CREATE INDEX "idx_workflow_artifact_type" ON "workflow_artifacts"("run_id", "artifact_type");

-- CreateIndex
CREATE INDEX "idx_workflow_checkpoint_status" ON "workflow_checkpoints"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_enqueue_outbox_dedupe_key_key" ON "workflow_enqueue_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "idx_workflow_outbox_pending" ON "workflow_enqueue_outbox"("status", "available_at");

-- CreateIndex
CREATE INDEX "idx_workflow_event_cursor" ON "workflow_events"("run_id", "id");

-- CreateIndex
CREATE INDEX "idx_revision_book_hash" ON "manuscript_revisions"("book_id", "content_hash");

-- CreateIndex
CREATE INDEX "idx_revision_book_created" ON "manuscript_revisions"("book_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quality_review_runs_v1_workflow_run_id_key" ON "quality_review_runs_v1"("workflow_run_id");

-- CreateIndex
CREATE INDEX "idx_quality_review_book_created" ON "quality_review_runs_v1"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_quality_review_revision_model" ON "quality_review_runs_v1"("source_revision_id", "model_used");

-- CreateIndex
CREATE INDEX "idx_quality_finding_state" ON "quality_findings_v1"("review_run_id", "implemented", "verification_status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_quality_finding_review_fingerprint" ON "quality_findings_v1"("review_run_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "editorial_runs_workflow_run_id_key" ON "editorial_runs"("workflow_run_id");

-- CreateIndex
CREATE INDEX "idx_editorial_run_book_created" ON "editorial_runs"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_editorial_run_source_revision" ON "editorial_runs"("source_revision_id");

-- CreateIndex
CREATE INDEX "idx_editorial_run_pass" ON "editorial_runs"("pass_pack_key", "pass_pack_version");

-- CreateIndex
CREATE INDEX "idx_editorial_proposal_run_status" ON "editorial_proposals"("editorial_run_id", "status");

-- CreateIndex
CREATE INDEX "idx_editorial_proposal_book_scope" ON "editorial_proposals"("book_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "idx_editorial_proposal_source_revision" ON "editorial_proposals"("source_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_editorial_proposal_fingerprint" ON "editorial_proposals"("editorial_run_id", "fingerprint");

-- CreateIndex
CREATE INDEX "idx_editorial_candidate_type" ON "editorial_candidates"("proposal_id", "candidate_type");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_editorial_candidate_ordinal" ON "editorial_candidates"("proposal_id", "ordinal");

-- CreateIndex
CREATE INDEX "idx_editorial_evaluation_proposal" ON "editorial_evaluations"("proposal_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_editorial_evaluation_profile" ON "editorial_evaluations"("evaluator_profile", "evaluator_version");

-- CreateIndex
CREATE INDEX "idx_editorial_evaluation_model" ON "editorial_evaluations"("evaluator_model");

-- CreateIndex
CREATE INDEX "idx_editorial_profile_user_active" ON "editorial_profiles"("user_id", "active");

-- CreateIndex
CREATE INDEX "idx_editorial_profile_book_active" ON "editorial_profiles"("book_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_editorial_profile_version" ON "editorial_profiles"("user_id", "name", "version");

-- CreateIndex
CREATE INDEX "idx_editorial_preference_user" ON "editorial_preference_evidence"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_editorial_preference_book_pass" ON "editorial_preference_evidence"("book_id", "pass_key");

-- CreateIndex
CREATE INDEX "idx_style_fingerprint_revision" ON "style_fingerprints"("revision_id", "fingerprint_version");

-- CreateIndex
CREATE INDEX "idx_style_fingerprint_book_scope" ON "style_fingerprints"("book_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "idx_workflow_ledger_book_state" ON "narrative_ledgers_v1"("book_id", "ledger_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_workflow_ledger_key" ON "narrative_ledgers_v1"("workflow_run_id", "ledger_type", "ledger_key");

-- CreateIndex
CREATE INDEX "idx_publication_v1_run_status" ON "publication_packages_v1"("workflow_run_id", "status");

-- AddForeignKey
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_entries" ADD CONSTRAINT "codex_entries_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acts" ADD CONSTRAINT "acts_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "acts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_codex_usage" ADD CONSTRAINT "scene_codex_usage_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_codex_usage" ADD CONSTRAINT "scene_codex_usage_codex_id_fkey" FOREIGN KEY ("codex_id") REFERENCES "codex_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_history" ADD CONSTRAINT "generation_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_traces" ADD CONSTRAINT "prose_traces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_traces" ADD CONSTRAINT "prose_traces_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_traces" ADD CONSTRAINT "prose_traces_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "acts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_traces" ADD CONSTRAINT "prose_traces_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_traces" ADD CONSTRAINT "prose_traces_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_trace_candidates" ADD CONSTRAINT "prose_trace_candidates_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_findings" ADD CONSTRAINT "prose_findings_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_compare_cards" ADD CONSTRAINT "prose_compare_cards_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_compare_cards" ADD CONSTRAINT "prose_compare_cards_prose_finding_id_fkey" FOREIGN KEY ("prose_finding_id") REFERENCES "prose_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_actions" ADD CONSTRAINT "prose_actions_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_actions" ADD CONSTRAINT "prose_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_actions" ADD CONSTRAINT "prose_actions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_actions" ADD CONSTRAINT "prose_actions_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_actions" ADD CONSTRAINT "prose_actions_prose_finding_id_fkey" FOREIGN KEY ("prose_finding_id") REFERENCES "prose_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prose_actions" ADD CONSTRAINT "prose_actions_prose_compare_card_id_fkey" FOREIGN KEY ("prose_compare_card_id") REFERENCES "prose_compare_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_evaluation_run_id_fkey" FOREIGN KEY ("evaluation_run_id") REFERENCES "evaluation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "evaluation_corpus_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_result_revision_id_fkey" FOREIGN KEY ("result_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "workflow_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_checkpoints" ADD CONSTRAINT "workflow_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_checkpoints" ADD CONSTRAINT "workflow_checkpoints_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_enqueue_outbox" ADD CONSTRAINT "workflow_enqueue_outbox_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manuscript_revisions" ADD CONSTRAINT "manuscript_revisions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manuscript_revisions" ADD CONSTRAINT "manuscript_revisions_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manuscript_revisions" ADD CONSTRAINT "manuscript_revisions_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_review_runs_v1" ADD CONSTRAINT "quality_review_runs_v1_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_review_runs_v1" ADD CONSTRAINT "quality_review_runs_v1_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_review_runs_v1" ADD CONSTRAINT "quality_review_runs_v1_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_findings_v1" ADD CONSTRAINT "quality_findings_v1_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "quality_review_runs_v1"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_findings_v1" ADD CONSTRAINT "quality_findings_v1_implementing_workflow_run_id_fkey" FOREIGN KEY ("implementing_workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_findings_v1" ADD CONSTRAINT "quality_findings_v1_implemented_revision_id_fkey" FOREIGN KEY ("implemented_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_runs" ADD CONSTRAINT "editorial_runs_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_runs" ADD CONSTRAINT "editorial_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_runs" ADD CONSTRAINT "editorial_runs_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_runs" ADD CONSTRAINT "editorial_runs_result_revision_id_fkey" FOREIGN KEY ("result_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_runs" ADD CONSTRAINT "editorial_runs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "editorial_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_proposals" ADD CONSTRAINT "editorial_proposals_editorial_run_id_fkey" FOREIGN KEY ("editorial_run_id") REFERENCES "editorial_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_proposals" ADD CONSTRAINT "editorial_proposals_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_candidates" ADD CONSTRAINT "editorial_candidates_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "editorial_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_evaluations" ADD CONSTRAINT "editorial_evaluations_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "editorial_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_evaluations" ADD CONSTRAINT "editorial_evaluations_preferred_candidate_id_fkey" FOREIGN KEY ("preferred_candidate_id") REFERENCES "editorial_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "editorial_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_preference_evidence" ADD CONSTRAINT "editorial_preference_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_preference_evidence" ADD CONSTRAINT "editorial_preference_evidence_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_preference_evidence" ADD CONSTRAINT "editorial_preference_evidence_editorial_run_id_fkey" FOREIGN KEY ("editorial_run_id") REFERENCES "editorial_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_preference_evidence" ADD CONSTRAINT "editorial_preference_evidence_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "editorial_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_preference_evidence" ADD CONSTRAINT "editorial_preference_evidence_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "editorial_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_fingerprints" ADD CONSTRAINT "style_fingerprints_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_fingerprints" ADD CONSTRAINT "style_fingerprints_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "manuscript_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_ledgers_v1" ADD CONSTRAINT "narrative_ledgers_v1_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_packages_v1" ADD CONSTRAINT "publication_packages_v1_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve workflow invariants that Prisma cannot express in the schema.
ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_idempotency_key_nonempty"
    CHECK (length(trim("idempotency_key")) > 0),
  ADD CONSTRAINT "workflow_runs_failure_class_valid"
    CHECK (
      "failure_class" IS NULL
      OR "failure_class" IN ('transient', 'infrastructure', 'validation', 'content')
    );

-- Keep status versions authoritative for Prisma, raw SQL, and alternate clients.
CREATE FUNCTION "increment_workflow_status_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status_version" = OLD."status_version" THEN
    NEW."status_version" := OLD."status_version" + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workflow_runs_status_version_before_update"
BEFORE UPDATE ON "workflow_runs"
FOR EACH ROW
EXECUTE FUNCTION "increment_workflow_status_version"();
