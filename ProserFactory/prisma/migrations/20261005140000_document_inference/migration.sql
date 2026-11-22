CREATE TABLE "document_inference_operations" (
  "id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "scene_id" INTEGER NOT NULL,
  "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "source_book_revision" TEXT NOT NULL,
  "source_scene_revision" TEXT NOT NULL,
  "source_content_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "error_code" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_inference_operations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_inference_operations_book_id_user_id_created_at_idx" ON "document_inference_operations"("book_id", "user_id", "created_at");
