-- 20260630_scratchpad_private.sql
--
-- Privacy split for notes.
--
-- Before this migration, every note in an org was readable and
-- writable by every other active member of that org. That's correct
-- for notes ATTACHED TO a document / project / asset (the resource
-- itself is shared, so its notes should be too) but wrong for the
-- standalone "scratchpad" notes, which users reasonably expect to
-- be personal.
--
-- After this migration:
--   * A note with ANY of document_id / project_id / asset_id set
--     → "scoped"     → org-member visible (unchanged behavior)
--   * A note with NONE of those set
--     → "standalone" → ONLY created_by can read or write
--
-- Same single notes table, two policies. No data migration needed:
-- existing scoped notes keep their visibility; existing standalone
-- notes immediately become private to their author. If a user had
-- been reading someone else's standalone note before, they will
-- lose access — that's the intended behavior.

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- Replace the blanket policy with two scope-aware ones.
DROP POLICY IF EXISTS "notes_member_all"     ON notes;
DROP POLICY IF EXISTS "notes_scoped_member"  ON notes;
DROP POLICY IF EXISTS "notes_standalone_own" ON notes;

-- Scoped notes — every active org member can read + write.
CREATE POLICY "notes_scoped_member" ON notes
  FOR ALL TO authenticated
  USING (
    (notes.document_id IS NOT NULL
       OR notes.project_id IS NOT NULL
       OR notes.asset_id IS NOT NULL)
    AND EXISTS (
      SELECT 1 FROM org_members
      WHERE org_id = notes.org_id
        AND uid = auth.uid()
        AND status = 'active'
    )
  )
  WITH CHECK (
    (notes.document_id IS NOT NULL
       OR notes.project_id IS NOT NULL
       OR notes.asset_id IS NOT NULL)
    AND EXISTS (
      SELECT 1 FROM org_members
      WHERE org_id = notes.org_id
        AND uid = auth.uid()
        AND status = 'active'
    )
  );

-- Standalone notes — only the author. created_by is a UUID column
-- and auth.uid() returns UUID, so the comparison is type-clean.
CREATE POLICY "notes_standalone_own" ON notes
  FOR ALL TO authenticated
  USING (
    notes.document_id IS NULL
    AND notes.project_id IS NULL
    AND notes.asset_id  IS NULL
    AND notes.created_by = auth.uid()
  )
  WITH CHECK (
    notes.document_id IS NULL
    AND notes.project_id IS NULL
    AND notes.asset_id  IS NULL
    AND notes.created_by = auth.uid()
  );
