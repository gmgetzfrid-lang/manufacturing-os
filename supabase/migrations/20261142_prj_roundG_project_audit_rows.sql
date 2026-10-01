-- 20261142_prj_roundG_project_audit_rows.sql
--
-- projects Round G — J11 PROJECTS RESIDUALS, migration B (projects-tab
-- SEC-20): an audit row about a private project is readable only by those
-- who can read the project — and by the audit roles.
--
-- WHY: SEC-2 (20261102) made the controls and cost TABLES follow
-- project_visible_to_me; their audit rows did not move with them. Every
-- audit_logs row is readable by any active member of its org (the base
-- policy audit_logs_org_access, schema.sql), and the one RESTRICTIVE overlay,
-- audit_logs_admin_trail (20261045, re-created by 20261063 — its NEWEST
-- definition), narrows only the org-level authority trail. The controls
-- program writes its decisions there WITH their content — COST_DOC_AWARDED
-- (vendor, total), CHANGE_ORDER_* (number, amount, reason), TURNOVER_REVIEWED
-- (item, note), CHECKLIST_ITEM_UPDATED (the ruling) — so a member who is not
-- on a private project read its award amounts with one PostgREST query.
--
-- WHAT:
--   1. audit_row_project_visible(p_type text, p_resource text) — SECURITY
--      INVOKER (it reads only what the caller may read), with NO SET clause
--      and every name schema-qualified (a SET clause would cost a GUC save
--      and restore on every row the policy tests):
--        * 'project' rows (resource_id = the project id): project_visible_to_me;
--        * 'cost' rows (resource_id = a cost_documents / cost_entries /
--          cost_accounts / project_parties id — every 'cost' writer, see
--          lib/timeline.ts PROJECT_EVENT_VOCABULARY): the row's project is
--          visible to the caller (and the cost row itself readable — the
--          SEC-2 policies are project_visible_to_me too);
--        * 'project_checklist' / 'turnover_item' rows — the quality
--          sign-off's e-signature rows (ESIGNATURE_CAPTURED, written by
--          /api/signatures/sign with lib/checklists.ts
--          QUALITY_SIGNOFF_RESOURCE: the signer and the statement about a
--          checklist or a turnover item): that row's project is visible;
--        * an id that is not a UUID, a project that no longer exists, a cost
--          / checklist / turnover row that is gone: NOT visible (the audit
--          roles still read it — the intent for PROJECT_DELETED and
--          PURGE_PROJECT_SNAPSHOT);
--        * any other resource type: TRUE (this rule is about project rows only).
--      EXECUTE: anon, authenticated, service_role — it is evaluated inside a
--      policy that applies to every role, and an invoker function holds no
--      privilege of its own (PUBLIC revoked, the three named).
--   2. audit_logs_admin_trail is re-created from its NEWEST definition
--      (20261063) byte for byte, with ONE added clause (and its comment):
--        AND (COALESCE(resource_type, '') NOT IN (<the four project types>)
--             OR audit_row_project_visible(resource_type, resource_id))
--      — the type test is inline, so a row of any other type never calls
--      the function (the /activity feed, the dashboard's audit count).
--      SQL binds AND tighter than OR, so the policy reads
--        audit viewer  OR  (NOT org-level trail  AND  project-visible)
--      — the audit roles (admin.audit_view through the policy evaluator,
--      unchanged) still read every row; everyone else reads a project /
--      cost / quality sign-off row only when they can see the project.
--      RESTRICTIVE, so it ANDs with the base member policy; the INSERT
--      policy is untouched.
--   HANDOFF: admin-and-org P7 owns audit-log integrity (append-only, the
--   trail's own rails) and builds on this definition — the lineDiff test in
--   lib/__tests__/prjRoundGJ11Migrations.test.ts pins it against 20261063.
--
-- NOT a widening: it narrows who reads project / cost audit rows. The
-- DEC-30 inventory (aggregate counts only, never rows) is captured BEFORE the
-- transaction and returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
-- Requires 20261063 (the admin.audit_view overlay) and 20261102 (SEC-2).

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j11b_inventory;
CREATE TEMP TABLE prj_g_j11b_inventory AS
SELECT 'inventory: audit rows about a project or a cost record' AS inventory, COUNT(*)::text AS n
  FROM audit_logs WHERE resource_type IN ('project', 'cost')
UNION ALL
SELECT 'inventory: …project rows about a PRIVATE project (now readable only by those who can see it, and the audit roles)', COUNT(*)::text
  FROM audit_logs a
  JOIN projects p ON p.id::text = a.resource_id
 WHERE a.resource_type = 'project' AND p.visibility = 'private'
UNION ALL
SELECT 'inventory: …project rows whose project no longer exists (now readable only by the audit roles)', COUNT(*)::text
  FROM audit_logs a
 WHERE a.resource_type = 'project'
   AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id::text = a.resource_id)
UNION ALL
SELECT 'inventory: …cost rows whose cost record no longer exists (now readable only by the audit roles)', COUNT(*)::text
  FROM audit_logs a
 WHERE a.resource_type = 'cost'
   AND NOT EXISTS (SELECT 1 FROM cost_documents c WHERE c.id::text = a.resource_id)
   AND NOT EXISTS (SELECT 1 FROM cost_entries c WHERE c.id::text = a.resource_id)
   AND NOT EXISTS (SELECT 1 FROM cost_accounts c WHERE c.id::text = a.resource_id)
   AND NOT EXISTS (SELECT 1 FROM project_parties c WHERE c.id::text = a.resource_id)
UNION ALL
SELECT 'inventory: e-signature rows on a project checklist or turnover item (now follow that project)', COUNT(*)::text
  FROM audit_logs WHERE resource_type IN ('project_checklist', 'turnover_item')
UNION ALL
SELECT 'inventory: active members who read every row through admin.audit_view (unchanged)', COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active' AND org_capability_allows_for(m.org_id, 'admin.audit_view', m.uid, '{}'::jsonb);

BEGIN;

-- ── 1. the project-visibility test an audit row is read through ──────────
CREATE OR REPLACE FUNCTION public.audit_row_project_visible(p_type text, p_resource text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_type IS NULL OR p_type NOT IN ('project', 'cost', 'project_checklist', 'turnover_item') THEN true
    WHEN p_resource IS NULL
      OR p_resource !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
    WHEN p_type = 'project' THEN public.project_visible_to_me(p_resource::uuid)
    WHEN p_type = 'project_checklist' THEN
      EXISTS (SELECT 1 FROM public.project_checklists c WHERE c.id = p_resource::uuid AND public.project_visible_to_me(c.project_id))
    WHEN p_type = 'turnover_item' THEN
      EXISTS (SELECT 1 FROM public.turnover_items c WHERE c.id = p_resource::uuid AND public.project_visible_to_me(c.project_id))
    ELSE EXISTS (SELECT 1 FROM public.cost_documents c WHERE c.id = p_resource::uuid AND public.project_visible_to_me(c.project_id))
      OR EXISTS (SELECT 1 FROM public.cost_entries c WHERE c.id = p_resource::uuid AND public.project_visible_to_me(c.project_id))
      OR EXISTS (SELECT 1 FROM public.cost_accounts c WHERE c.id = p_resource::uuid AND public.project_visible_to_me(c.project_id))
      OR EXISTS (SELECT 1 FROM public.project_parties c WHERE c.id = p_resource::uuid AND public.project_visible_to_me(c.project_id))
  END;
$$;

COMMENT ON FUNCTION public.audit_row_project_visible(text, text) IS
  'SEC-20: may the caller read an audit row of this resource type and id as a project row? project → project_visible_to_me(id); cost → the cost row''s project (documents, entries, accounts, parties); project_checklist / turnover_item (the quality sign-off''s e-signature rows) → that row''s project; a non-UUID id, a gone project or row → false; any other type → true. SECURITY INVOKER, no SET clause, names schema-qualified.';

REVOKE ALL ON FUNCTION public.audit_row_project_visible(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_row_project_visible(text, text) TO anon, authenticated, service_role;

-- ── 2. the audit trail overlay: 20261063's body + the project clause ─────
DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    org_capability_allows(org_id, 'admin.audit_view', auth.uid())
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
    -- SEC-20 (20261142): a row about a project, a cost record or a quality
    -- sign-off is the project's — readable when the caller can see the
    -- project. AND binds tighter than OR: an audit viewer reads every row;
    -- anyone else reads a row that is not the org-level trail AND whose
    -- project they can see. The type test is inline: a row of any other
    -- type never calls the function.
    AND (COALESCE(resource_type, '') NOT IN ('project', 'cost', 'project_checklist', 'turnover_item')
         OR audit_row_project_visible(resource_type, resource_id))
  );

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_policies.qual is DEPARSED; pg_proc.prosrc is verbatim.
SELECT 'audit_logs_admin_trail is RESTRICTIVE SELECT, still reads admin.audit_view through the policy evaluator and keeps the org-level trail predicate' AS check,
       (SELECT permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
               AND qual LIKE '%org_capability_allows(org_id, ''admin.audit_view''%'
               AND qual LIKE '%capability_policy%' AND qual LIKE '%export_destination%'
               AND qual LIKE '%CAPABILITY_%' AND qual LIKE '%RESTORE_%' AND qual LIKE '%PURGE_%'
          FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the overlay gates project / cost / quality sign-off rows on audit_row_project_visible(resource_type, resource_id), the type test inline',
       (SELECT qual LIKE '%audit_row_project_visible(resource_type, resource_id)%'
               AND qual LIKE '%project_checklist%' AND qual LIKE '%turnover_item%'
          FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'),
       NULL::text
UNION ALL
SELECT 'the base member policy and the insert policy are untouched (one permissive SELECT, one INSERT)',
       (SELECT COUNT(*) FILTER (WHERE permissive = 'PERMISSIVE' AND cmd = 'SELECT') = 1
               AND COUNT(*) FILTER (WHERE cmd = 'INSERT') = 1
               AND COUNT(*) FILTER (WHERE permissive = 'RESTRICTIVE') = 1
          FROM pg_policies WHERE tablename = 'audit_logs'),
       NULL::text
UNION ALL
SELECT 'audit_row_project_visible is SECURITY INVOKER with no SET clause (no per-row GUC save / restore), its names schema-qualified, and every role that reads audit_logs may execute it',
       (SELECT NOT prosecdef AND proconfig IS NULL
               AND prosrc LIKE '%public.project_visible_to_me(c.project_id)%' AND prosrc LIKE '%public.turnover_items c%'
          FROM pg_proc WHERE proname = 'audit_row_project_visible' AND pronargs = 2)
       AND has_function_privilege('anon', 'audit_row_project_visible(text,text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'audit_row_project_visible(text,text)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'the test answers: another type → visible; a non-UUID or unknown project / cost id → not (no session here, so no project is visible)',
       audit_row_project_visible('document', 'x')
       AND audit_row_project_visible(NULL, NULL)
       AND NOT audit_row_project_visible('project', 'not-a-uuid')
       AND NOT audit_row_project_visible('project', '00000000-0000-0000-0000-000000000000')
       AND NOT audit_row_project_visible('cost', '00000000-0000-0000-0000-000000000000')
       AND NOT audit_row_project_visible('project_checklist', '00000000-0000-0000-0000-000000000000')
       AND NOT audit_row_project_visible('turnover_item', '00000000-0000-0000-0000-000000000000'),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j11b_inventory;
