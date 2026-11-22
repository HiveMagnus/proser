CREATE TABLE "document_import_originals" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "format" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "byte_length" INTEGER NOT NULL,
  "bytes" BYTEA NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "document_import_originals_book_id_user_id_created_at_idx" ON "document_import_originals" ("book_id", "user_id", "created_at");
CREATE TABLE "document_import_previews" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "original_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "source_book_revision" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "conversion" JSONB NOT NULL,
  "report" JSONB NOT NULL,
  "report_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "document_import_previews_book_id_user_id_created_at_idx" ON "document_import_previews" ("book_id", "user_id", "created_at");
