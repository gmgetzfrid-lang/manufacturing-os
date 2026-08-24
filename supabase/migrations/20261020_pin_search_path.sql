-- ─────────────────────────────────────────────────────────────────────────────
-- DB-6: pin search_path on every SECURITY DEFINER function that lacks it.
--
-- A SECURITY DEFINER function without SET search_path resolves unqualified
-- table references against the CALLER's search_path — a caller who can create
-- objects in an earlier schema can shadow the tables the function reads. The
-- migration set already pins 19 functions (`SET search_path = public`, e.g.
-- 20260724_ticket_numbering.sql, 20260810_archive_invariants.sql,
-- 20260824_team_departments.sql); this migration brings the remaining
-- authority-bearing functions to the same bar.
--
-- Census (final definition per (name, arity), whole migration set + schema.sql,
-- 2026-08-24): 55 distinct functions, 39 SECURITY DEFINER, 18 unpinned after
-- 20261019_publish_revision_drop_dead_param.sql pinned publish_revision at
-- creation. The four historical definitions of enforce_document_publish_guard
-- resolve to 20260822_review_completion_guard.sql as the live one; ALTER (not
-- re-CREATE) is used throughout so whichever body is actually deployed keeps
-- running unchanged — this migration changes no behaviour.
--
-- Two legacy publish_revision signatures are included defensively for
-- databases where 20260828 / 20261019 have not been applied yet; the
-- to_regprocedure() guard makes every entry a no-op when the signature does
-- not exist, so this script is idempotent and safe under hand-applied,
-- partially-applied deployments (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  sig TEXT;
  sigs TEXT[] := ARRAY[
    -- membership / visibility primitives
    'my_org_ids()',
    'my_team_ids()',
    'my_project_ids()',
    'node_visible(text, jsonb, uuid)',
    'doc_is_visible(uuid)',
    -- role / controller predicates
    'is_org_admin(uuid)',
    'is_org_admin_or_manager(uuid)',
    'is_org_controller(uuid)',
    'is_org_assign_drafters(uuid)',
    -- node & project management
    'can_manage_node(jsonb, uuid)',
    'can_manage_project(uuid)',
    'documents_guard_access_change()',
    -- share + revision plumbing
    'bump_share_access(uuid)',
    'revup_rollback_orphan(uuid, uuid)',
    -- trigger guards (the publish guard is the 20260822 definition — the
    -- last of its four historical bodies, and the one the trigger binds)
    'enforce_document_publish_guard()',
    'enforce_legal_hold_delete_guard()',
    'enforce_legal_hold_version_delete_guard()',
    'enforce_document_move_guard()',
    -- legacy publish_revision shapes: v1 (20260823, 11 args) and v2
    -- (20260828, 12 args). The current shape created by 20261019 pins
    -- search_path at creation and needs no ALTER.
    'publish_revision(uuid, uuid, text, jsonb, uuid, text, text, boolean, boolean, text, text)',
    'publish_revision(uuid, uuid, text, jsonb, uuid, text, text, boolean, boolean, text, text, boolean)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', sig);
    END IF;
  END LOOP;
END $$;

-- Verification (run after applying): every SECURITY DEFINER function in the
-- app schema should now pin search_path — this returns the ones that do not.
-- Expect zero rows; a row here is either schema drift this repository does not
-- know about, or a new function added without a pin (the lint test
-- lib/__tests__/searchPathPin.test.ts guards the repository side).
SELECT p.oid::regprocedure AS still_unpinned
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c
    WHERE c LIKE 'search_path=%'
  );
