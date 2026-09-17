-- ============================================================================
-- RETIRED — DO NOT RUN. (DB-8, roles-and-permissions Round E, 2026-09-17)
-- ============================================================================
-- This file was the consolidated "safe to RE-RUN" remediation bundle
-- (push_subscriptions, orphan-table RLS, ACL overlays, controller deletes,
-- org_members escalation guard) and re-created eight authority functions.
--
-- It was a SECOND SOURCE OF TRUTH: every statement was CREATE OR REPLACE /
-- DROP+CREATE, frozen on the day it was written, so a re-run after later
-- migrations silently restored the frozen bodies over the live hardening —
-- no error, no record. On the day of retirement, compared definition by
-- definition against the live numbered sequence (comments stripped,
-- whitespace collapsed, case folded), 7 of its 23 definitions had forked:
-- doc_is_visible (live 20261037), can_manage_node (20261046),
-- documents_guard_access_change (20261044), is_org_admin (20261046), and the
-- policies projects_visibility_select (20260913), org_members_update and
-- org_members_write (20260817) — a re-run would have put can_manage_node and
-- is_org_admin back on headline-only bodies. The other 16 (is_org_controller,
-- my_project_ids, acl_subject_has_action, is_org_admin_or_manager, the
-- documents_guard_access trigger and eleven policies) still matched their
-- live definitions modulo case and whitespace: forks-in-waiting.
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
