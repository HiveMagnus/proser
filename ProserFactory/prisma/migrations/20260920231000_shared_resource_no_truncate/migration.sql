CREATE FUNCTION proser_shared_resource_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shared resource ownership history cannot be truncated or reset';
END $$;

CREATE TRIGGER shared_resource_operations_no_truncate
BEFORE TRUNCATE ON "shared_resource_operations"
FOR EACH STATEMENT EXECUTE FUNCTION proser_shared_resource_truncate_guard();

CREATE TRIGGER shared_resource_fences_no_truncate
BEFORE TRUNCATE ON "shared_resource_fences"
FOR EACH STATEMENT EXECUTE FUNCTION proser_shared_resource_truncate_guard();
