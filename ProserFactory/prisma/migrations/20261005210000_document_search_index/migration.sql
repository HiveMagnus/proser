-- Derived immutable search data is populated by writer transactions and the
-- explicitly reviewed, restart-safe historical backfill; no existing evidence
-- or historical revision bytes are rewritten. No extension is required.
CREATE TABLE "scene_document_search_indexes" (
 "scene_revision_id" TEXT NOT NULL PRIMARY KEY,
 "book_id" INTEGER NOT NULL, "scene_id" INTEGER NOT NULL,
 "content_hash" TEXT NOT NULL, "projection_sha256" TEXT NOT NULL,
 "normalization" TEXT NOT NULL, "word_count" INTEGER NOT NULL,
 "payload" JSONB NOT NULL, "payload_hash" TEXT NOT NULL, "payload_bytes" INTEGER NOT NULL,
 "sensitive_text" TEXT NOT NULL, "folded_text" TEXT NOT NULL,
 "sensitive_grams" TEXT[] NOT NULL, "folded_grams" TEXT[] NOT NULL,
 "sensitive_overflow" BOOLEAN NOT NULL, "folded_overflow" BOOLEAN NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "scene_document_search_indexes_book_id_scene_id_idx" ON "scene_document_search_indexes"("book_id", "scene_id");
CREATE INDEX "scene_document_search_indexes_sensitive_grams_idx" ON "scene_document_search_indexes" USING GIN ("sensitive_grams");
CREATE INDEX "scene_document_search_indexes_folded_grams_idx" ON "scene_document_search_indexes" USING GIN ("folded_grams");
