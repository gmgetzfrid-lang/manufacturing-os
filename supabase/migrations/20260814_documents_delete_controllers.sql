-- 20260814_documents_delete_controllers.sql
--
-- Phase 2, step 1 (finding C2): enforce at the DATABASE that only document
-- controllers can DELETE a document. Until now the only guard was the UI —
-- the bulk-delete button is rendered only for controllers
-- (documents/[libraryId]/page.tsx, `{isController && …}`), but the delete
-- itself runs through the user's anon-key client against the permissive
-- `documents_org_access FOR ALL` policy, which checks org membership and
-- nothing else. So any active member (even a Viewer) could delete any
-- document by calling PostgREST directly with their own JWT.
--
-- Scope: DELETE only. INSERT/UPDATE are intentionally left alone — drafters
-- legitimately create and edit documents, SetManager reorders sheets, the
-- checkout flow updates collaborators, etc. Those need per-operation analysis
-- and come in later steps. Deletes are the clean case: the sole client-side
-- delete path is already controller-gated in the UI, and admin/purge/shed
-- routes delete via the service-role key (which bypasses RLS), so this policy
-- cannot break any legitimate workflow.
--
-- Mechanism: a RESTRICTIVE FOR DELETE policy ANDs with the existing permissive
-- org policy, so a delete must satisfy BOTH (active member AND controller) =
-- controller. Mirrors the branding-admin pattern from 20260713.
--
-- Rollback: DROP POLICY documents_delete_controllers ON documents;

-- Is the current user a document controller (Admin or DocCtrl) of the row's
-- org? Honors the additive role model (lib/roleCapabilities.ts): a member's
-- effective roles are the UNION of `role` (mirrored primary) and `roles[]`,
-- so someone holding DocCtrl as a secondary role still qualifies. SECURITY
-- DEFINER so it reads org_members without re-entering RLS (no recursion).
CREATE OR REPLACE FUNCTION is_org_controller(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = auth.uid()
      AND org_id = p_org
      AND status = 'active'
      AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
  );
$$;

DROP POLICY IF EXISTS documents_delete_controllers ON documents;
CREATE POLICY documents_delete_controllers ON documents
  AS RESTRICTIVE FOR DELETE
  USING (is_org_controller(org_id));
