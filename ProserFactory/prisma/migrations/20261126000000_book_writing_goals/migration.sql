-- A writer's word-count target, deadline and daily goal for a book.
CREATE TABLE "book_writing_goals" (
    "book_id" INTEGER NOT NULL,
    "target_words" INTEGER,
    "deadline" DATE,
    "daily_words" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_writing_goals_pkey" PRIMARY KEY ("book_id"),
    CONSTRAINT "book_writing_goals_target_words_check" CHECK ("target_words" IS NULL OR "target_words" BETWEEN 1 AND 10000000),
    CONSTRAINT "book_writing_goals_daily_words_check" CHECK ("daily_words" IS NULL OR "daily_words" BETWEEN 1 AND 1000000)
);

ALTER TABLE "book_writing_goals" ADD CONSTRAINT "book_writing_goals_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
