-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_workflow_runs" (
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
    "config_hash" TEXT NOT NULL DEFAULT '',
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
INSERT INTO "new_workflow_runs" ("attempt_count", "book_id", "cancel_requested", "created_at", "failure_reason", "finished_at", "id", "last_heartbeat_at", "max_attempts", "model_policy", "parent_run_id", "phase", "progress", "result_revision_id", "settings", "source_revision_id", "started_at", "status", "updated_at", "user_id", "workflow_type") SELECT "attempt_count", "book_id", "cancel_requested", "created_at", "failure_reason", "finished_at", "id", "last_heartbeat_at", "max_attempts", "model_policy", "parent_run_id", "phase", "progress", "result_revision_id", "settings", "source_revision_id", "started_at", "status", "updated_at", "user_id", "workflow_type" FROM "workflow_runs";
DROP TABLE "workflow_runs";
ALTER TABLE "new_workflow_runs" RENAME TO "workflow_runs";
CREATE INDEX "idx_workflow_book_created" ON "workflow_runs"("book_id", "created_at");
CREATE INDEX "idx_workflow_user_status" ON "workflow_runs"("user_id", "status");
CREATE INDEX "idx_workflow_parent" ON "workflow_runs"("parent_run_id");
CREATE INDEX "idx_workflow_dedupe" ON "workflow_runs"("user_id", "workflow_type", "config_hash", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


