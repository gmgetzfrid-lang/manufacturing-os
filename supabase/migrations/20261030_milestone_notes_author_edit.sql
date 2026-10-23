-- 20261030_milestone_notes_author_edit.sql
--
-- A typed comment is its author's: only they can change or delete it.
-- (The app already hides Edit / Delete on someone else's comment; this
-- makes the database agree.) Members still read every note and add their
-- own; status / reschedule notes the app writes can still be cleared (a
-- progress reset drops a rehearsal's status notes).

DROP POLICY IF EXISTS "milestone_notes_member_all" ON milestone_notes;
DROP POLICY IF EXISTS milestone_notes_member_read ON milestone_notes;
DROP POLICY IF EXISTS milestone_notes_member_insert ON milestone_notes;
DROP POLICY IF EXISTS milestone_notes_author_update ON milestone_notes;
DROP POLICY IF EXISTS milestone_notes_author_delete ON milestone_notes;

CREATE POLICY milestone_notes_member_read ON milestone_notes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_notes.org_id AND uid = auth.uid() AND status = 'active'));

CREATE POLICY milestone_notes_member_insert ON milestone_notes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_notes.org_id AND uid = auth.uid() AND status = 'active'));

CREATE POLICY milestone_notes_author_update ON milestone_notes
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() AND EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_notes.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (created_by = auth.uid());

CREATE POLICY milestone_notes_author_delete ON milestone_notes
  FOR DELETE TO authenticated
  USING ((created_by = auth.uid() OR kind <> 'note') AND EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_notes.org_id AND uid = auth.uid() AND status = 'active'));
