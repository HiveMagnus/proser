-- Keep workflow status versions authoritative even when writes bypass the
-- application Prisma extension (raw SQL, maintenance tools, or other clients).
CREATE TRIGGER "workflow_runs_status_version_after_update"
AFTER UPDATE ON "workflow_runs"
FOR EACH ROW
WHEN NEW."status_version" = OLD."status_version"
BEGIN
  UPDATE "workflow_runs"
  SET "status_version" = OLD."status_version" + 1
  WHERE "id" = OLD."id";
END;
