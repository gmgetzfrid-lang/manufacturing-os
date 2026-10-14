-- ─────────────────────────────────────────────────────────────────────────────
-- 20261218_df_roundG_sla_defaults_rail_editor_writes.sql
--
-- drafting-flow Round G — DF-P13 SLA DEFAULTS RAIL AND EDITOR: EDGE-16 (and
-- EDGE-7 done-when 2's editor). Who may write sla_defaults, and what it may
-- hold.
--
-- Before: the table's ONLY policy is 20260605's sla_defaults_member_all —
-- FOR ALL TO authenticated, every active member, every verb (found by
-- scanning supabase/migrations and supabase/schema.sql: no other file
-- defines a policy on sla_defaults) — and default_days carries no CHECK.
-- Since Round G the table sets the due date of every request filed without a
-- requester date (/api/tickets/create, DF-P4) and the window the SLA clock
-- gives an open request with no target (lib/ticketSla.ts, DF-P3), so a Viewer
-- could set ISO to 1 day from the browser console and every new ISO request
-- was due tomorrow, with a warning and a breach notice to the queue for each.
--
-- After (ruled by the integrator under the user's delegation, DEC-90 —
-- industry best practice, fail-safe; the set is DEC-107 item 1's):
--   1. INSERT / UPDATE / DELETE need the caller to hold Admin, DocCtrl or
--      DraftingSupervisor by the full role collection —
--      caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor'])
--      (20261045: SECURITY DEFINER, search_path pinned, role OR roles, active
--      membership) — the SAME helper and spellings as 20261209's 'drafting'
--      branch and lib/adminSurfaces.ts DRAFTING_CONFIG_EDITORS, the set the
--      admin gate already holds the editor page (/admin/requests) to; pinned
--      equal by lib/__tests__/dfRoundG_P13_slaDefaults.test.ts.
--   2. SELECT is UNCHANGED. sla_defaults_member_all (its newest — and only —
--      definition, 20260605) is not touched: every active member still reads
--      the table, and the policy stays the membership half of every write.
--      The write verbs are narrowed by three RESTRICTIVE per-verb policies
--      (the house shape: 20261045's *_write_roles_*, 20261209's
--      org_config_key_writes_*), so a re-paste of 20260605 cannot reopen the
--      writes — a permissive policy re-created there is still ANDed with these.
--   3. default_days is bounded to 1–3650 whole days (INT, so whole by type;
--      3650 = lib/notifications.ts SLA_DEFAULT_DAYS_MAX, the create route's
--      bound) by sla_defaults_default_days_bounded. Two worlds (DEC-30): the
--      CHECK is added NOT VALID — every new INSERT / UPDATE is held to it —
--      and VALIDATEd only when no stored row is outside the bound; a stored
--      row outside it is KEPT and counted (never rewritten or deleted here):
--      the create route already ignores it (boundedSlaDays → the built-in
--      window), the editor flags it for correction, and a re-paste after the
--      correction validates the CHECK.
-- No function is created or changed here. warn_before_days is not read by
-- any code (the clock warns at lib/ticketSla.ts SLA_WARN_FRACTION, 75 %) and
-- is left as it is.
--
-- A NARROWING for every active member outside the editor set, so the
-- inventory (counts only — never a row) is captured BEFORE the transaction
-- (DEC-30).
--
-- THE APP WORKS BEFORE AND AFTER THE PASTE, IN EITHER ORDER WITH THE DF-P13
-- DEPLOY: no app path writes sla_defaults as a signed-in member except the
-- DF-P13 editor (/admin/requests), whose page the server gate already limits
-- to the same three roles; the create route and the SLA clock read it as the
-- service role (RLS does not judge them), and so does the restore. Pasted
-- first, the old app simply has no writer; deployed first, the editor's saves
-- land under the old member policy. After both, an editor's save lands and a
-- write outside the set is refused by the database, whose own refusal text
-- the editor shows.
-- PASTE ORDER: after 20261209 (recommended — the same editor set; not
-- required: this file needs only sla_defaults (20260529), its member policy
-- sla_defaults_member_all (20260605) and caller_holds_any_role (20261045);
-- the prerequisite block checks each of the three by name and refuses
-- without any of them, changing nothing). Never re-paste 20260605 to
-- "restore" sla_defaults: it is harmless after this file (point 2) but
-- restores nothing.
-- Re-runnable (DROP POLICY IF EXISTS / CREATE POLICY; the CHECK is added only
-- when missing and validated when it can be).
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.sla_defaults') IS NULL THEN
    RAISE EXCEPTION '20261218 needs sla_defaults (20260529); nothing was changed.';
  END IF;
  -- The RESTRICTIVE policies below only narrow: without the permissive
  -- member policy they would admit nobody, and RLS (still on) would refuse
  -- every member's read and write.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'sla_defaults'
                    AND policyname = 'sla_defaults_member_all') THEN
    RAISE EXCEPTION '20261218 needs sla_defaults_member_all (20260605); nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caller_holds_any_role') THEN
    RAISE EXCEPTION '20261218 needs caller_holds_any_role (20261045); nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_218_before;
CREATE TEMP TABLE df_round_g_218_before AS
WITH per_org AS (
  SELECT org_id, COUNT(*) AS rows_in_org FROM sla_defaults GROUP BY org_id
)
SELECT 1 AS ord, 'inventory (before apply): EDGE-16 — sla_defaults rows (all workspaces)' AS inventory,
       (SELECT COUNT(*) FROM sla_defaults)::text AS n
UNION ALL
SELECT 2, 'inventory (before apply): workspaces with exactly 1 sla_defaults row',
       (SELECT COUNT(*) FROM per_org WHERE rows_in_org = 1)::text
UNION ALL
SELECT 3, 'inventory (before apply): workspaces with 2–5 sla_defaults rows',
       (SELECT COUNT(*) FROM per_org WHERE rows_in_org BETWEEN 2 AND 5)::text
UNION ALL
SELECT 4, 'inventory (before apply): workspaces with 6 or more sla_defaults rows',
       (SELECT COUNT(*) FROM per_org WHERE rows_in_org >= 6)::text
UNION ALL
SELECT 5, 'inventory (before apply): EDGE-16 — sla_defaults rows whose default_days is outside 1–3650 (kept; the CHECK stays NOT VALID while any exist — correct them in Admin → Request forms, then re-paste)',
       (SELECT COUNT(*) FROM sla_defaults WHERE NOT (default_days BETWEEN 1 AND 3650))::text
UNION ALL
SELECT 6, 'inventory (before apply): EDGE-16 — active members who LOSE the sla_defaults write (hold none of Admin / DocCtrl / DraftingSupervisor; the app never let them reach an editor)',
       (SELECT COUNT(*) FROM org_members m
         WHERE m.status = 'active'
           AND NOT (m.role IN ('Admin', 'DocCtrl', 'DraftingSupervisor')
                    OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl', 'DraftingSupervisor']::text[]))::text
UNION ALL
SELECT 7, 'inventory (before apply): of those, members of a workspace that has sla_defaults rows',
       (SELECT COUNT(*) FROM org_members m
         WHERE m.status = 'active'
           AND m.org_id IN (SELECT org_id FROM per_org)
           AND NOT (m.role IN ('Admin', 'DocCtrl', 'DraftingSupervisor')
                    OR COALESCE(m.roles, '{}'::text[]) && ARRAY['Admin', 'DocCtrl', 'DraftingSupervisor']::text[]))::text;

BEGIN;

-- 1. The write verbs: Admin, DocCtrl, DraftingSupervisor (by the full
--    collection), ANDed with sla_defaults_member_all (unchanged).
DROP POLICY IF EXISTS sla_defaults_editor_writes_ins ON sla_defaults;
CREATE POLICY sla_defaults_editor_writes_ins ON sla_defaults
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[]));

DROP POLICY IF EXISTS sla_defaults_editor_writes_upd ON sla_defaults;
CREATE POLICY sla_defaults_editor_writes_upd ON sla_defaults
  AS RESTRICTIVE FOR UPDATE
  USING (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[]))
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[]));

DROP POLICY IF EXISTS sla_defaults_editor_writes_del ON sla_defaults;
CREATE POLICY sla_defaults_editor_writes_del ON sla_defaults
  AS RESTRICTIVE FOR DELETE
  USING (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[]));

-- 3. default_days: 1–3650 whole days for every new write; validated only
--    where nothing stored is outside it (the residue is kept and counted).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sla_defaults'::regclass
                    AND conname = 'sla_defaults_default_days_bounded') THEN
    ALTER TABLE sla_defaults
      ADD CONSTRAINT sla_defaults_default_days_bounded CHECK (default_days BETWEEN 1 AND 3650) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sla_defaults WHERE NOT (default_days BETWEEN 1 AND 3650))
     AND EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sla_defaults'::regclass
                    AND conname = 'sla_defaults_default_days_bounded' AND NOT convalidated) THEN
    ALTER TABLE sla_defaults VALIDATE CONSTRAINT sla_defaults_default_days_bounded;
  END IF;
END
$$;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'EDGE-16: sla_defaults_editor_writes_ins / _upd / _del — RESTRICTIVE, INSERT / UPDATE / DELETE, Admin, DocCtrl, DraftingSupervisor (caller_holds_any_role)' AS check,
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'sla_defaults' AND permissive = 'RESTRICTIVE'
           AND ((policyname = 'sla_defaults_editor_writes_ins' AND cmd = 'INSERT' AND qual IS NULL
                 AND with_check LIKE 'caller_holds_any_role(org_id, ARRAY[''Admin''%''DocCtrl''%''DraftingSupervisor''%')
             OR (policyname = 'sla_defaults_editor_writes_upd' AND cmd = 'UPDATE'
                 AND qual LIKE 'caller_holds_any_role(org_id, ARRAY[''Admin''%''DocCtrl''%''DraftingSupervisor''%'
                 AND with_check LIKE 'caller_holds_any_role(org_id, ARRAY[''Admin''%''DocCtrl''%''DraftingSupervisor''%')
             OR (policyname = 'sla_defaults_editor_writes_del' AND cmd = 'DELETE' AND with_check IS NULL
                 AND qual LIKE 'caller_holds_any_role(org_id, ARRAY[''Admin''%''DocCtrl''%''DraftingSupervisor''%'))) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'EDGE-16: SELECT unchanged — sla_defaults_member_all (20260605) is still the one PERMISSIVE policy, FOR ALL TO authenticated, active membership',
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'sla_defaults' AND permissive = 'PERMISSIVE'
           AND policyname = 'sla_defaults_member_all' AND cmd = 'ALL' AND roles = '{authenticated}'::name[]
           AND qual LIKE '%org_members%auth.uid()%''active''%'
           AND with_check LIKE '%org_members%auth.uid()%''active''%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = 'public' AND tablename = 'sla_defaults' AND permissive = 'PERMISSIVE'
                          AND policyname <> 'sla_defaults_member_all'),
       NULL
UNION ALL
SELECT 'EDGE-16: row-level security is still enabled on sla_defaults',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sla_defaults'::regclass),
       NULL
UNION ALL
SELECT 'EDGE-16: sla_defaults_default_days_bounded — CHECK (default_days BETWEEN 1 AND 3650) holds every new write',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded'
                  AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%default_days >= 1%default_days <= 3650%'),
       NULL
UNION ALL
SELECT CASE WHEN (SELECT convalidated FROM pg_constraint
                   WHERE conrelid = 'public.sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded')
            THEN 'EDGE-16 world: the CHECK is VALIDATED — no stored row is outside 1–3650'
            ELSE 'EDGE-16 world: the CHECK is NOT VALID — the stored rows outside 1–3650 (inventory row 5) are kept; correct them in Admin → Request forms, then re-paste this file'
       END,
       COALESCE((SELECT convalidated FROM pg_constraint
                  WHERE conrelid = 'public.sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded'), false)
         = NOT EXISTS (SELECT 1 FROM sla_defaults WHERE NOT (default_days BETWEEN 1 AND 3650)),
       NULL
UNION ALL
SELECT 'caller_holds_any_role (20261045) is SECURITY DEFINER with search_path pinned',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caller_holds_any_role' AND prosecdef AND proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM df_round_g_218_before;
