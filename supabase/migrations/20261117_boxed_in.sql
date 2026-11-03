-- Changing, undoing and correcting what was entered: the database side.
--
-- Most of the "no way back" fixes are app-only (Undo award, void an
-- approved change order, Reopen a project, correct a read quote, move an
-- invoice to the right line, reopen a checklist or a turnover item, extend
-- an intake link, Undo after Clear schedule / Reset progress). These three
-- need the database:
--
-- 1. The punch list is the crew's: editors on the project and org
--    Supervisors / Managers write it, not only the owner and controllers.
--    punch_items_write now uses can_edit_project() - the owner, a co-owner
--    or editor, or an org Admin, Manager, Supervisor or Document Control
--    (20261114). The function is created here only if it isn't there yet.
-- 2. Punch items get where they are (location) and who's on them
--    (assignee), beside the contractor (party_id) they already had.
-- 3. A cost entry keeps the quote or invoice it was posted from
--    (cost_entries.source_document_id, already in most databases), so an
--    award can be undone and a posted invoice moved by exactly its entry.
--    Older entries without the link are found by what the posting wrote.
--
-- Safe to run more than once. Changes no existing data.

-- 1. Who may change a project's work: created only if missing (the same
--    as 20261114 / 20261115), never replaced.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_edit_project'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION can_edit_project(p_project uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $body$
        SELECT EXISTS (
          SELECT 1 FROM projects p WHERE p.id = p_project AND (
            p.owner_user_id::text = auth.uid()::text
            OR EXISTS (SELECT 1 FROM org_members om
                       WHERE om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'
                         AND (om.role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl')
                              OR om.roles && ARRAY['Admin', 'Manager', 'Supervisor', 'DocCtrl']::text[]))
            OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = p.id AND pm.user_id::text = auth.uid()::text
                         AND pm.role IN ('owner', 'co_owner', 'collaborator'))
          )
        );
      $body$
    $fn$;
    EXECUTE 'GRANT EXECUTE ON FUNCTION can_edit_project(uuid) TO authenticated';
  END IF;
END
$do$;

-- The punch list: org controllers as before, plus everyone who may change
-- the project's work.
DROP POLICY IF EXISTS punch_items_write ON punch_items;
CREATE POLICY punch_items_write ON punch_items FOR ALL
  USING (is_org_controller(org_id) OR can_edit_project(project_id))
  WITH CHECK (is_org_controller(org_id) OR can_edit_project(project_id));

-- 2. Where it is, and who's on it.
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS assignee TEXT;
COMMENT ON COLUMN punch_items.location IS 'Where the snag is, as the crew says it: "E-301 north nozzle".';
COMMENT ON COLUMN punch_items.assignee IS 'Who is on it (a name, free text).';

-- 3. The paper a cost entry came from.
ALTER TABLE cost_entries ADD COLUMN IF NOT EXISTS source_document_id UUID;
DO $$ BEGIN
  ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_source_document_fk
    FOREIGN KEY (source_document_id) REFERENCES cost_documents(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN others THEN RAISE NOTICE 'cost_entries source FK skipped: %', SQLERRM; END $$;
CREATE INDEX IF NOT EXISTS cost_entries_source_document_idx ON cost_entries(source_document_id);
COMMENT ON COLUMN cost_entries.source_document_id IS 'The quote (award) or invoice (posting) this entry was posted from; Undo award and Move to line void exactly this entry.';

NOTIFY pgrst, 'reload schema';
