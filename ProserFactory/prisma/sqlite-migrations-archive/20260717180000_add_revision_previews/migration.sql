CREATE TABLE "revision_previews" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "book_id" INTEGER NOT NULL,
  "scope_type" TEXT NOT NULL,
  "scope_id" INTEGER NOT NULL,
  "source_revision" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" DATETIME NOT NULL,
  "accepted_at" DATETIME,
  CONSTRAINT "revision_previews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "revision_previews_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_revision_previews_user_status" ON "revision_previews"("user_id", "status");
CREATE INDEX "idx_revision_previews_book_created" ON "revision_previews"("book_id", "created_at");
