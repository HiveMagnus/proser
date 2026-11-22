CREATE TABLE "_proser_cutover_receipts" (
    "operation_id" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "postgres_checkpoint_sha256" TEXT NOT NULL,
    "source_report_hash" TEXT NOT NULL,
    "target_report_hash" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "evidence_signature" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_proser_cutover_receipts_pkey" PRIMARY KEY ("operation_id")
);

CREATE UNIQUE INDEX "_proser_cutover_receipts_source_sha256_key"
ON "_proser_cutover_receipts"("source_sha256");
