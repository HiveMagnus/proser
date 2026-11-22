CREATE TABLE "review_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "config_hash" TEXT NOT NULL,
    "book_revision" TEXT NOT NULL,
    "final_book_revision" TEXT,
    "review_types" JSONB NOT NULL,
    "scope_type" TEXT NOT NULL DEFAULT 'book',
    "scope_id" INTEGER,
    "rubric_version" TEXT NOT NULL DEFAULT 'review-v1',
    "model_used" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "total_tasks" INTEGER NOT NULL DEFAULT 0,
    "completed_tasks" INTEGER NOT NULL DEFAULT 0,
    "clean_tasks" INTEGER NOT NULL DEFAULT 0,
    "failed_tasks" INTEGER NOT NULL DEFAULT 0,
    "finding_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    CONSTRAINT "review_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "review_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "review_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "review_type" TEXT NOT NULL,
    "task_key" TEXT NOT NULL,
    "scene_ids" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "finding_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "review_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "review_run_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "data" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "review_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "quality_issues" ADD COLUMN "review_run_id" TEXT;
ALTER TABLE "quality_issues" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "quality_issues" ADD COLUMN "superseded_at" DATETIME;

ALTER TABLE "continuity_issues" ADD COLUMN "review_run_id" TEXT;
ALTER TABLE "continuity_issues" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "continuity_issues" ADD COLUMN "superseded_at" DATETIME;

CREATE UNIQUE INDEX "uniq_review_run_user_idempotency" ON "review_runs"("user_id", "idempotency_key");
CREATE INDEX "idx_review_runs_book_created" ON "review_runs"("book_id", "created_at");
CREATE INDEX "idx_review_runs_user_status" ON "review_runs"("user_id", "status");
CREATE INDEX "idx_review_runs_config_status" ON "review_runs"("config_hash", "status");
CREATE UNIQUE INDEX "uniq_review_task_key" ON "review_tasks"("run_id", "review_type", "task_key");
CREATE INDEX "idx_review_tasks_run_status" ON "review_tasks"("run_id", "status");
CREATE INDEX "idx_review_events_run_id" ON "review_run_events"("run_id", "id");
CREATE INDEX "idx_quality_issues_review_run" ON "quality_issues"("review_run_id");
CREATE UNIQUE INDEX "uniq_quality_review_fingerprint" ON "quality_issues"("review_run_id", "fingerprint");
CREATE INDEX "idx_continuity_issues_review_run" ON "continuity_issues"("review_run_id");
CREATE UNIQUE INDEX "uniq_continuity_review_fingerprint" ON "continuity_issues"("review_run_id", "fingerprint");
