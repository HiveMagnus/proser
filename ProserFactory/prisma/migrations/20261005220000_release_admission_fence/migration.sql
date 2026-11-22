-- Additive compatibility support only. No live fence/activation is performed.
CREATE TABLE "release_admission_fence" ("id" INTEGER NOT NULL PRIMARY KEY, "phase" TEXT NOT NULL DEFAULT 'open', "generation" INTEGER NOT NULL DEFAULT 0, "release_id" TEXT, "candidate_sha" TEXT, "proof_sha" TEXT, "cutoff" TIMESTAMP(3), "operator" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "release_admission_fence" ("id") VALUES (1);
CREATE TABLE "release_fence_receipts" ("operation_id" TEXT NOT NULL PRIMARY KEY, "release_id" TEXT NOT NULL, "action" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "expected_generation" INTEGER NOT NULL, "operator" TEXT NOT NULL, "result" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "release_fence_receipts_release_id_created_at_idx" ON "release_fence_receipts" ("release_id", "created_at");
CREATE TABLE "release_mutation_admissions" ("id" TEXT NOT NULL PRIMARY KEY, "instance_id" TEXT NOT NULL, "user_id" INTEGER, "kind" TEXT NOT NULL, "scope" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "generation" INTEGER NOT NULL, "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "release_mutation_admissions_accepted_at_id_idx" ON "release_mutation_admissions" ("accepted_at", "id");
CREATE TABLE "release_admission_bindings" ("id" TEXT NOT NULL PRIMARY KEY, "admission_id" TEXT NOT NULL, "domain_kind" TEXT NOT NULL, "domain_id" TEXT NOT NULL, "source_book_id" INTEGER, "source_revision_id" TEXT, "source_hash" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "release_admission_bindings_admission_id_domain_kind_domain_id_key" ON "release_admission_bindings" ("admission_id", "domain_kind", "domain_id");
CREATE INDEX "release_admission_bindings_admission_id_idx" ON "release_admission_bindings" ("admission_id");
