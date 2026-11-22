-- Candidate-reviewed metadata alignment. This is intentionally NOT additive-
-- compatible; the conservative classifier must reject it. Rehearse the exact
-- SQL on both a fresh fixture and an original-production backup restore.
-- Existing production names/defaults are preserved. No row/history is edited.
DO $$
DECLARE relation_name text; generated_name text; retained_name text; generated_exists boolean; retained_exists boolean; definition text;
BEGIN
 FOR relation_name,generated_name,retained_name IN SELECT * FROM (VALUES
 ('browser_run_case_results','browser_run_case_results_browser_run_id_fkey','browser_run_case_results_run_fkey'),
 ('browser_run_receipts','browser_run_receipts_browser_run_id_fkey','browser_run_receipts_run_fkey'),
 ('browser_run_terminals','browser_run_terminals_browser_run_id_fkey','browser_run_terminals_run_fkey')) AS names(relation_name,generated_name,retained_name) LOOP
  SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(relation_name) AND conname=generated_name AND contype='f'),EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(relation_name) AND conname=retained_name AND contype='f') INTO generated_exists,retained_exists;
  IF generated_exists=retained_exists THEN RAISE EXCEPTION 'PROSER_ALIGNMENT_UNKNOWN: expected exactly one known foreign-key identity on %',relation_name; END IF;
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid=to_regclass(relation_name) AND conname=CASE WHEN retained_exists THEN retained_name ELSE generated_name END;
  IF definition NOT IN ('FOREIGN KEY (browser_run_id) REFERENCES browser_runs(id) ON DELETE RESTRICT','FOREIGN KEY (browser_run_id) REFERENCES browser_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT') THEN RAISE EXCEPTION 'PROSER_ALIGNMENT_UNKNOWN: unexpected foreign-key definition on %',relation_name; END IF;
  IF generated_exists THEN EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',relation_name,generated_name,retained_name); END IF;
 END LOOP;
 FOR relation_name IN SELECT unnest(ARRAY['document_inference_operations','document_proposals','document_trace_analyses']) LOOP
  SELECT pg_get_expr(d.adbin,d.adrelid) INTO definition FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass(relation_name) AND a.attname='updated_at' AND NOT a.attisdropped;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSER_ALIGNMENT_UNKNOWN: missing updated_at on %',relation_name; END IF;
  IF definition IS NOT NULL THEN
   IF definition NOT IN ('CURRENT_TIMESTAMP','now()') THEN RAISE EXCEPTION 'PROSER_ALIGNMENT_UNKNOWN: unexpected updated_at default on %',relation_name; END IF;
   EXECUTE format('ALTER TABLE %I ALTER COLUMN updated_at DROP DEFAULT',relation_name);
  END IF;
 END LOOP;
 IF to_regclass('_proser_cutover_receipts_source_sha256_key') IS NULL THEN
  CREATE UNIQUE INDEX "_proser_cutover_receipts_source_sha256_key" ON "_proser_cutover_receipts" ("source_sha256");
 ELSE
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0] WHERE i.indexrelid=to_regclass('_proser_cutover_receipts_source_sha256_key') AND i.indrelid=to_regclass('_proser_cutover_receipts') AND i.indisunique AND i.indisvalid AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND i.indpred IS NULL AND a.attname='source_sha256') THEN RAISE EXCEPTION 'PROSER_ALIGNMENT_UNKNOWN: source receipt uniqueness has unexpected metadata'; END IF;
 END IF;
END $$;
