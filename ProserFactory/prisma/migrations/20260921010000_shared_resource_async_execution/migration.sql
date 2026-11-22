ALTER TABLE "shared_resource_operations"
  ADD COLUMN "execution_kind" TEXT,
  ADD COLUMN "execution_id" TEXT,
  ADD CONSTRAINT "shared_resource_execution_pair_check" CHECK (
    ("execution_kind" IS NULL AND "execution_id" IS NULL)
    OR ("execution_kind" IN ('workflow') AND length("execution_id") BETWEEN 1 AND 128)
  );

CREATE UNIQUE INDEX "uniq_shared_resource_execution"
  ON "shared_resource_operations"("execution_kind", "execution_id");

CREATE OR REPLACE FUNCTION proser_shared_resource_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.lease_id IS DISTINCT FROM NEW.lease_id
     OR OLD.claim_json IS DISTINCT FROM NEW.claim_json OR OLD.claim_sha256 IS DISTINCT FROM NEW.claim_sha256
     OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256 OR OLD.evidence_domain IS DISTINCT FROM NEW.evidence_domain
     OR OLD.method IS DISTINCT FROM NEW.method OR OLD.route IS DISTINCT FROM NEW.route OR OLD.body_sha256 IS DISTINCT FROM NEW.body_sha256
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'shared resource operation identity is immutable';
  END IF;
  IF OLD.execution_kind IS NOT NULL AND (
       NEW.execution_kind IS DISTINCT FROM OLD.execution_kind
       OR NEW.execution_id IS DISTINCT FROM OLD.execution_id) THEN
    RAISE EXCEPTION 'shared resource execution binding is immutable';
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
