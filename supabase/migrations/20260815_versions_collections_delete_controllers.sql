-- 20260815_versions_collections_delete_controllers.sql
--
-- Phase 2, step 2 (finding C2, continued): gate DELETE on document_versions
-- and collections to document controllers, closing the raw-PostgREST delete
-- hole on both. Zero app impact: neither table has ANY client-side delete
-- path (verified by grep across lib/app/components/hooks) — the app only
-- deletes these via cascade or the service-role admin routes, both of which
-- bypass RLS. So this purely blocks a malicious member from deleting version
-- rows (which hold file_url) or folders directly through the API.
--
-- NOT included here (each needs its own per-table role analysis — they do
-- NOT map to the Admin/DocCtrl "controller" model):
--   * document_sets delete — SetManager UI path, drafter-facing
--   * milestones delete     — project-management roles (Manager/Supervisor)
--   * transmittals delete   — issuer roles, draft-only
--   * documents UPDATE (visibility/acl "unhide" vector) — needs analysis of
--     who may legitimately manage a document's ACL (owners? grant-holders?)
--     before locking, to avoid breaking legitimate access managers.
--
-- Relies on is_org_controller() from 20260814. Reversible via DROP POLICY.

DROP POLICY IF EXISTS document_versions_delete_controllers ON document_versions;
CREATE POLICY document_versions_delete_controllers ON document_versions
  AS RESTRICTIVE FOR DELETE
  USING (is_org_controller(org_id));

DROP POLICY IF EXISTS collections_delete_controllers ON collections;
CREATE POLICY collections_delete_controllers ON collections
  AS RESTRICTIVE FOR DELETE
  USING (is_org_controller(org_id));
