DROP INDEX "uniq_revision_book_hash";
CREATE INDEX "idx_revision_book_hash" ON "manuscript_revisions"("book_id", "content_hash");
