CREATE TABLE "document_discussions" (
  "id" TEXT NOT NULL, "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL,
  "scene_id" INTEGER NOT NULL, "session_id" TEXT NOT NULL, "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL, "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_discussions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_discussions_book_id_user_id_created_at_idx" ON "document_discussions"("book_id", "user_id", "created_at");
CREATE TABLE "document_proposals" (
  "id" TEXT NOT NULL, "discussion_id" TEXT NOT NULL, "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL, "scene_id" INTEGER NOT NULL, "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "result" JSONB,
  "error_code" TEXT, "application_operation_id" TEXT,
  "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_proposals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_proposals_book_id_user_id_created_at_idx" ON "document_proposals"("book_id", "user_id", "created_at");
CREATE INDEX "document_proposals_discussion_id_created_at_idx" ON "document_proposals"("discussion_id", "created_at");
CREATE TABLE "document_proposal_validations" (
  "id" TEXT NOT NULL, "proposal_id" TEXT NOT NULL, "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL, "book_revision_id" TEXT NOT NULL, "scene_revision_id" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL, "targets" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_proposal_validations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_proposal_validations_proposal_id_created_at_idx" ON "document_proposal_validations"("proposal_id", "created_at");
