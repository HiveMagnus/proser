-- Preserve the pre-migration delivery budget for active/recoverable runs.
UPDATE "workflow_runs"
SET "delivery_attempt_count" = "attempt_count"
WHERE "status" IN ('queued', 'running', 'failed');
