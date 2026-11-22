ALTER TABLE "workflow_runs" ADD COLUMN "delivery_attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workflow_runs" ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0;

-- Existing attempt_count values are already lifetime executions. Preserve them
-- and start the delivery-local counter from the current observed delivery.
UPDATE "workflow_runs"
SET "delivery_attempt_count" = CASE WHEN "status" = 'running' THEN 1 ELSE 0 END;
