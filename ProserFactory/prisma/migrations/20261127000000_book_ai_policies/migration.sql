-- A writer's per-book switch that keeps the book away from model providers.
CREATE TABLE "book_ai_policies" (
    "book_id" INTEGER NOT NULL,
    "ai_disabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_ai_policies_pkey" PRIMARY KEY ("book_id")
);

CREATE INDEX "idx_book_ai_policies_disabled" ON "book_ai_policies"("ai_disabled");

ALTER TABLE "book_ai_policies" ADD CONSTRAINT "book_ai_policies_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
