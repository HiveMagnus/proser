CREATE TABLE "novel_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'brief',
  "status" TEXT NOT NULL DEFAULT 'active',
  "autonomy_mode" TEXT NOT NULL DEFAULT 'supervised',
  "settings" JSONB NOT NULL,
  "next_task_id" TEXT,
  "schema_version" TEXT NOT NULL DEFAULT '1.0.0',
  "recipe_version" TEXT NOT NULL DEFAULT 'novel-os-v1',
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "release_status" TEXT NOT NULL DEFAULT 'not_evaluated',
  "paused_at" DATETIME,
  "completed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "novel_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "novel_tasks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "task_type" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "dependencies" JSONB NOT NULL,
  "input_artifacts" JSONB NOT NULL,
  "expected_output_type" TEXT NOT NULL,
  "context_budget" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "approval_status" TEXT NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "idempotency_key" TEXT NOT NULL,
  "result_artifact_id" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "started_at" DATETIME,
  "completed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "novel_artifacts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "task_id" TEXT,
  "artifact_type" TEXT NOT NULL,
  "scope_type" TEXT NOT NULL DEFAULT 'book',
  "scope_id" TEXT NOT NULL DEFAULT 'book',
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "payload" JSONB NOT NULL,
  "content_hash" TEXT NOT NULL,
  "parent_artifact_id" TEXT,
  "model_used" TEXT,
  "recipe_version" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "narrative_ledgers" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "ledger_type" TEXT NOT NULL,
  "ledger_key" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'open',
  "introduced_scene_id" INTEGER,
  "due_scene_id" INTEGER,
  "resolved_scene_id" INTEGER,
  "escalation_history" JSONB,
  "payload" JSONB NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "narrative_ledgers_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "novel_evaluations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "level" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "evaluator_version" TEXT NOT NULL,
  "rubric" JSONB NOT NULL,
  "findings" JSONB NOT NULL,
  "overall_score" REAL NOT NULL,
  "confidence" REAL NOT NULL,
  "pass" BOOLEAN NOT NULL,
  "human_decision" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_evaluations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "evaluation_corpus_cases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "genre" TEXT,
  "input" JSONB NOT NULL,
  "expected" JSONB NOT NULL,
  "invariant_rules" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "publication_packages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "formats" JSONB NOT NULL,
  "manifest" JSONB NOT NULL,
  "gate_report" JSONB NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalized_at" DATETIME,
  CONSTRAINT "publication_packages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_novel_runs_book_created" ON "novel_runs"("book_id", "created_at");
CREATE INDEX "idx_novel_runs_user_status" ON "novel_runs"("user_id", "status");
CREATE UNIQUE INDEX "novel_tasks_idempotency_key_key" ON "novel_tasks"("idempotency_key");
CREATE INDEX "idx_novel_tasks_run_status_phase" ON "novel_tasks"("run_id", "status", "phase");
CREATE UNIQUE INDEX "uniq_novel_artifact_version" ON "novel_artifacts"("run_id", "artifact_type", "scope_type", "scope_id", "version");
CREATE INDEX "idx_novel_artifacts_book_type_status" ON "novel_artifacts"("book_id", "artifact_type", "status");
CREATE UNIQUE INDEX "uniq_narrative_ledger_version" ON "narrative_ledgers"("run_id", "ledger_type", "ledger_key", "version");
CREATE INDEX "idx_narrative_ledger_book_type_status" ON "narrative_ledgers"("book_id", "ledger_type", "status");
CREATE INDEX "idx_novel_eval_run_level_entity" ON "novel_evaluations"("run_id", "level", "entity_id");
CREATE INDEX "idx_novel_eval_book_created" ON "novel_evaluations"("book_id", "created_at");
CREATE UNIQUE INDEX "evaluation_corpus_cases_name_key" ON "evaluation_corpus_cases"("name");
CREATE INDEX "idx_publication_packages_run_status" ON "publication_packages"("run_id", "status");
