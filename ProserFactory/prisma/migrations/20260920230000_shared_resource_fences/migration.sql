CREATE TABLE "shared_resource_operations" (
  "operation_id" TEXT NOT NULL,
  "lease_id" TEXT NOT NULL,
  "claim_json" TEXT NOT NULL,
  "claim_sha256" TEXT NOT NULL,
  "request_sha256" TEXT NOT NULL,
  "evidence_domain" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "body_sha256" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'admitted',
  "response_status" INTEGER,
  "response_json" TEXT,
  "result_json" TEXT,
  "evidence_sha256" TEXT,
  "terminal_evidence_json" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "shared_resource_operations_pkey" PRIMARY KEY ("operation_id"),
  CONSTRAINT "shared_resource_operation_state_check" CHECK ("state" IN ('admitted','running','succeeded','failed','no_effect')),
  CONSTRAINT "shared_resource_operation_terminal_check" CHECK (
    ("state" IN ('admitted','running') AND "response_status" IS NULL AND "response_json" IS NULL AND "result_json" IS NULL AND "evidence_sha256" IS NULL AND "terminal_evidence_json" IS NULL AND "completed_at" IS NULL)
    OR
    ("state" IN ('succeeded','failed','no_effect') AND "result_json" IS NOT NULL AND length("evidence_sha256") = 64 AND "terminal_evidence_json" IS NOT NULL AND "completed_at" IS NOT NULL)
  )
);

CREATE TABLE "shared_resource_fences" (
  "resource_key" TEXT NOT NULL,
  "highest_generation" BIGINT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shared_resource_fences_pkey" PRIMARY KEY ("resource_key"),
  CONSTRAINT "shared_resource_fence_generation_check" CHECK ("highest_generation" > 0)
);

CREATE INDEX "idx_shared_resource_operation_lease" ON "shared_resource_operations"("lease_id");
CREATE INDEX "idx_shared_resource_operation_state" ON "shared_resource_operations"("state", "created_at");
CREATE INDEX "idx_shared_resource_fence_operation" ON "shared_resource_fences"("operation_id");

CREATE FUNCTION proser_shared_resource_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.lease_id IS DISTINCT FROM NEW.lease_id
     OR OLD.claim_json IS DISTINCT FROM NEW.claim_json OR OLD.claim_sha256 IS DISTINCT FROM NEW.claim_sha256
     OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256 OR OLD.evidence_domain IS DISTINCT FROM NEW.evidence_domain
     OR OLD.method IS DISTINCT FROM NEW.method OR OLD.route IS DISTINCT FROM NEW.route OR OLD.body_sha256 IS DISTINCT FROM NEW.body_sha256
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'shared resource operation identity is immutable';
  END IF;
  IF NOT ((OLD.state = 'admitted' AND NEW.state IN ('admitted','running','no_effect'))
       OR (OLD.state = 'running' AND NEW.state IN ('running','succeeded','failed'))
       OR (OLD.state IN ('succeeded','failed','no_effect') AND NEW.state = OLD.state)) THEN
    RAISE EXCEPTION 'shared resource operation state transition is invalid';
  END IF;
  IF OLD.terminal_evidence_json IS NOT NULL AND (
       NEW.response_status IS DISTINCT FROM OLD.response_status
       OR NEW.response_json IS DISTINCT FROM OLD.response_json
       OR NEW.result_json IS DISTINCT FROM OLD.result_json
       OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
       OR NEW.terminal_evidence_json IS DISTINCT FROM OLD.terminal_evidence_json
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'shared resource terminal result is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_resource_operation_guard BEFORE UPDATE ON "shared_resource_operations"
FOR EACH ROW EXECUTE FUNCTION proser_shared_resource_operation_guard();

CREATE FUNCTION proser_shared_resource_operation_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'shared resource operation history cannot be deleted or reset'; END $$;
CREATE TRIGGER shared_resource_operation_delete_guard BEFORE DELETE ON "shared_resource_operations"
FOR EACH ROW EXECUTE FUNCTION proser_shared_resource_operation_delete_guard();

CREATE FUNCTION proser_shared_resource_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.resource_key <> NEW.resource_key OR NEW.highest_generation <= OLD.highest_generation THEN
      RAISE EXCEPTION 'shared resource fence identity or generation is invalid';
    END IF;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "shared_resource_operations" operation,
      jsonb_array_elements((operation.claim_json::jsonb)->'resources') AS member
    WHERE operation.operation_id = NEW.operation_id
      AND member->>'resourceKey' = NEW.resource_key
      AND (member->>'fenceGeneration')::numeric = NEW.highest_generation::numeric
  ) INTO matched;
  IF NOT matched THEN RAISE EXCEPTION 'shared resource fence must match its immutable operation claim'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_resource_fence_guard BEFORE INSERT OR UPDATE ON "shared_resource_fences"
FOR EACH ROW EXECUTE FUNCTION proser_shared_resource_fence_guard();

CREATE FUNCTION proser_shared_resource_fence_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'shared resource fence history cannot be deleted or reset'; END $$;
CREATE TRIGGER shared_resource_fence_delete_guard BEFORE DELETE ON "shared_resource_fences"
FOR EACH ROW EXECUTE FUNCTION proser_shared_resource_fence_delete_guard();
