-- ─────────────────────────────────────────────────────────────────────────────
-- 20261209_df_roundG_drafting_config_writes.sql
--
-- drafting-flow Round G — DF-P4 LIBRARY: AUTHZ-10. Who may write the
-- drafting request-form configuration (org_configurations key 'drafting').
--
-- Before: the editor's page (/admin/requests) admitted Admin and DocCtrl
-- (lib/adminSurfaces.ts), while the RESTRICTIVE per-key write policies
-- admitted is_org_assign_drafters — Admin, Manager, Supervisor,
-- DraftingSupervisor. A DocCtrl opened the editor and every save was refused
-- by the database; a DraftingSupervisor, whose job this configuration is,
-- was turned away by the page.
--
-- Ruled by the integrator under the user's delegation (DEC-90, industry best
-- practice, fail-safe — recorded on AUTHZ-10 and DEC-107): Admin,
-- DocCtrl and DraftingSupervisor edit it — the SAME set in
-- lib/adminSurfaces.ts (the requests surface's entry and writes) and in the
-- policy below, pinned equal by lib/__tests__/dfRoundG_P4_library.test.ts.
-- Manager and Supervisor (without one of the three) lose a database write
-- they could never reach through the app. Every other key is unchanged.
--
-- The three RESTRICTIVE policies are RE-CREATED FROM THEIR NEWEST BODY
-- (20261203, admin-and-org P8 — found by scanning; lineDiff-pinned): every
-- line kept except the 'drafting' branch, whose predicate becomes
-- caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor'])
-- (20261045: SECURITY DEFINER, search_path pinned, reads the full additive
-- collection — role OR roles). No function is created or changed here.
--
-- A widening for DocCtrl (and a narrowing for Manager / Supervisor), so the
-- inventory (counts only) is captured BEFORE the transaction (DEC-30).
-- PASTE / DEPLOY ORDER: after 20261203 (its first statement refuses
-- otherwise, changing nothing); either order with the DF-P4 deploy. Before
-- the paste the DF-P4 page opens for a DraftingSupervisor (whose save the old
-- policy already admits) and shows a DocCtrl the database's own refusal text
-- on save; after it, all three save. Never re-paste 20261203 or 20260818
-- after this file. Re-runnable (DROP POLICY IF EXISTS / CREATE POLICY).
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_configurations'
                  AND policyname = 'org_config_key_writes_upd' AND qual LIKE '%''timezone''%') THEN
    RAISE EXCEPTION '20261209 needs 20261203 (admin-and-org P8) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caller_holds_any_role') THEN
    RAISE EXCEPTION '20261209 needs caller_holds_any_role (20261045); nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_209_before;
CREATE TEMP TABLE df_round_g_209_before AS
SELECT 1 AS ord, 'inventory (before apply): workspaces with a drafting request-form configuration (org_configurations key drafting)' AS inventory,
       COUNT(*)::text AS n
  FROM org_configurations WHERE key = 'drafting'
UNION ALL
SELECT 2, 'inventory (before apply): AUTHZ-10 — active members who GAIN the drafting-config write (hold DocCtrl, hold none of Admin / Manager / Supervisor / DraftingSupervisor)',
       COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active'
   AND (m.role = 'DocCtrl' OR COALESCE(m.roles, '{}'::text[]) && ARRAY['DocCtrl']::text[])
   AND NOT (m.role IN ('Admin', 'Manager', 'Supervisor', 'DraftingSupervisor')
            OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor']::text[])
UNION ALL
SELECT 3, 'inventory (before apply): AUTHZ-10 — active members who LOSE the drafting-config write (hold Manager or Supervisor, hold none of Admin / DocCtrl / DraftingSupervisor; the app never let them reach the editor)',
       COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active'
   AND (m.role IN ('Manager', 'Supervisor') OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Manager', 'Supervisor']::text[])
   AND NOT (m.role IN ('Admin', 'DocCtrl', 'DraftingSupervisor')
            OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl', 'DraftingSupervisor']::text[]);

BEGIN;

-- The three RESTRICTIVE per-key policies from 20261203 (their newest
-- definition), each with one line changed: 'drafting' → Admin, DocCtrl,
-- DraftingSupervisor (by the full collection).
DROP POLICY IF EXISTS org_config_key_writes_ins ON org_configurations;
CREATE POLICY org_config_key_writes_ins ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_upd ON org_configurations;
CREATE POLICY org_config_key_writes_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END)
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_del ON org_configurations;
CREATE POLICY org_config_key_writes_del ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END);

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'AUTHZ-10: org_config_key_writes_ins / _upd / _del — drafting is Admin, DocCtrl, DraftingSupervisor; branding and timezone Admin; RESTRICTIVE' AS check,
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'org_configurations' AND permissive = 'RESTRICTIVE'
           AND policyname IN ('org_config_key_writes_ins', 'org_config_key_writes_upd', 'org_config_key_writes_del')
           AND COALESCE(qual, with_check) LIKE '%''drafting''%THEN caller_holds_any_role(org_id, ARRAY[''Admin''%''DocCtrl''%''DraftingSupervisor''%'
           AND COALESCE(qual, with_check) LIKE '%''branding''%THEN is_org_admin(org_id)%'
           AND COALESCE(qual, with_check) LIKE '%''timezone''%THEN is_org_admin(org_id)%'
           AND COALESCE(qual, with_check) NOT LIKE '%is_org_assign_drafters%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_configurations'
                      AND policyname = 'org_config_key_writes_upd'
                      AND with_check LIKE '%''drafting''%THEN caller_holds_any_role(org_id, ARRAY[''Admin''%''DocCtrl''%''DraftingSupervisor''%'
                      AND with_check NOT LIKE '%is_org_assign_drafters%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'caller_holds_any_role (20261045) is SECURITY DEFINER with search_path pinned',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caller_holds_any_role' AND prosecdef AND proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM df_round_g_209_before;
