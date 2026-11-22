ALTER TABLE "novel_operations" ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "novel_operations" ADD COLUMN "lease_expires_at" DATETIME;
ALTER TABLE "novel_operations" ADD COLUMN "last_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "novel_operations" ADD COLUMN "failure_code" TEXT;
ALTER TABLE "novel_operations" ADD COLUMN "result_ref" JSONB;
ALTER TABLE "novel_operations" ADD COLUMN "response_hash" TEXT;
ALTER TABLE "novel_operations" ADD COLUMN "response_bytes" INTEGER;
ALTER TABLE "novel_operations" ADD COLUMN "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "novel_operations" ADD COLUMN "expires_at" DATETIME;
ALTER TABLE "novel_operations" ADD COLUMN "archived_at" DATETIME;

UPDATE "novel_operations"
SET "lease_expires_at" = COALESCE("completed_at", datetime("created_at", '+2 minutes'));

CREATE INDEX "idx_novel_operations_state_lease" ON "novel_operations"("state", "lease_expires_at");
CREATE INDEX "idx_novel_operations_state_expiry" ON "novel_operations"("state", "expires_at");
