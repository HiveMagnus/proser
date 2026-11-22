CREATE TABLE "document_operator_effects" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "user_id" INTEGER NOT NULL,
 "book_id" INTEGER NOT NULL,
 "scene_id" INTEGER,
 "kind" TEXT NOT NULL,
 "intent_hash" TEXT NOT NULL,
 "source_book_revision" TEXT NOT NULL,
 "source_content_hash" TEXT NOT NULL,
 "request" JSONB NOT NULL,
 "request_hash" TEXT NOT NULL,
 "timeout_ms" INTEGER NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending',
 "result" JSONB,
 "error_code" TEXT,
 "started_at" TIMESTAMP(3),
 "completed_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "document_operator_effects_book_id_user_id_created_at_id_idx" ON "document_operator_effects"("book_id","user_id","created_at","id");
