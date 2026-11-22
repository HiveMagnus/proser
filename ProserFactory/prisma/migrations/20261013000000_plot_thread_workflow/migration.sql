ALTER TABLE "plot_threads" ADD COLUMN "question" TEXT;
ALTER TABLE "plot_threads" ADD COLUMN "author_managed" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "plot_threads" ADD COLUMN "version" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "plot_threads" ADD COLUMN "archived_at" TIMESTAMP(3);
CREATE TABLE "plot_thread_evidence" (
  "id" TEXT PRIMARY KEY, "book_id" INTEGER NOT NULL, "thread_id" INTEGER NOT NULL,
  "stage" TEXT NOT NULL, "source" JSONB NOT NULL, "removed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plot_thread_evidence_stage" CHECK ("stage" IN ('setup','escalation','payoff'))
);
CREATE INDEX "plot_thread_evidence_book_id_thread_id_idx" ON "plot_thread_evidence"("book_id","thread_id");
CREATE TABLE "plot_thread_reviews" (
  "id" TEXT PRIMARY KEY, "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL,
  "thread_id" INTEGER NOT NULL, "request_hash" TEXT NOT NULL, "request" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "result" JSONB,
  "error_code" TEXT, "assessment" TEXT, "notes" TEXT, "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "plot_thread_reviews_book_id_thread_id_created_at_idx" ON "plot_thread_reviews"("book_id","thread_id","created_at");
CREATE TABLE "plot_thread_mutations" (
  "id" TEXT PRIMARY KEY, "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL,
  "request_hash" TEXT NOT NULL, "receipt" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "plot_thread_mutations_book_id_user_id_idx" ON "plot_thread_mutations"("book_id","user_id");
