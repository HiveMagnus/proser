CREATE TABLE "revision_campaigns" (
 "id" TEXT PRIMARY KEY, "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1, "goal" TEXT NOT NULL, "preset" TEXT NOT NULL,
 "constraints" JSONB NOT NULL, "confirmed" BOOLEAN NOT NULL DEFAULT false,
 "status" TEXT NOT NULL DEFAULT 'active', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "revision_campaigns_book_id_user_id_idx" ON "revision_campaigns"("book_id","user_id");
CREATE TABLE "revision_campaign_plans" (
 "id" TEXT PRIMARY KEY, "campaign_id" TEXT NOT NULL REFERENCES "revision_campaigns"("id"),
 "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL, "campaign_version" INTEGER NOT NULL,
 "run_id" TEXT NOT NULL REFERENCES "workflow_runs"("id"), "snapshot" JSONB NOT NULL,
 CONSTRAINT "revision_campaign_plans_run_id_key" UNIQUE ("run_id"),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "revision_campaign_plans_book_id_campaign_id_created_at_idx" ON "revision_campaign_plans"("book_id","campaign_id","created_at");
CREATE TABLE "revision_campaign_records" (
 "id" TEXT PRIMARY KEY, "campaign_id" TEXT NOT NULL REFERENCES "revision_campaigns"("id"),
 "plan_id" TEXT REFERENCES "revision_campaign_plans"("id"), "book_id" INTEGER NOT NULL, "user_id" INTEGER NOT NULL,
 "kind" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "revision_campaign_records_book_id_campaign_id_created_at_idx" ON "revision_campaign_records"("book_id","campaign_id","created_at");
