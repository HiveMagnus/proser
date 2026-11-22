-- CreateTable
CREATE TABLE "narrative_ledgers_v1" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow_run_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "ledger_type" TEXT NOT NULL,
    "ledger_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "introduced_scene_id" INTEGER,
    "due_scene_id" INTEGER,
    "resolved_scene_id" INTEGER,
    "payload" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "narrative_ledgers_v1_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "idx_workflow_ledger_book_state" ON "narrative_ledgers_v1"("book_id", "ledger_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_workflow_ledger_key" ON "narrative_ledgers_v1"("workflow_run_id", "ledger_type", "ledger_key");
