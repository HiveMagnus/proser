CREATE TABLE "browser_runs" (
  "id" TEXT NOT NULL,
  "receipt_id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "evaluation_id" TEXT NOT NULL,
  "package_id" TEXT NOT NULL,
  "package_revision" INTEGER NOT NULL,
  "package_digest" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "target_origin" TEXT NOT NULL,
  "target_service_id" TEXT NOT NULL,
  "runner_build_sha256" TEXT NOT NULL,
  "fixture_sha256" TEXT NOT NULL,
  "case_plan" JSONB NOT NULL,
  "case_plan_sha256" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "browser_runs_package_revision_check" CHECK ("package_revision" BETWEEN 1 AND 1000000),
  CONSTRAINT "browser_runs_audience_check" CHECK ("audience" = 'nova-creative'),
  CONSTRAINT "browser_runs_surface_check" CHECK ("surface" = 'proser_browser'),
  CONSTRAINT "browser_runs_request_id_check" CHECK ("request_id" ~ '^nova-[a-f0-9]{32}$'),
  CONSTRAINT "browser_runs_digest_check" CHECK (
    "package_digest" ~ '^[a-f0-9]{64}$' AND
    "runner_build_sha256" ~ '^[a-f0-9]{64}$' AND
    "fixture_sha256" ~ '^[a-f0-9]{64}$' AND
    "case_plan_sha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "browser_runs_case_plan_check" CHECK (jsonb_typeof("case_plan") = 'array')
);

CREATE TABLE "browser_run_case_results" (
  "browser_run_id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "evidence_sha256" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_run_case_results_pkey" PRIMARY KEY ("browser_run_id", "case_id"),
  CONSTRAINT "browser_run_case_results_status_check" CHECK ("status" IN ('pass', 'fail', 'blocked')),
  CONSTRAINT "browser_run_case_results_evidence_check" CHECK ("evidence_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "browser_run_case_results_run_fkey" FOREIGN KEY ("browser_run_id") REFERENCES "browser_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "browser_run_terminals" (
  "browser_run_id" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "cases" JSONB NOT NULL,
  "case_cohort_sha256" TEXT NOT NULL,
  "result_sha256" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_run_terminals_pkey" PRIMARY KEY ("browser_run_id"),
  CONSTRAINT "browser_run_terminals_outcome_check" CHECK ("outcome" IN ('passed', 'failed', 'blocked')),
  CONSTRAINT "browser_run_terminals_digest_check" CHECK ("case_cohort_sha256" ~ '^[a-f0-9]{64}$' AND "result_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "browser_run_terminals_cases_check" CHECK (jsonb_typeof("cases") = 'array'),
  CONSTRAINT "browser_run_terminals_run_fkey" FOREIGN KEY ("browser_run_id") REFERENCES "browser_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "browser_run_receipts" (
  "browser_run_id" TEXT NOT NULL,
  "receipt_id" TEXT NOT NULL,
  "key_id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "canonical_json" TEXT NOT NULL,
  "receipt_sha256" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_run_receipts_pkey" PRIMARY KEY ("browser_run_id"),
  CONSTRAINT "browser_run_receipts_key_check" CHECK ("key_id" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "browser_run_receipts_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$'),
  CONSTRAINT "browser_run_receipts_digest_check" CHECK ("receipt_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "browser_run_receipts_run_fkey" FOREIGN KEY ("browser_run_id") REFERENCES "browser_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "browser_runs_receipt_id_key" ON "browser_runs"("receipt_id");
CREATE UNIQUE INDEX "browser_runs_evaluation_id_key" ON "browser_runs"("evaluation_id");
CREATE INDEX "idx_browser_runs_request_evaluation" ON "browser_runs"("request_id", "evaluation_id");
CREATE UNIQUE INDEX "browser_run_receipts_receipt_id_key" ON "browser_run_receipts"("receipt_id");
CREATE UNIQUE INDEX "browser_run_receipts_receipt_sha256_key" ON "browser_run_receipts"("receipt_sha256");

CREATE FUNCTION reject_browser_run_journal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'browser run journal table % is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER browser_runs_append_only
BEFORE UPDATE OR DELETE ON "browser_runs"
FOR EACH ROW EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_run_case_results_append_only
BEFORE UPDATE OR DELETE ON "browser_run_case_results"
FOR EACH ROW EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_run_terminals_append_only
BEFORE UPDATE OR DELETE ON "browser_run_terminals"
FOR EACH ROW EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_run_receipts_append_only
BEFORE UPDATE OR DELETE ON "browser_run_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_runs_no_truncate
BEFORE TRUNCATE ON "browser_runs"
FOR EACH STATEMENT EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_run_case_results_no_truncate
BEFORE TRUNCATE ON "browser_run_case_results"
FOR EACH STATEMENT EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_run_terminals_no_truncate
BEFORE TRUNCATE ON "browser_run_terminals"
FOR EACH STATEMENT EXECUTE FUNCTION reject_browser_run_journal_mutation();

CREATE TRIGGER browser_run_receipts_no_truncate
BEFORE TRUNCATE ON "browser_run_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION reject_browser_run_journal_mutation();
