-- Document ownership — Phase 2: access grant ────────────────────────────────
-- The effective owner of a document (its own owner, else its folder's, else its
-- library's) may publish revisions of that document even without per-library
-- publish authority. Dated AFTER 20260812 so this guard definition is the final
-- one (20260812 also (re)creates enforce_document_publish_guard()).

-- Resolve-and-check: is p_uid the effective owner? Document owner wins; else the
-- folder's; else the library's. Mirrors lib/ownership.ts resolveEffectiveOwner.
CREATE OR REPLACE FUNCTION user_is_effective_owner(p_doc_owner uuid, p_collection uuid, p_library uuid, p_uid uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;
  IF p_doc_owner IS NOT NULL THEN
    RETURN p_doc_owner = p_uid;                       -- an explicit doc owner is authoritative
  END IF;
  IF p_collection IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner FROM collections WHERE id = p_collection;
    IF v_owner IS NOT NULL THEN RETURN v_owner = p_uid; END IF;
  END IF;
  IF p_library IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner FROM libraries WHERE id = p_library;
    IF v_owner IS NOT NULL THEN RETURN v_owner = p_uid; END IF;
  END IF;
  RETURN false;
END;
$$;

-- Recreate the publish guard: identical to 20260812 except an effective owner is
-- now also allowed to advance (publish) their own document.
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor       uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_role        text;
  v_advancing   boolean;
  v_can_publish boolean;
  v_has_hold    boolean;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded');
  IF NOT v_advancing THEN
    RETURN NEW;
  END IF;

  SELECT role INTO v_role
    FROM org_members
   WHERE org_id = NEW.org_id AND uid::text = v_actor::text AND status = 'active'
   LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
    RETURN NEW;
  END IF;

  -- Per-library publish authority OR the document's effective owner may publish.
  v_can_publish := user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)
                OR user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor);

  IF NOT v_can_publish THEN
    RAISE EXCEPTION
      'You do not have authority to publish revisions in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM document_holds h
     WHERE h.document_id = NEW.id AND h.released_at IS NULL
  ) INTO v_has_hold;
  IF v_has_hold THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before publishing a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_publish_guard ON documents;
CREATE TRIGGER trg_document_publish_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_document_publish_guard();
