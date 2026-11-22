CREATE TABLE "document_publication_artifacts" (
    "id" TEXT NOT NULL,
    "publication_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "media_type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "provenance" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_publication_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_publication_artifacts_publication_id_key" ON "document_publication_artifacts"("publication_id");
CREATE INDEX "document_publication_artifacts_book_id_user_id_created_at_idx" ON "document_publication_artifacts"("book_id", "user_id", "created_at");
