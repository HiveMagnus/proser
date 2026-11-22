ALTER TABLE "workflow_runs" ADD COLUMN "idempotency_key" TEXT NOT NULL DEFAULT '';
ALTER TABLE "workflow_runs" ADD COLUMN "lease_owner" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "lease_expires_at" DATETIME;
ALTER TABLE "workflow_runs" ADD COLUMN "execution_parent_run_id" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "recovery_lease_owner" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "recovery_lease_expires_at" DATETIME;
ALTER TABLE "workflow_tasks" ADD COLUMN "lease_owner" TEXT;
ALTER TABLE "workflow_checkpoints" ADD COLUMN "lease_owner" TEXT;
ALTER TABLE "manuscript_revisions" ADD COLUMN "lease_owner" TEXT;

-- Existing rows predate client supplied keys. Giving each row a stable unique
-- legacy key allows the unique database invariant to be installed safely.
UPDATE "workflow_runs" SET "idempotency_key" = 'legacy:' || "id" WHERE "idempotency_key" = '';

CREATE UNIQUE INDEX "uniq_workflow_idempotency" ON "workflow_runs"("user_id", "idempotency_key");
CREATE INDEX "idx_workflow_lease" ON "workflow_runs"("status", "lease_expires_at");
CREATE INDEX "idx_workflow_parent_status" ON "workflow_runs"("parent_run_id", "status");

CREATE TABLE "workflow_enqueue_outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" DATETIME,
  "processed_at" DATETIME,
  "last_error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_enqueue_outbox_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workflow_enqueue_outbox_dedupe_key_key" ON "workflow_enqueue_outbox"("dedupe_key");
CREATE INDEX "idx_workflow_outbox_pending" ON "workflow_enqueue_outbox"("status", "available_at");
