-- New source-qualified ancillary-story AI records. Existing scene evidence is
-- neither relabelled nor rewritten; a story never borrows a scene identity.
CREATE TABLE "document_story_discussions" (
  "id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "story_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_story_discussions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "document_story_proposals" (
  "id" TEXT NOT NULL,
  "discussion_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "story_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "error_code" TEXT,
  "application_operation_id" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_story_proposals_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "document_story_proposal_validations" (
  "id" TEXT NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "book_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "book_revision_id" TEXT NOT NULL,
  "layout_revision_id" TEXT NOT NULL,
  "story_id" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "targets" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_story_proposal_validations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_story_discussions_book_id_user_id_created_at_idx" ON "document_story_discussions"("book_id", "user_id", "created_at");
CREATE INDEX "document_story_proposals_book_id_user_id_created_at_idx" ON "document_story_proposals"("book_id", "user_id", "created_at");
CREATE INDEX "document_story_proposals_discussion_id_created_at_idx" ON "document_story_proposals"("discussion_id", "created_at");
CREATE INDEX "document_story_proposal_validations_proposal_id_created_at_idx" ON "document_story_proposal_validations"("proposal_id", "created_at");
