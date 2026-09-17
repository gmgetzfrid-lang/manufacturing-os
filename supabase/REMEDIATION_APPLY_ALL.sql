-- ============================================================================
-- RETIRED — DO NOT RUN. (DB-8, roles-and-permissions Round E, 2026-09-17)
-- ============================================================================
-- This file was the consolidated "safe to RE-RUN" remediation bundle
-- (push_subscriptions, orphan-table RLS, ACL overlays, controller deletes,
-- org_members escalation guard) and re-created seven authority functions.
--
-- It was a SECOND SOURCE OF TRUTH: every statement was CREATE OR REPLACE /
-- DROP+CREATE, frozen on the day it was written, so a re-run after later
-- migrations silently restored the frozen bodies over the live hardening —
-- no error, no record. On the day of retirement it forked from the numbered
-- sequence at: doc_is_visible, my_project_ids,
-- is_org_controller, acl_subject_has_action, can_manage_node,
-- documents_guard_access_change, is_org_admin, is_org_admin_or_manager, and
-- twelve policies / one trigger — 20 of its 23 definitions.
--
-- The numbered files in supabase/migrations/ (NNNNNNNN_*.sql, applied in
-- order) are the ONLY source of truth. lib/__tests__/migrationSourceOfTruth
-- .test.ts fails the build if this file — or any file outside the numbered
-- sequence — defines a function, policy or trigger again.
--
-- Its content was applied live before 2026-08-24; every piece of it has
-- since been superseded by a numbered migration.
-- The original text remains in git history (4e37340 and earlier). This stub
-- is deliberately kept so a bookmark, runbook or habit that still points here
-- meets a loud refusal instead of a silent revert.
-- ============================================================================

DO $$
BEGIN
  RAISE EXCEPTION 'RETIRED (DB-8): this script is no longer a source of truth. Apply the numbered files in supabase/migrations/ in order instead.';
END $$;
