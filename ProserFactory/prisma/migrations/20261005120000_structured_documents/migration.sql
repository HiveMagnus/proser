-- CreateTable
CREATE TABLE "scene_document_revisions" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "parent_revision_id" TEXT,
    "schema_version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "original_prose" TEXT,
    "actor_id" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scene_document_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_document_heads" (
    "book_id" INTEGER NOT NULL,
    "revision_id" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_document_heads_pkey" PRIMARY KEY ("book_id")
);

-- CreateTable
CREATE TABLE "book_document_revisions" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "parent_revision_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "operation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "book_document_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_operations" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "request_hash" TEXT NOT NULL,
    "receipt" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_originals" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "fidelity" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_originals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_publications" (
    "id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "revision_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scene_document_revisions_book_id_scene_id_created_at_idx" ON "scene_document_revisions"("book_id", "scene_id", "created_at");

-- CreateIndex
CREATE INDEX "book_document_revisions_book_id_created_at_idx" ON "book_document_revisions"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "document_operations_book_id_user_id_idx" ON "document_operations"("book_id", "user_id");

-- CreateIndex
CREATE INDEX "document_originals_book_id_user_id_idx" ON "document_originals"("book_id", "user_id");

-- CreateIndex
CREATE INDEX "document_publications_book_id_user_id_created_at_idx" ON "document_publications"("book_id", "user_id", "created_at");

