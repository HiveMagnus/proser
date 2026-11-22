CREATE TABLE "novel_run_events" (
  "cursor" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "run_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "task_id" TEXT,
  "artifact_id" TEXT,
  "actor_id" INTEGER,
  "data" JSONB NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "novel_operations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "run_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'processing',
  "response_status" INTEGER,
  "response_body" JSONB,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" DATETIME,
  CONSTRAINT "novel_operations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "novel_operations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "novel_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_novel_run_events_cursor" ON "novel_run_events"("run_id", "cursor");
CREATE INDEX "idx_novel_run_events_type" ON "novel_run_events"("run_id", "event_type", "created_at");
CREATE UNIQUE INDEX "uniq_novel_operation_user_key" ON "novel_operations"("user_id", "idempotency_key");
CREATE INDEX "idx_novel_operations_run_created" ON "novel_operations"("run_id", "created_at");
