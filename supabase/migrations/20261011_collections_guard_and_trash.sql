-- 20261011_collections_guard_and_trash.sql
--
-- 1. ENFORCEMENT — "reorganizing is Admin/DocCtrl only", at the database.
--    collections had NO restrictive INSERT/UPDATE policy: any active member
--    could create/rename/re-parent/reorder folders via raw PostgREST even
--    though the UI gates every one of those acts to controllers. These
--    policies make the DB match the product rule. (DELETE was already
--    restricted by 20260815; the server routes run on the service role and
--    are unaffected.)
--
-- 2. Document move guard: changing a document's folder (collection_id) is a
--    reorganizing act too. The app moves docs through /api/documents/move
--    (service role, controller-checked); this trigger closes the raw
--    client-side UPDATE path for non-controllers without touching metadata
--    edits or any other column.
--
-- 3. FOLDER TRASH — deleting a folder now HOLDS it for 30 days instead of
--    destroying the row. Contents still step up immediately (unchanged
--    contract); the emptied folder shell gets deleted_at and disappears
--    from every listing, restorable by controllers from "Recently deleted",
--    purged for real by the maintenance cron after 30 days.

-- ── 1. Controller-only folder writes ────────────────────────────────────

DROP POLICY IF EXISTS collections_insert_controllers ON collections;
CREATE POLICY collections_insert_controllers ON collections
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (is_org_controller(org_id));

DROP POLICY IF EXISTS collections_update_controllers ON collections;
CREATE POLICY collections_update_controllers ON collections
  AS RESTRICTIVE FOR UPDATE
  USING (is_org_controller(org_id))
  WITH CHECK (is_org_controller(org_id));

-- ── 2. Document move guard ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION enforce_document_move_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id THEN
    -- Server routes (service role) and direct SQL (no JWT) pass — they carry
    -- their own controller checks. Everyone else must be Admin/DocCtrl.
    IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;
    IF NOT is_org_controller(OLD.org_id) THEN
      RAISE EXCEPTION 'Moving documents between folders requires Admin or Document Control.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_move_guard ON documents;
CREATE TRIGGER trg_documents_move_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_document_move_guard();

-- ── 3. Folder trash (30-day delete hold) ────────────────────────────────

ALTER TABLE collections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS deleted_by UUID DEFAULT NULL;

COMMENT ON COLUMN collections.deleted_at IS
  'Soft-delete: folder held in trash, hidden from all listings, restorable by controllers. Purged by the maintenance cron 30 days after this timestamp.';

CREATE INDEX IF NOT EXISTS collections_deleted_idx
  ON collections (org_id, deleted_at) WHERE deleted_at IS NOT NULL;
