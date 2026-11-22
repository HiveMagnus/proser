-- Rebuild workflow_runs so idempotency keys are mandatory and cannot silently
-- fall back to an empty database default. Existing failed runs are conservatively
-- classified as transient; only newly classified infrastructure failures are
-- eligible for automatic recovery.
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
    "idempotency_key" TEXT NOT NULL CHECK (length(trim("idempotency_key")) > 0),
    "lease_owner" TEXT,
    "lease_expires_at" DATETIME,
    "execution_parent_run_id" TEXT,
    "recovery_lease_owner" TEXT,
    "recovery_lease_expires_at" DATETIME,
    "progress" JSONB,
    "model_policy" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "failure_class" TEXT CHECK ("failure_class" IS NULL OR "failure_class" IN ('transient', 'infrastructure', 'validation', 'content')),
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

INSERT INTO "new_workflow_runs" (
    "id", "workflow_type", "parent_run_id", "book_id", "user_id", "source_revision_id", "result_revision_id",
    "status", "phase", "settings", "config_hash", "idempotency_key", "lease_owner", "lease_expires_at",
    "execution_parent_run_id", "recovery_lease_owner", "recovery_lease_expires_at", "progress", "model_policy",
    "attempt_count", "max_attempts", "cancel_requested", "failure_reason", "failure_class", "last_heartbeat_at",
    "started_at", "finished_at", "created_at", "updated_at"
)
SELECT
    "id", "workflow_type", "parent_run_id", "book_id", "user_id", "source_revision_id", "result_revision_id",
    "status", "phase", "settings", "config_hash", "idempotency_key", "lease_owner", "lease_expires_at",
    "execution_parent_run_id", "recovery_lease_owner", "recovery_lease_expires_at", "progress", "model_policy",
    "attempt_count", "max_attempts", "cancel_requested", "failure_reason",
    CASE WHEN "status" = 'failed' THEN 'transient' ELSE NULL END,
    "last_heartbeat_at", "started_at", "finished_at", "created_at", "updated_at"
FROM "workflow_runs";

DROP TABLE "workflow_runs";
ALTER TABLE "new_workflow_runs" RENAME TO "workflow_runs";

CREATE UNIQUE INDEX "uniq_workflow_idempotency" ON "workflow_runs"("user_id", "idempotency_key");
CREATE INDEX "idx_workflow_book_created" ON "workflow_runs"("book_id", "created_at");
CREATE INDEX "idx_workflow_user_status" ON "workflow_runs"("user_id", "status");
CREATE INDEX "idx_workflow_parent" ON "workflow_runs"("parent_run_id");
CREATE INDEX "idx_workflow_dedupe" ON "workflow_runs"("user_id", "workflow_type", "config_hash", "status");
CREATE INDEX "idx_workflow_lease" ON "workflow_runs"("status", "lease_expires_at");
CREATE INDEX "idx_workflow_parent_status" ON "workflow_runs"("parent_run_id", "status");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
