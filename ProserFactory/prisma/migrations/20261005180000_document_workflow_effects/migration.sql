CREATE TABLE "document_workflow_effects" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "effect_key" TEXT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "book_id" INTEGER NOT NULL,
  "scene_id" INTEGER,
  "source_book_revision" TEXT NOT NULL,
  "source_content_hash" TEXT NOT NULL,
  "intent_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "lease_owner" TEXT,
  "timeout_ms" INTEGER NOT NULL,
  "result" JSONB,
  "error_code" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "document_workflow_effects_run_id_effect_key_key" ON "document_workflow_effects" ("run_id", "effect_key");
CREATE INDEX "document_workflow_effects_book_id_user_id_created_at_idx" ON "document_workflow_effects" ("book_id", "user_id", "created_at");
