-- CreateTable
CREATE TABLE "evaluation_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "suite_key" TEXT NOT NULL,
    "suite_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "config" JSONB NOT NULL,
    "code_revision" TEXT NOT NULL,
    "schema_revision" TEXT NOT NULL,
    "metrics" JSONB,
    "report_hash" TEXT,
    "report" JSONB,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evaluation_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "evaluation_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "evaluation_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "evaluation_run_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "source_revision_id" TEXT,
    "pass_key" TEXT NOT NULL,
    "pass_version" TEXT NOT NULL,
    "model" TEXT,
    "recipe_version" TEXT,
    "sampling_hash" TEXT,
    "rag_hash" TEXT,
    "policy_version" TEXT NOT NULL,
    "profile_version" TEXT,
    "judge_profile" TEXT,
    "verdict" TEXT NOT NULL,
    "expected_match" BOOLEAN,
    "hard_invariants" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "inference_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evaluation_results_evaluation_run_id_fkey" FOREIGN KEY ("evaluation_run_id") REFERENCES "evaluation_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "evaluation_results_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "evaluation_corpus_cases" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "evaluation_results_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow_run_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "source_revision_id" TEXT NOT NULL,
    "result_revision_id" TEXT,
    "profile_id" TEXT,
    "profile_version" TEXT,
    "profile_hash" TEXT,
    "pass_pack_key" TEXT NOT NULL,
    "pass_pack_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "autonomy" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "outcome" TEXT,
    "request_config" JSONB NOT NULL,
    "metrics" JSONB,
    "evidence_summary" JSONB,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_runs_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_runs_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "editorial_runs_result_revision_id_fkey" FOREIGN KEY ("result_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "editorial_runs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "editorial_profiles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_proposals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "editorial_run_id" TEXT NOT NULL,
    "source_revision_id" TEXT NOT NULL,
    "book_id" INTEGER NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "pass_key" TEXT NOT NULL,
    "pass_version" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "fingerprint" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "original_text" TEXT NOT NULL,
    "before_anchor" TEXT,
    "after_anchor" TEXT,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "expected_benefits" JSONB NOT NULL,
    "protected_claims" JSONB NOT NULL,
    "finding_ids" JSONB NOT NULL,
    "detector_ids" JSONB NOT NULL,
    "auto_applied" BOOLEAN NOT NULL DEFAULT false,
    "verification_status" TEXT NOT NULL DEFAULT 'pending',
    "verification_evidence" JSONB,
    "applied_revision_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_proposals_editorial_run_id_fkey" FOREIGN KEY ("editorial_run_id") REFERENCES "editorial_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_proposals_source_revision_id_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_candidates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "proposal_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "candidate_type" TEXT NOT NULL,
    "producer_profile" TEXT,
    "producer_model" TEXT,
    "recipe_version" TEXT,
    "sampling_hash" TEXT,
    "rag_hash" TEXT,
    "output_text" TEXT NOT NULL,
    "output_hash" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "metadata" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_candidates_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "editorial_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_evaluations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "proposal_id" TEXT NOT NULL,
    "evaluator_profile" TEXT NOT NULL,
    "evaluator_version" TEXT NOT NULL,
    "evaluator_model" TEXT,
    "prompt_recipe" TEXT NOT NULL,
    "candidate_order" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "preferred_candidate_id" TEXT,
    "confidence" REAL NOT NULL,
    "preference_margin" REAL NOT NULL,
    "dimension_scores" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "hard_check_summary" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_evaluations_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "editorial_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_evaluations_preferred_candidate_id_fkey" FOREIGN KEY ("preferred_candidate_id") REFERENCES "editorial_candidates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_profiles_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_profiles_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "editorial_profiles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_preference_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "editorial_run_id" TEXT,
    "proposal_id" TEXT,
    "candidate_id" TEXT,
    "action_id" INTEGER,
    "evidence_type" TEXT NOT NULL,
    "pass_key" TEXT,
    "feature_vector" JSONB,
    "weight" REAL NOT NULL,
    "rationale_tags" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "editorial_preference_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_preference_evidence_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "editorial_preference_evidence_editorial_run_id_fkey" FOREIGN KEY ("editorial_run_id") REFERENCES "editorial_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "editorial_preference_evidence_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "editorial_proposals" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "editorial_preference_evidence_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "editorial_candidates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "style_fingerprints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "book_id" INTEGER NOT NULL,
    "revision_id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "fingerprint_version" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "vector_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "style_fingerprints_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "style_fingerprints_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_evaluation_corpus_cases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "genre" TEXT,
    "suite_key" TEXT NOT NULL DEFAULT 'legacy',
    "suite_version" TEXT NOT NULL DEFAULT '1.0.0',
    "case_version" TEXT NOT NULL DEFAULT '1.0.0',
    "tags" JSONB,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "input" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "invariant_rules" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL DEFAULT '',
    "expected_hash" TEXT NOT NULL DEFAULT '',
    "weight" REAL NOT NULL DEFAULT 1,
    "updated_by_build_revision" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_evaluation_corpus_cases" ("active", "created_at", "expected", "genre", "id", "input", "invariant_rules", "level", "name", "updated_at") SELECT "active", "created_at", "expected", "genre", "id", "input", "invariant_rules", "level", "name", "updated_at" FROM "evaluation_corpus_cases";
DROP TABLE "evaluation_corpus_cases";
ALTER TABLE "new_evaluation_corpus_cases" RENAME TO "evaluation_corpus_cases";
CREATE UNIQUE INDEX "evaluation_corpus_cases_name_key" ON "evaluation_corpus_cases"("name");
CREATE INDEX "idx_evaluation_case_suite" ON "evaluation_corpus_cases"("suite_key", "suite_version", "active");
CREATE TABLE "new_quality_findings_v1" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_run_id" TEXT NOT NULL,
    "related_fingerprint" TEXT,
    "fingerprint" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" INTEGER,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" TEXT,
    "recommendation" TEXT,
    "implemented" BOOLEAN NOT NULL DEFAULT false,
    "implemented_at" DATETIME,
    "implementing_workflow_run_id" TEXT,
    "implemented_revision_id" TEXT,
    "changed_scopes" JSONB,
    "diff_summary" TEXT,
    "verification_status" TEXT NOT NULL DEFAULT 'not_implemented',
    "verification_evidence" TEXT,
    "verified_at" DATETIME,
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "waiver_reason" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "detector_key" TEXT,
    "detector_version" TEXT,
    "risk_level" TEXT NOT NULL DEFAULT 'medium',
    "autofix_eligible" BOOLEAN NOT NULL DEFAULT false,
    "editorial_pass_key" TEXT,
    "editorial_pass_version" TEXT,
    "metadata" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_findings_v1_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "quality_review_runs_v1" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quality_findings_v1_implementing_workflow_run_id_fkey" FOREIGN KEY ("implementing_workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "quality_findings_v1_implemented_revision_id_fkey" FOREIGN KEY ("implemented_revision_id") REFERENCES "manuscript_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_quality_findings_v1" ("category", "changed_scopes", "confidence", "created_at", "diff_summary", "evidence", "fingerprint", "id", "implemented", "implemented_at", "implemented_revision_id", "implementing_workflow_run_id", "message", "recommendation", "related_fingerprint", "review_run_id", "scope_id", "scope_type", "severity", "stale", "superseded", "updated_at", "verification_evidence", "verification_status", "verified_at", "waived", "waiver_reason") SELECT "category", "changed_scopes", "confidence", "created_at", "diff_summary", "evidence", "fingerprint", "id", "implemented", "implemented_at", "implemented_revision_id", "implementing_workflow_run_id", "message", "recommendation", "related_fingerprint", "review_run_id", "scope_id", "scope_type", "severity", "stale", "superseded", "updated_at", "verification_evidence", "verification_status", "verified_at", "waived", "waiver_reason" FROM "quality_findings_v1";
DROP TABLE "quality_findings_v1";
ALTER TABLE "new_quality_findings_v1" RENAME TO "quality_findings_v1";
CREATE INDEX "idx_quality_finding_state" ON "quality_findings_v1"("review_run_id", "implemented", "verification_status");
CREATE UNIQUE INDEX "uniq_quality_finding_review_fingerprint" ON "quality_findings_v1"("review_run_id", "fingerprint");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "idx_evaluation_run_suite" ON "evaluation_runs"("suite_key", "suite_version", "created_at");

-- CreateIndex
CREATE INDEX "idx_evaluation_run_user_status" ON "evaluation_runs"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_evaluation_run_idempotency" ON "evaluation_runs"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "idx_evaluation_result_run" ON "evaluation_results"("evaluation_run_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_evaluation_result_case_pass" ON "evaluation_results"("case_id", "pass_key");

-- CreateIndex
CREATE INDEX "idx_evaluation_result_model" ON "evaluation_results"("model");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_evaluation_result_matrix" ON "evaluation_results"("evaluation_run_id", "case_id", "pass_key", "pass_version", "model");

-- CreateIndex
CREATE UNIQUE INDEX "editorial_runs_workflow_run_id_key" ON "editorial_runs"("workflow_run_id");

-- CreateIndex
CREATE INDEX "idx_editorial_run_book_created" ON "editorial_runs"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_editorial_run_source_revision" ON "editorial_runs"("source_revision_id");

-- CreateIndex
CREATE INDEX "idx_editorial_run_pass" ON "editorial_runs"("pass_pack_key", "pass_pack_version");

-- CreateIndex
CREATE INDEX "idx_editorial_proposal_run_status" ON "editorial_proposals"("editorial_run_id", "status");

-- CreateIndex
CREATE INDEX "idx_editorial_proposal_book_scope" ON "editorial_proposals"("book_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "idx_editorial_proposal_source_revision" ON "editorial_proposals"("source_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_editorial_proposal_fingerprint" ON "editorial_proposals"("editorial_run_id", "fingerprint");

-- CreateIndex
CREATE INDEX "idx_editorial_candidate_type" ON "editorial_candidates"("proposal_id", "candidate_type");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_editorial_candidate_ordinal" ON "editorial_candidates"("proposal_id", "ordinal");

-- CreateIndex
CREATE INDEX "idx_editorial_evaluation_proposal" ON "editorial_evaluations"("proposal_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_editorial_evaluation_profile" ON "editorial_evaluations"("evaluator_profile", "evaluator_version");

-- CreateIndex
CREATE INDEX "idx_editorial_evaluation_model" ON "editorial_evaluations"("evaluator_model");

-- CreateIndex
CREATE INDEX "idx_editorial_profile_user_active" ON "editorial_profiles"("user_id", "active");

-- CreateIndex
CREATE INDEX "idx_editorial_profile_book_active" ON "editorial_profiles"("book_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_editorial_profile_version" ON "editorial_profiles"("user_id", "name", "version");

-- CreateIndex
CREATE INDEX "idx_editorial_preference_user" ON "editorial_preference_evidence"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_editorial_preference_book_pass" ON "editorial_preference_evidence"("book_id", "pass_key");

-- CreateIndex
CREATE INDEX "idx_style_fingerprint_revision" ON "style_fingerprints"("revision_id", "fingerprint_version");

-- CreateIndex
CREATE INDEX "idx_style_fingerprint_book_scope" ON "style_fingerprints"("book_id", "scope_type", "scope_id");
