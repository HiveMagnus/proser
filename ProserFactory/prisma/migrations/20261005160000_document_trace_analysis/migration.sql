CREATE TABLE "document_trace_analyses" (
  "id" TEXT NOT NULL, "trace_id" TEXT NOT NULL, "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL, "scene_id" INTEGER NOT NULL,
  "source_book_revision" TEXT NOT NULL, "source_scene_revision" TEXT NOT NULL,
  "source_content_hash" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "result" JSONB, "error_code" TEXT,
  "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_trace_analyses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_trace_analyses_trace_id_key" ON "document_trace_analyses"("trace_id");
CREATE INDEX "document_trace_analyses_book_id_user_id_scene_id_created_at_idx" ON "document_trace_analyses"("book_id", "user_id", "scene_id", "created_at");
CREATE TABLE "document_trace_targets" (
  "id" TEXT NOT NULL, "analysis_id" TEXT NOT NULL, "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL, "scene_id" INTEGER NOT NULL, "trace_id" TEXT NOT NULL,
  "finding_id" INTEGER, "compare_card_id" INTEGER, "target" JSONB, "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_trace_targets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_trace_targets_compare_card_id_key" ON "document_trace_targets"("compare_card_id");
CREATE INDEX "document_trace_targets_analysis_id_created_at_idx" ON "document_trace_targets"("analysis_id", "created_at");
CREATE TABLE "document_compare_validations" (
  "id" TEXT NOT NULL, "target_id" TEXT NOT NULL, "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL,
  "book_revision_id" TEXT NOT NULL, "scene_revision_id" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL, "target" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_compare_validations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_compare_validations_target_id_created_at_idx" ON "document_compare_validations"("target_id", "created_at");
