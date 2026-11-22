/*
  Warnings:

  - Made the column `lease_expires_at` on table `novel_operations` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow_type" TEXT NOT NULL,
    "parent_run_id" TEXT,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_revision_id" TEXT,
    "result_revision_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'queued',
    "settings" JSONB NOT NULL,
    "progress" JSONB,
    "model_policy" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "last_heartbeat_at" DATETIME,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_runs_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "workflow_runs_result_revision_id_fkey" FOREIGN KEY ("result_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "validation_result" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "task_id" TEXT,
    "artifact_type" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "source_revision_id" TEXT,
    "result_revision_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "workflow_tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_checkpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "checkpoint_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposal" JSONB NOT NULL,
    "decision" TEXT,
    "reason" TEXT,
    "decided_by_id" INTEGER,
    "decided_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_checkpoints_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "data" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "manuscript_revisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "book_id" INTEGER NOT NULL,
    "parent_revision_id" TEXT,
    "workflow_run_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "changed_scopes" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manuscript_revisions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "manuscript_revisions_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "manuscript_revisions_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "quality_review_runs_v1" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow_run_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "source_revision_id" TEXT NOT NULL,
    "model_used" TEXT NOT NULL,
    "rubric_version" TEXT NOT NULL,
    "prompt_recipe" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "coverage" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_review_runs_v1_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quality_review_runs_v1_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quality_review_runs_v1_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "quality_findings_v1" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_run_id" TEXT NOT NULL,
    "related_fingerprint" TEXT,
    "fingerprint" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" TEXT,
    "recommendation" TEXT,
    "implemented" BOOLEAN NOT NULL DEFAULT false,
    "implemented_at" DATETIME,
    "implementing_workflow_run_id" TEXT,
    "implemented_revision_id" TEXT,
    "changed_scopes" JSONB,
    "diff_summary" TEXT,
    "verification_status" TEXT NOT NULL DEFAULT 'not_implemented',
    "verified_at" DATETIME,
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "waiver_reason" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_findings_v1_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "quality_review_runs_v1" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quality_findings_v1_implementing_workflow_run_id_fkey" FOREIGN KEY ("implementing_workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "quality_findings_v1_implemented_revision_id_fkey" FOREIGN KEY ("implemented_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "publication_packages_v1" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow_run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "gate_report" JSONB NOT NULL,
    "artifact_manifest" JSONB NOT NULL,
    "validation_report" JSONB NOT NULL,
    "approved_by_id" INTEGER,
    "approved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "publication_packages_v1_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_continuity_issues" (
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
    "review_run_id" TEXT,
    "fingerprint" TEXT,
    "superseded_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "continuity_issues_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_continuity_issues" ("book_id", "confidence", "created_at", "description", "fingerprint", "id", "issue_type", "resolved", "review_run_id", "severity", "source_label", "source_scene_id", "suggestion", "superseded_at", "target_label", "target_scene_id", "title", "updated_at") SELECT "book_id", "confidence", "created_at", "description", "fingerprint", "id", "issue_type", "resolved", "review_run_id", "severity", "source_label", "source_scene_id", "suggestion", "superseded_at", "target_label", "target_scene_id", "title", "updated_at" FROM "continuity_issues";
DROP TABLE "continuity_issues";
ALTER TABLE "new_continuity_issues" RENAME TO "continuity_issues";
CREATE INDEX "idx_continuity_issues_book_type" ON "continuity_issues"("book_id", "issue_type");
CREATE INDEX "idx_continuity_issues_book_resolved" ON "continuity_issues"("book_id", "resolved");
CREATE INDEX "idx_continuity_issues_review_run" ON "continuity_issues"("review_run_id");
CREATE UNIQUE INDEX "uniq_continuity_review_fingerprint" ON "continuity_issues"("review_run_id", "fingerprint");
CREATE TABLE "new_novel_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "run_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'processing',
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "lease_expires_at" DATETIME NOT NULL,
    "last_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failure_code" TEXT,
    "result_ref" JSONB,
    "response_status" INTEGER,
    "response_body" JSONB,
    "response_hash" TEXT,
    "response_bytes" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    "expires_at" DATETIME,
    "archived_at" DATETIME,
    CONSTRAINT "novel_operations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "novel_operations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_novel_operations" ("action", "archived_at", "attempt_count", "completed_at", "created_at", "expires_at", "failure_code", "id", "idempotency_key", "last_attempt_at", "lease_expires_at", "request_hash", "response_body", "response_bytes", "response_hash", "response_status", "result_ref", "run_id", "state", "updated_at", "user_id") SELECT "action", "archived_at", "attempt_count", "completed_at", "created_at", "expires_at", "failure_code", "id", "idempotency_key", "last_attempt_at", "lease_expires_at", "request_hash", "response_body", "response_bytes", "response_hash", "response_status", "result_ref", "run_id", "state", "updated_at", "user_id" FROM "novel_operations";
DROP TABLE "novel_operations";
ALTER TABLE "new_novel_operations" RENAME TO "novel_operations";
CREATE INDEX "idx_novel_operations_run_created" ON "novel_operations"("run_id", "created_at");
CREATE INDEX "idx_novel_operations_state_lease" ON "novel_operations"("state", "lease_expires_at");
CREATE INDEX "idx_novel_operations_state_expiry" ON "novel_operations"("state", "expires_at");
CREATE UNIQUE INDEX "uniq_novel_operations_user_key" ON "novel_operations"("user_id", "idempotency_key");
CREATE TABLE "new_quality_issues" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER,
    "issue_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "evidence" TEXT,
    "suggestion" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "review_run_id" TEXT,
    "fingerprint" TEXT,
    "superseded_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_issues_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_quality_issues" ("book_id", "created_at", "evidence", "fingerprint", "id", "issue_type", "message", "resolved", "review_run_id", "scene_id", "severity", "suggestion", "superseded_at", "updated_at") SELECT "book_id", "created_at", "evidence", "fingerprint", "id", "issue_type", "message", "resolved", "review_run_id", "scene_id", "severity", "suggestion", "superseded_at", "updated_at" FROM "quality_issues";
DROP TABLE "quality_issues";
ALTER TABLE "new_quality_issues" RENAME TO "quality_issues";
CREATE INDEX "idx_quality_issues_book_type" ON "quality_issues"("book_id", "issue_type");
CREATE INDEX "idx_quality_issues_book_resolved" ON "quality_issues"("book_id", "resolved");
CREATE INDEX "idx_quality_issues_review_run" ON "quality_issues"("review_run_id");
CREATE UNIQUE INDEX "uniq_quality_review_fingerprint" ON "quality_issues"("review_run_id", "fingerprint");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "idx_workflow_book_created" ON "workflow_runs"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_workflow_user_status" ON "workflow_runs"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_workflow_parent" ON "workflow_runs"("parent_run_id");

-- CreateIndex
CREATE INDEX "idx_workflow_task_status" ON "workflow_tasks"("run_id", "status", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_workflow_task_key" ON "workflow_tasks"("run_id", "task_key");

-- CreateIndex
CREATE INDEX "idx_workflow_artifact_type" ON "workflow_artifacts"("run_id", "artifact_type");

-- CreateIndex
CREATE INDEX "idx_workflow_checkpoint_status" ON "workflow_checkpoints"("run_id", "status");

-- CreateIndex
CREATE INDEX "idx_workflow_event_cursor" ON "workflow_events"("run_id", "id");

-- CreateIndex
CREATE INDEX "idx_revision_book_created" ON "manuscript_revisions"("book_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_revision_book_hash" ON "manuscript_revisions"("book_id", "content_hash");

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
CREATE INDEX "idx_publication_v1_run_status" ON "publication_packages_v1"("workflow_run_id", "status");

-- RedefineIndex
DROP INDEX "idx_novel_run_events_type";
CREATE INDEX "idx_novel_run_events_run_type_created" ON "novel_run_events"("run_id", "event_type", "created_at");

-- RedefineIndex
DROP INDEX "idx_novel_run_events_cursor";
CREATE INDEX "idx_novel_run_events_run_cursor" ON "novel_run_events"("run_id", "cursor");
