-- 20261202_ao_roundG_audit_org_required.sql
--
-- admin-and-org Round G — package P7 (audit-log integrity): ALOG-10, and the
-- org_id IS NULL half of drafting-flow PERS-7 (re-owned to P7 at the DF-P1
-- merge). Decision (the integrator's, under the user's delegation, DEC-90
-- practice: fail safe): audit_logs.org_id becomes NOT NULL and the INSERT
-- policy stops admitting a row with no workspace — with the counts-only
-- inventory first. If rows with no workspace already exist, this paste
-- STOPS with their count and changes nothing; audit rows are never deleted.
--
-- WHY:
--   audit_logs_insert (20260813_acl_close_gaps_and_audit_scope.sql:85-90,
--   its newest definition) admits `org_id IS NULL OR org_id IN (SELECT
--   my_org_ids())`, but every SELECT policy reads `org_id IN (SELECT
--   my_org_ids())` (schema.sql audit_logs_org_access) — NULL IN (…) is never
--   true — and both viewers filter .eq("org_id", activeOrgId). A row written
--   with no workspace is accepted, immutable, and unreadable to every
--   signed-in reader for ever: a write-only sink for audit evidence. The
--   column is nullable (schema.sql), so the service role can write one too.
--
-- WHAT:
--   1. The world is chosen from the rows (DEC-30 two worlds):
--        * no row has org_id NULL → ALTER COLUMN org_id SET NOT NULL;
--        * rows with org_id NULL exist → the paste RAISES with their count
--          and nothing is changed, UNLESS the operator has chosen to keep
--          them (below), in which case a CHECK (org_id IS NOT NULL) NOT VALID
--          binds every NEW row and the existing ones are kept as they are.
--   2. audit_logs_insert re-created from its NEWEST definition (20260813)
--      without the `org_id IS NULL OR` branch: a signed-in insert must name
--      one of the caller's own active workspaces. Nothing else in it changes.
--
-- IF THE PASTE STOPS ("ALOG-10 (20261202): N audit row(s) name no
-- workspace…"): nothing was changed and nothing was deleted. Those rows can
-- be read only from the SQL editor (the service role). The operator then
-- does ONE of:
--   (a) keep them as they are and bind every new row: paste the file again
--       with this line added as the FIRST line of the paste —
--         SET alog10.keep_unscoped_rows = 'on';
--       The column stays nullable, the NOT VALID check refuses every new row
--       with no workspace, the existing rows are kept and counted in the
--       final SELECT ("after: rows with no workspace").
--   (b) leave this file unpasted. The app is unaffected either way (below).
-- Never DELETE them: they are audit evidence. Attributing them to a
-- workspace by hand would rewrite an audit row; this file does not do it
-- and the record does not ask for it.
--
-- WHO IS AFFECTED: nobody legitimate. Every server writer names its org
-- (the census in lib/__tests__/auditLog.test.ts walks every audit_logs
-- insert in app/, lib/, components/ and hooks/, and every SQL INSERT INTO
-- audit_logs in the numbered migrations, and reads where its org_id comes
-- from), and lib/audit.ts logAuditAction already refuses, in the app, an
-- entry with no workspace (ALOG-10 done-when 2) — so the app writes no
-- such row before or after the paste. After it, the database refuses one
-- too: a signed-in insert with no workspace is 42501 (the policy), a
-- service-role one 23502 (NOT NULL) or 23514 (the NOT VALID check).
--
-- APP BEFORE AND AFTER THE PASTE: identical. No column, function or table
-- is added, so there is no 42703 / 42883 / PGRST20x path.
--
-- LOCKS AND HOW LONG (P7 review fix — say it before the paste):
--   SET NOT NULL takes ACCESS EXCLUSIVE on audit_logs and reads every row to
--   prove none is NULL; DROP / CREATE POLICY take the same lock, briefly.
--   The lock is held from that statement to COMMIT, so for the length of ONE
--   sequential scan of audit_logs every audit insert and every audit read
--   waits — server routes that write their audit row first (the ticket
--   workflow action, a checkout) stall for that long. On a few million rows
--   that is seconds; the inventory's first row gives the row count to judge
--   by. Paste at a quiet time. `SET LOCAL lock_timeout = '5s'` bounds the
--   WAIT for the lock: if a long reader holds the table, the paste stops
--   ("canceling statement due to lock timeout"), nothing is changed, and it
--   can simply be pasted again — it never queues every writer behind itself.
--   The lighter form (ADD CHECK … NOT VALID, VALIDATE under SHARE UPDATE
--   EXCLUSIVE, then SET NOT NULL using the validated check) needs three
--   separate transactions, which the one-transaction paste (DEC-30) does
--   not allow; at this table's size the single scan is the simpler risk.
--
-- PASTE AND DEPLOY ORDER: deploy the app first (its logAuditAction refuses
-- an entry with no workspace — a page that wrote one during sign-in now
-- writes nothing, as the database will require), then paste. Independent of
-- 20261201 (either order) and of every other pending file: no later file
-- re-creates audit_logs_insert (20261163 adds a separate RESTRICTIVE policy,
-- which ANDs with this one and is untouched).
--
-- ROLLBACK:
--   ALTER TABLE audit_logs ALTER COLUMN org_id DROP NOT NULL;
--   ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_org_id_present;
--   DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
--   CREATE POLICY audit_logs_insert ON audit_logs
--     FOR INSERT TO authenticated
--     WITH CHECK (
--       user_id = auth.uid()
--       AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))
--     );
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the final
-- SELECT carries every probe (ok true/false, n NULL; expect ok = true × 6)
-- and the inventory counts (ok NULL, n the count — aggregate counts only,
-- never a row).

-- ── Before-apply inventory (aggregate counts only, read BEFORE the change) ──
DROP TABLE IF EXISTS pg_temp._ao_g202_before;
CREATE TEMP TABLE _ao_g202_before AS
SELECT 'inventory: audit_logs rows in all (SET NOT NULL reads each of them while it holds ACCESS EXCLUSIVE — see LOCKS in the header)' AS inventory,
       COUNT(*)::text AS n FROM audit_logs
UNION ALL
SELECT 'inventory: audit rows with no workspace (org_id IS NULL) — kept, never deleted',
       COUNT(*)::text FROM audit_logs WHERE org_id IS NULL
UNION ALL
SELECT 'inventory: of them, rows naming a person (user_id set)',
       COUNT(*)::text FROM audit_logs WHERE org_id IS NULL AND user_id IS NOT NULL
UNION ALL
SELECT 'inventory: of them, machine rows (user_id NULL)',
       COUNT(*)::text FROM audit_logs WHERE org_id IS NULL AND user_id IS NULL
UNION ALL
SELECT 'inventory: audit_logs.org_id was nullable before this paste (1 = first apply; 0 = a re-run)',
       COUNT(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'org_id' AND is_nullable = 'YES'
UNION ALL
SELECT 'inventory: audit_logs_insert admitted a row with no workspace before this paste (1 = first apply; 0 = a re-run)',
       COUNT(*)::text FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_insert'
          AND with_check LIKE '%org_id IS NULL%';

BEGIN;

-- Bound the WAIT for audit_logs' lock (LOCKS in the header): a paste that
-- cannot take it within 5 s stops with nothing changed, never queueing every
-- audit writer behind itself.
SET LOCAL lock_timeout = '5s';

-- ── 1. the world: NOT NULL, or stop with the count ──────────────────────────
DO $world$
DECLARE
  v_null bigint;
  v_keep boolean := COALESCE(current_setting('alog10.keep_unscoped_rows', true), '') = 'on';
BEGIN
  SELECT COUNT(*) INTO v_null FROM audit_logs WHERE org_id IS NULL;
  IF v_null = 0 THEN
    ALTER TABLE audit_logs ALTER COLUMN org_id SET NOT NULL;
  ELSIF v_keep THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_org_id_present') THEN
      ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_org_id_present CHECK (org_id IS NOT NULL) NOT VALID;
    END IF;
  ELSE
    RAISE EXCEPTION 'ALOG-10 (20261202): % audit row(s) name no workspace (org_id IS NULL). Nothing was changed and nothing was deleted. To keep those rows as they are and require a workspace on every new row, paste this file again with the line  SET alog10.keep_unscoped_rows = ''on'';  as its first line. See the file header.', v_null
      USING ERRCODE = 'check_violation';
  END IF;
END
$world$;

-- ── 2. a signed-in insert names one of the caller's own workspaces ──────────
-- From 20260813_acl_close_gaps_and_audit_scope.sql:84-90 (the newest
-- definition), less the `org_id IS NULL OR` branch.
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT my_org_ids())
  );

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 6 (n NULL). Inventory rows: ok NULL, n = the count.
SELECT 'every new audit row must name a workspace: org_id NOT NULL, or (rows with none kept by the operator) the NOT VALID check' AS check,
       (EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'public.audit_logs'::regclass AND attname = 'org_id' AND attnotnull)
        OR EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_org_id_present'
                      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%org_id IS NOT NULL%')) AS ok,
       NULL::text AS n
UNION ALL SELECT 'org_id is NOT NULL on the column when no row lacks a workspace (the check is only the kept-rows world)',
       (SELECT COUNT(*) FROM audit_logs WHERE org_id IS NULL) > 0
       OR EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = 'public.audit_logs'::regclass AND attname = 'org_id' AND attnotnull), NULL
UNION ALL SELECT 'audit_logs_insert: for authenticated, binds user_id = auth.uid() and an org of the caller''s',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_insert'
                  AND cmd = 'INSERT' AND permissive = 'PERMISSIVE' AND 'authenticated' = ANY (roles)
                  AND with_check LIKE '%user_id = auth.uid()%' AND with_check LIKE '%my_org_ids()%'), NULL
UNION ALL SELECT 'audit_logs_insert no longer admits a row with no workspace',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_insert'
                      AND with_check LIKE '%IS NULL%'), NULL
UNION ALL SELECT 'no PERMISSIVE INSERT policy on audit_logs admits a row with no workspace',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND permissive = 'PERMISSIVE'
                      AND cmd IN ('INSERT', 'ALL') AND COALESCE(with_check, '') LIKE '%org_id IS NULL%'), NULL
UNION ALL SELECT 'audit_logs: RLS still on, and still append-only for signed-in callers (no UPDATE / DELETE / ALL policy)',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_logs'::regclass), false)
       AND NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd IN ('UPDATE', 'DELETE', 'ALL')), NULL
UNION ALL SELECT inventory, NULL, n FROM _ao_g202_before
UNION ALL SELECT 'after: rows with no workspace (0 = org_id is NOT NULL; more = kept by the operator, readable only from the SQL editor)',
       NULL, (SELECT COUNT(*)::text FROM audit_logs WHERE org_id IS NULL);
