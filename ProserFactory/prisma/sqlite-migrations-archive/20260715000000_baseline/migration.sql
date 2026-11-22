-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "github_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "avatar_url" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "books" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "genre" TEXT,
    "target_audience" TEXT,
    "draft_status" TEXT DEFAULT 'draft',
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "tagline" TEXT,
    "story_outline" TEXT,
    "story_archetype_key" TEXT,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    CONSTRAINT "books_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "codex_entries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "entry_type" TEXT NOT NULL,
    "entry_name" TEXT NOT NULL,
    "entry_description" TEXT,
    "attributes" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "codex_entries_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "acts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "act_number" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "acts_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "act_id" INTEGER NOT NULL,
    "chapter_number" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "chapters_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "acts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "scenes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chapter_id" INTEGER NOT NULL,
    "scene_number" INTEGER NOT NULL,
    "outline" TEXT,
    "beats_meta" JSONB,
    "summary" TEXT,
    "prose" TEXT,
    "word_count" INTEGER DEFAULT 0,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "selected_image_id" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    CONSTRAINT "scenes_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "scene_codex_usage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scene_id" INTEGER NOT NULL,
    "codex_id" INTEGER NOT NULL,
    "used_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "rationale" TEXT,
    CONSTRAINT "scene_codex_usage_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scene_codex_usage_codex_id_fkey" FOREIGN KEY ("codex_id") REFERENCES "codex_entries" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "generation_history" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER,
    "prompt" TEXT NOT NULL,
    "generated_content" TEXT NOT NULL,
    "model_used" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "generation_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "prose_traces" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prose_traces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "prose_traces_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "prose_traces_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "acts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "prose_traces_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "prose_traces_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "prose_trace_candidates" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "prose_trace_id" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "candidate_type" TEXT NOT NULL,
    "selection_label" TEXT,
    "accepted" BOOLEAN,
    "rejected" BOOLEAN,
    "output_text" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "overall_score" REAL,
    "tier" TEXT,
    "metadata_json" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prose_trace_candidates_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "prose_findings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
    "dismissed_at" DATETIME,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prose_findings_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "prose_compare_cards" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prose_compare_cards_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "prose_compare_cards_prose_finding_id_fkey" FOREIGN KEY ("prose_finding_id") REFERENCES "prose_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "prose_actions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "prose_trace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "prose_finding_id" INTEGER,
    "prose_compare_card_id" INTEGER,
    "action_type" TEXT NOT NULL,
    "metadata_json" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prose_actions_prose_trace_id_fkey" FOREIGN KEY ("prose_trace_id") REFERENCES "prose_traces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "prose_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "prose_actions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "prose_actions_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "prose_actions_prose_finding_id_fkey" FOREIGN KEY ("prose_finding_id") REFERENCES "prose_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "prose_actions_prose_compare_card_id_fkey" FOREIGN KEY ("prose_compare_card_id") REFERENCES "prose_compare_cards" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notes_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "wizard_progress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "step_type" TEXT NOT NULL,
    "description" TEXT,
    "result" TEXT,
    "status" TEXT DEFAULT 'pending',
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wizard_progress_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "wizard_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "wizard_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "current_phase" INTEGER DEFAULT 1,
    "current_step" INTEGER DEFAULT 0,
    "total_steps" INTEGER NOT NULL,
    "status" TEXT DEFAULT 'running',
    "settings" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wizard_sessions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "wizard_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "images" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "config_json" TEXT,
    "source" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "images_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "images_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "factory_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "current_step" INTEGER,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "failure_reason" TEXT,
    "last_heartbeat_at" DATETIME,
    CONSTRAINT "factory_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "factory_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "factory_steps" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" INTEGER NOT NULL,
    "step_key" INTEGER NOT NULL,
    "act_id" INTEGER,
    "chapter_id" INTEGER,
    "scene_id" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "error" TEXT,
    CONSTRAINT "factory_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "factory_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "factory_steps_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "acts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "factory_steps_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "factory_steps_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "factory_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" INTEGER NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ctx" JSONB,
    CONSTRAINT "factory_logs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "factory_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_cache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "model" TEXT NOT NULL,
    "recipe_version" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "ttl_sec" INTEGER NOT NULL DEFAULT 604800,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_hit_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER,
    "metadata" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "rag_chunks" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding" JSONB,
    "embed_model" TEXT,
    "embed_version" TEXT,
    "token_count" INTEGER,
    "metadata" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "rag_eval_results" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "eval_type" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "orchestrator" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "scene_memory_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "actors" JSONB NOT NULL,
    "location" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "character_states" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "codex_id" INTEGER NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "state_key" TEXT NOT NULL,
    "state_value" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "plot_threads" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "thread_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "description" TEXT,
    "first_scene_id" INTEGER,
    "last_scene_id" INTEGER,
    "due_horizon" TEXT,
    "actors" JSONB,
    "notes" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "skill_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "skill_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "latency_ms" INTEGER,
    "findings" JSONB,
    "input_hash" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "quality_issues" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "issue_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "evidence" TEXT,
    "suggestion" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "continuity_issues" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "issue_type" TEXT NOT NULL DEFAULT 'continuity',
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source_scene_id" INTEGER,
    "target_scene_id" INTEGER,
    "source_label" TEXT,
    "target_label" TEXT,
    "suggestion" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
CREATE INDEX "notes_book_id_fkey" ON "notes"("book_id");

-- CreateIndex
CREATE INDEX "wizard_progress_session_id_fkey" ON "wizard_progress"("session_id");

-- CreateIndex
CREATE INDEX "wizard_sessions_book_id_fkey" ON "wizard_sessions"("book_id");

-- CreateIndex
CREATE INDEX "wizard_sessions_user_id_fkey" ON "wizard_sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_images_book_id" ON "images"("book_id");

-- CreateIndex
CREATE INDEX "idx_images_user_id" ON "images"("user_id");

-- CreateIndex
CREATE INDEX "idx_factory_runs_book_id" ON "factory_runs"("book_id");

-- CreateIndex
CREATE INDEX "idx_factory_runs_user_id" ON "factory_runs"("user_id");

-- CreateIndex
CREATE INDEX "idx_factory_steps_run_step" ON "factory_steps"("run_id", "step_key");

-- CreateIndex
CREATE INDEX "idx_factory_logs_run_ts" ON "factory_logs"("run_id", "ts");

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
CREATE INDEX "idx_quality_issues_book_type" ON "quality_issues"("book_id", "issue_type");

-- CreateIndex
CREATE INDEX "idx_quality_issues_book_resolved" ON "quality_issues"("book_id", "resolved");

-- CreateIndex
CREATE INDEX "idx_continuity_issues_book_type" ON "continuity_issues"("book_id", "issue_type");

-- CreateIndex
CREATE INDEX "idx_continuity_issues_book_resolved" ON "continuity_issues"("book_id", "resolved");
