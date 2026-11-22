ALTER TABLE "acts" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "chapters" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "scene_codex_usage" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE TABLE "book_document_scope_revisions" (
  "id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "parent_revision_id" TEXT,
  "content_hash" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "book_document_scope_revisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "book_document_scope_revisions_book_id_kind_created_at_idx" ON "book_document_scope_revisions"("book_id", "kind", "created_at");
CREATE TABLE "document_legacy_revision_mappings" (
  "legacy_revision_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "document_revision_id" TEXT NOT NULL,
  "legacy_content_hash" TEXT NOT NULL,
  "fidelity" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_legacy_revision_mappings_pkey" PRIMARY KEY ("legacy_revision_id")
);
CREATE INDEX "document_legacy_revision_mappings_book_id_idx" ON "document_legacy_revision_mappings"("book_id");
