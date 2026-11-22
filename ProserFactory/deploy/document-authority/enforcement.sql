-- Candidate-reviewed document authority enforcement. Not additive-compatible.
-- Install only through the reviewed procedure; activation defaults false.
CREATE TABLE IF NOT EXISTS proser_document_enforcement (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  candidate_sha text,
  rehearsal_sha256 text,
  activated_at timestamptz
);
INSERT INTO proser_document_enforcement(singleton) VALUES (true) ON CONFLICT DO NOTHING;
REVOKE ALL ON proser_document_enforcement FROM PUBLIC;
GRANT SELECT ON proser_document_enforcement TO PUBLIC;

CREATE OR REPLACE FUNCTION proser_document_visible(item jsonb, changes jsonb, paragraph boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE change jsonb; insertion boolean;
BEGIN
  SELECT value INTO change FROM jsonb_array_elements(coalesce(changes, '[]')) WHERE value->>'id' = item->>'changeId' LIMIT 1;
  IF change IS NULL OR (paragraph AND change->>'kind' NOT IN ('paragraphInsertion','paragraphDeletion')) OR (NOT paragraph AND change->>'kind' = 'format') THEN RETURN true; END IF;
  insertion := change->>'kind' = CASE WHEN paragraph THEN 'paragraphInsertion' ELSE 'insertion' END;
  IF change->>'status' = 'rejected' THEN
    RETURN CASE WHEN paragraph THEN NOT insertion ELSE change->>'kind' = 'deletion' END;
  END IF;
  RETURN insertion;
END $$;
CREATE OR REPLACE FUNCTION proser_document_paragraph(item jsonb, changes jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text := ''; run jsonb;
BEGIN
  FOR run IN SELECT value FROM jsonb_array_elements(item->'runs') LOOP
    IF proser_document_visible(run, changes, false) THEN result := result || CASE WHEN run ? 'inlineImage' THEN U&'\FFFC' ELSE (run->>'text') END; END IF;
  END LOOP;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION proser_document_boundary(left_paragraph jsonb, right_paragraph jsonb, changes jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE change jsonb; split boolean;
BEGIN
  IF left_paragraph IS NULL OR left_paragraph->>'type' <> 'paragraph' OR right_paragraph->>'type' <> 'paragraph' THEN RETURN true; END IF;
  SELECT value INTO change FROM jsonb_array_elements(coalesce(changes,'[]'))
    WHERE value->>'id'=left_paragraph->>'boundaryChangeId' AND value->>'kind' IN ('paragraphSplit','paragraphJoin')
      AND value->'targetBlockIds'->>0=left_paragraph->>'id' AND value->'targetBlockIds'->>1=right_paragraph->>'id' LIMIT 1;
  IF change IS NULL THEN RETURN true; END IF;
  split := change->>'kind'='paragraphSplit';
  RETURN CASE WHEN change->>'status'='rejected' THEN NOT split ELSE split END;
END $$;
CREATE OR REPLACE FUNCTION proser_document_projection(document jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text := ''; block jsonb; row jsonb; cell jsonb; paragraph jsonb; previous_block jsonb := NULL; previous_paragraph jsonb := NULL;
  blocks integer := 0; rows integer; cells integer; paragraphs integer;
BEGIN
  FOR block IN SELECT value FROM jsonb_array_elements(document->'blocks') LOOP
    IF block->>'type' = 'paragraph' AND NOT proser_document_visible(block, document->'changes', true) THEN CONTINUE; END IF;
    IF blocks > 0 AND proser_document_boundary(previous_block,block,document->'changes') THEN result := result || E'\n\n'; END IF; blocks := blocks + 1;
    CASE block->>'type'
      WHEN 'paragraph' THEN result := result || proser_document_paragraph(block, document->'changes');
      WHEN 'table' THEN
        rows := 0;
        FOR row IN SELECT value FROM jsonb_array_elements(block->'rows') LOOP
          IF rows > 0 THEN result := result || E'\n'; END IF; rows := rows + 1; cells := 0;
          FOR cell IN SELECT value FROM jsonb_array_elements(row->'cells') LOOP
            IF cells > 0 THEN result := result || E'\t'; END IF; cells := cells + 1; paragraphs := 0; previous_paragraph := NULL;
            FOR paragraph IN SELECT value FROM jsonb_array_elements(cell->'paragraphs') LOOP
              IF NOT proser_document_visible(paragraph, document->'changes', true) THEN CONTINUE; END IF;
              IF paragraphs > 0 AND proser_document_boundary(previous_paragraph,paragraph,document->'changes') THEN result := result || E'\n\n'; END IF; paragraphs := paragraphs + 1;
              result := result || proser_document_paragraph(paragraph, document->'changes'); previous_paragraph := paragraph;
            END LOOP;
          END LOOP;
        END LOOP;
      WHEN 'image' THEN result := result || U&'\FFFC';
      ELSE result := result || E'\f';
    END CASE;
    previous_block := block;
  END LOOP;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION proser_document_word_count(input text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT count(*)::integer FROM regexp_split_to_table(
    btrim(translate(replace(replace(input, U&'\FFFC',''), E'\f',''),
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF', repeat(' ',25))), ' +') AS word WHERE word <> '';
$$;
CREATE OR REPLACE FUNCTION proser_document_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_book integer; new_book integer; admitted text;
BEGIN
  IF NOT (SELECT enabled FROM proser_document_enforcement WHERE singleton) THEN RETURN coalesce(NEW,OLD); END IF;
  IF TG_ARGV[0] = 'immutable' THEN RAISE EXCEPTION 'PROSER_DOCUMENT_IMMUTABLE: % evidence cannot change', TG_TABLE_NAME USING ERRCODE='23514'; END IF;
  admitted := current_setting('proser.document_book',true);
  IF TG_TABLE_NAME IN ('books','book_document_heads') THEN
    old_book := CASE WHEN TG_OP <> 'INSERT' THEN CASE WHEN TG_TABLE_NAME = 'books' THEN (to_jsonb(OLD)->>'id')::integer ELSE (to_jsonb(OLD)->>'book_id')::integer END END;
    new_book := CASE WHEN TG_OP <> 'DELETE' THEN CASE WHEN TG_TABLE_NAME = 'books' THEN (to_jsonb(NEW)->>'id')::integer ELSE (to_jsonb(NEW)->>'book_id')::integer END END;
  ELSIF TG_TABLE_NAME IN ('acts','codex_entries') THEN
    IF TG_OP <> 'INSERT' THEN old_book := OLD.book_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_book := NEW.book_id; END IF;
  ELSIF TG_TABLE_NAME = 'chapters' THEN
    IF TG_OP <> 'INSERT' THEN SELECT book_id INTO old_book FROM acts WHERE id=OLD.act_id; END IF;
    IF TG_OP <> 'DELETE' THEN SELECT book_id INTO new_book FROM acts WHERE id=NEW.act_id; END IF;
  ELSE
    IF TG_TABLE_NAME='scenes' THEN
      IF TG_OP <> 'INSERT' THEN SELECT a.book_id INTO old_book FROM chapters c JOIN acts a ON a.id=c.act_id WHERE c.id=OLD.chapter_id; END IF;
      IF TG_OP <> 'DELETE' THEN SELECT a.book_id INTO new_book FROM chapters c JOIN acts a ON a.id=c.act_id WHERE c.id=NEW.chapter_id; END IF;
    ELSE
      IF TG_OP <> 'INSERT' THEN SELECT a.book_id INTO old_book FROM scenes s JOIN chapters c ON c.id=s.chapter_id JOIN acts a ON a.id=c.act_id WHERE s.id=OLD.scene_id; END IF;
      IF TG_OP <> 'DELETE' THEN SELECT a.book_id INTO new_book FROM scenes s JOIN chapters c ON c.id=s.chapter_id JOIN acts a ON a.id=c.act_id WHERE s.id=NEW.scene_id; END IF;
    END IF;
  END IF;
  -- New-book insertion allocates its ID before scoped admission. Deferred head
  -- validation prevents uninitialized books from committing while activated.
  IF TG_TABLE_NAME='books' AND TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF admitted IS NULL OR admitted='' OR (old_book IS NOT NULL AND admitted <> old_book::text) OR (new_book IS NOT NULL AND admitted <> new_book::text) THEN
    RAISE EXCEPTION 'PROSER_DOCUMENT_ADMISSION_REQUIRED: % mutation requires scoped document transaction', TG_TABLE_NAME USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROSER_DOCUMENT_TOMBSTONE_REQUIRED: % identities must be retained', TG_TABLE_NAME USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP FUNCTION IF EXISTS proser_document_check_scene(integer);
CREATE OR REPLACE FUNCTION proser_document_check_scene(scene_key integer, expected_book integer DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE scene_row scenes%ROWTYPE; book_key integer; reference jsonb; body jsonb; expected text; head_row book_document_heads%ROWTYPE;
BEGIN
  SELECT * INTO scene_row FROM scenes WHERE id=scene_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSER_DOCUMENT_SCENE_MISSING' USING ERRCODE='23514'; END IF;
  SELECT a.book_id INTO book_key FROM chapters c JOIN acts a ON a.id=c.act_id WHERE c.id=scene_row.chapter_id;
  IF expected_book IS NOT NULL AND book_key IS DISTINCT FROM expected_book THEN RAISE EXCEPTION 'PROSER_DOCUMENT_SCENE_OWNERSHIP_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT * INTO head_row FROM book_document_heads WHERE book_id=book_key;
  SELECT value INTO reference FROM jsonb_array_elements(coalesce(head_row.manifest->'scenes','[]') || coalesce(head_row.manifest->'retiredScenes','[]')) WHERE (value->>'sceneId')::integer=scene_key;
  SELECT document INTO body FROM scene_document_revisions WHERE id=reference->>'revisionId' AND scene_id=scene_key AND book_id=book_key AND content_hash=reference->>'contentHash';
  expected := proser_document_projection(body);
  IF NOT EXISTS (SELECT 1 FROM scene_document_search_indexes i WHERE i.scene_revision_id=reference->>'revisionId' AND i.book_id=book_key AND i.scene_id=scene_key AND i.content_hash=reference->>'contentHash' AND i.word_count=(reference->>'wordCount')::integer AND i.normalization='unicode-16.0.0-nfc-full-casefold-v1' AND i.payload->>'text'=expected) THEN
    RAISE EXCEPTION 'PROSER_DOCUMENT_SEARCH_INDEX_MISMATCH: scene %',scene_key USING ERRCODE='23514';
  END IF;
  IF reference IS NULL OR body IS NULL OR coalesce(scene_row.prose,'') IS DISTINCT FROM expected OR scene_row.word_count IS DISTINCT FROM proser_document_word_count(expected)
    OR scene_row.word_count IS DISTINCT FROM (reference->>'wordCount')::integer OR scene_row.chapter_id IS DISTINCT FROM (reference->>'chapterId')::integer OR scene_row.scene_number IS DISTINCT FROM (reference->>'sceneNumber')::integer
    OR scene_row.deleted_at IS DISTINCT FROM ((reference->>'deletedAt')::timestamptz AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'PROSER_DOCUMENT_PROJECTION_MISMATCH: scene %',scene_key USING ERRCODE='23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION proser_document_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE book_key integer; head_row book_document_heads%ROWTYPE; reference jsonb; body_manifest jsonb; previous_refs jsonb := '[]'; current_refs jsonb;
BEGIN
  IF NOT (SELECT enabled FROM proser_document_enforcement WHERE singleton) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='scenes' THEN PERFORM proser_document_check_scene(NEW.id); RETURN NEW; END IF;
  book_key := CASE WHEN TG_TABLE_NAME='books' THEN (to_jsonb(NEW)->>'id')::integer ELSE (to_jsonb(NEW)->>'book_id')::integer END;
  SELECT * INTO head_row FROM book_document_heads WHERE book_id=book_key;
  SELECT manifest INTO body_manifest FROM book_document_revisions WHERE id=head_row.revision_id AND book_id=book_key;
  IF head_row.revision_id IS NULL OR body_manifest IS NULL OR body_manifest IS DISTINCT FROM head_row.manifest THEN RAISE EXCEPTION 'PROSER_DOCUMENT_HEAD_MISMATCH' USING ERRCODE='23514'; END IF;
  current_refs := coalesce(head_row.manifest->'scenes','[]') || coalesce(head_row.manifest->'retiredScenes','[]');
  IF TG_TABLE_NAME='book_document_heads' AND TG_OP='UPDATE' THEN previous_refs := coalesce(OLD.manifest->'scenes','[]') || coalesce(OLD.manifest->'retiredScenes','[]'); END IF;
  IF TG_TABLE_NAME='books' AND TG_OP='UPDATE' THEN previous_refs := current_refs; END IF;
  -- Compare lightweight references. Do not reload unchanged manuscript bodies
  -- on every one-scene save. Removed references must still reconcile tombstones.
  FOR reference IN SELECT value FROM (
    (SELECT value FROM jsonb_array_elements(current_refs) EXCEPT SELECT value FROM jsonb_array_elements(previous_refs))
    UNION
    (SELECT value FROM jsonb_array_elements(previous_refs) EXCEPT SELECT value FROM jsonb_array_elements(current_refs))
  ) changed LOOP
    PERFORM proser_document_check_scene((reference->>'sceneId')::integer,book_key);
  END LOOP;
  RETURN NEW;
END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['books','acts','chapters','scenes','codex_entries','scene_codex_usage','book_document_heads'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS proser_document_admission ON %I',table_name);
    EXECUTE format('CREATE TRIGGER proser_document_admission BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proser_document_guard()',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['release_fence_receipts','release_mutation_admissions','release_admission_bindings','scene_document_search_indexes','scene_document_revisions','book_document_revisions','book_document_scope_revisions','document_legacy_revision_mappings','document_operations','document_originals','document_import_originals','document_import_previews','document_publication_artifacts','document_proposal_validations','document_story_discussions','document_story_proposal_validations','document_compare_validations','manuscript_revisions','audit_log'] LOOP
    IF to_regclass(table_name) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS proser_document_immutable ON %I',table_name);
    EXECUTE format('CREATE TRIGGER proser_document_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proser_document_guard(''immutable'')',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['books','scenes','book_document_heads'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS proser_document_consistent ON %I',table_name);
    EXECUTE format('CREATE CONSTRAINT TRIGGER proser_document_consistent AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION proser_document_consistency()',table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION proser_document_asset_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE referenced boolean; old_config jsonb; new_config jsonb;
BEGIN
 IF NOT (SELECT enabled FROM proser_document_enforcement WHERE singleton) THEN RETURN coalesce(NEW,OLD); END IF;
 SELECT EXISTS(SELECT 1 FROM scene_document_revisions WHERE (book_id=OLD.book_id OR OLD.book_id IS NULL) AND jsonb_path_exists(document,'$.** ? (@.assetId == $id)',jsonb_build_object('id',OLD.id)))
   OR EXISTS(SELECT 1 FROM book_document_scope_revisions WHERE (book_id=OLD.book_id OR OLD.book_id IS NULL) AND kind IN ('layout','structure') AND (jsonb_path_exists(content,'$.** ? (@.assetId == $id)',jsonb_build_object('id',OLD.id)) OR jsonb_path_exists(content,'$.** ? (@.selectedImageId == $id)',jsonb_build_object('id',OLD.id))))
   OR EXISTS(SELECT 1 FROM books WHERE selected_image_id=OLD.id) OR EXISTS(SELECT 1 FROM acts WHERE selected_image_id=OLD.id) OR EXISTS(SELECT 1 FROM chapters WHERE selected_image_id=OLD.id) OR EXISTS(SELECT 1 FROM scenes WHERE selected_image_id=OLD.id) INTO referenced;
 IF TG_OP='DELETE' THEN
   IF referenced THEN RAISE EXCEPTION 'PROSER_DOCUMENT_ASSET_REFERENCED' USING ERRCODE='23514'; END IF;
   RETURN OLD;
 END IF;
 BEGIN old_config:=coalesce(OLD.config_json,'{}')::jsonb; new_config:=coalesce(NEW.config_json,'{}')::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN IF referenced THEN RAISE EXCEPTION 'PROSER_DOCUMENT_ASSET_METADATA_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW; END;
 IF (referenced OR old_config ? 'sha256') AND (OLD.url IS DISTINCT FROM NEW.url OR OLD.name IS DISTINCT FROM NEW.name OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.book_id IS DISTINCT FROM NEW.book_id OR old_config->>'sha256' IS DISTINCT FROM new_config->>'sha256' OR old_config->>'mediaType' IS DISTINCT FROM new_config->>'mediaType' OR old_config->>'byteLength' IS DISTINCT FROM new_config->>'byteLength' OR old_config->>'width' IS DISTINCT FROM new_config->>'width' OR old_config->>'height' IS DISTINCT FROM new_config->>'height') THEN
   RAISE EXCEPTION 'PROSER_DOCUMENT_ASSET_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proser_document_asset_immutable ON images;
CREATE TRIGGER proser_document_asset_immutable BEFORE UPDATE OR DELETE ON images FOR EACH ROW EXECUTE FUNCTION proser_document_asset_guard();
-- Status transitions remain mutable; the admitted provider request and any
-- known output are immutable evidence even after owner cancellation.
CREATE OR REPLACE FUNCTION proser_document_effect_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT (SELECT enabled FROM proser_document_enforcement WHERE singleton) THEN RETURN coalesce(NEW,OLD); END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROSER_DOCUMENT_EFFECT_EVIDENCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(OLD)-ARRAY['status','result','error_code','started_at','completed_at','updated_at','lease_owner']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','result','error_code','started_at','completed_at','updated_at','lease_owner'])
   OR (OLD.result IS NOT NULL AND OLD.result IS DISTINCT FROM NEW.result) THEN
   RAISE EXCEPTION 'PROSER_DOCUMENT_EFFECT_EVIDENCE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['document_operator_effects','document_workflow_effects','document_inference_operations'] LOOP
  IF to_regclass(table_name) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS proser_document_effect_evidence ON %I',table_name);
  EXECUTE format('CREATE TRIGGER proser_document_effect_evidence BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proser_document_effect_evidence_guard()',table_name);
 END LOOP;
END $$;


-- Release fence edits require the candidate-bound local operator transaction.
-- This trigger is separately reviewed enforcement, never additive-classified.
CREATE OR REPLACE FUNCTION proser_release_fence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'UPDATE' OR coalesce(current_setting('proser.release_operator',true),'') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'PROSER_RELEASE_OPERATOR_REQUIRED: use exact reviewed release transition receipt' USING ERRCODE='23514';
 END IF;
 IF NEW.id<>OLD.id OR NEW.generation<>OLD.generation+1 OR NEW.phase NOT IN ('open','fenced') OR NEW.phase=OLD.phase OR NEW.proof_sha<>current_setting('proser.release_operator',true) THEN
  RAISE EXCEPTION 'PROSER_RELEASE_TRANSITION_INVALID: scope/generation/proof changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proser_release_fence_operator ON release_admission_fence;
CREATE TRIGGER proser_release_fence_operator BEFORE UPDATE OR DELETE ON release_admission_fence FOR EACH ROW EXECUTE FUNCTION proser_release_fence_guard();
-- Release evidence must remain immutable even during compatibility mode, when
-- manuscript-authority enforcement has not yet been activated.
CREATE OR REPLACE FUNCTION proser_release_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'PROSER_RELEASE_IMMUTABLE: % release evidence cannot change',TG_TABLE_NAME USING ERRCODE='23514';
END $$;
DO $$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['release_fence_receipts','release_mutation_admissions','release_admission_bindings'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS proser_release_immutable ON %I',table_name);
  EXECUTE format('CREATE TRIGGER proser_release_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proser_release_evidence_guard()',table_name);
 END LOOP;
END $$;


-- Ancillary discussion/proposal requests are immutable owned evidence. Status
-- recovery and the first validated output enrichment are separate transitions.
CREATE OR REPLACE FUNCTION proser_document_story_proposal_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_json jsonb; after_json jsonb;
BEGIN
 IF NOT (SELECT enabled FROM proser_document_enforcement WHERE singleton) THEN RETURN coalesce(NEW,OLD); END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROSER_DOCUMENT_STORY_PROPOSAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 before_json:=to_jsonb(OLD);after_json:=to_jsonb(NEW);
 IF (before_json-ARRAY['status','result','error_code','application_operation_id','started_at','completed_at','updated_at']) IS DISTINCT FROM (after_json-ARRAY['status','result','error_code','application_operation_id','started_at','completed_at','updated_at'])
  OR (OLD.application_operation_id IS NOT NULL AND OLD.application_operation_id IS DISTINCT FROM NEW.application_operation_id) THEN
  RAISE EXCEPTION 'PROSER_DOCUMENT_STORY_PROPOSAL_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF OLD.result IS NOT NULL AND OLD.result IS DISTINCT FROM NEW.result THEN
  -- Preserve the complete acknowledged response. The parser may add output once;
  -- it may not replace a known response, erase it or rewrite an existing output.
  IF jsonb_typeof(OLD.result)<>'object' OR jsonb_typeof(NEW.result)<>'object'
   OR OLD.result ? 'output' OR NOT NEW.result ? 'output'
   OR OLD.result IS DISTINCT FROM (NEW.result-'output') THEN
   RAISE EXCEPTION 'PROSER_DOCUMENT_STORY_PROPOSAL_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proser_document_story_proposal_evidence ON document_story_proposals;
CREATE TRIGGER proser_document_story_proposal_evidence BEFORE UPDATE OR DELETE ON document_story_proposals FOR EACH ROW EXECUTE FUNCTION proser_document_story_proposal_guard();
