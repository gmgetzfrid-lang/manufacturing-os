-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 severity sweep, Round C1: the audit-completion
-- table states the rule the orchestrator now enforces.
--
--   SURF-7 / EGRESS-3 (done-when 3)
--            drawing_audit_logs had a SELECT policy for members and NO write
--            policy at all — the service-role orchestrator was its only writer,
--            and until Round C1 it accepted a completion from any role that
--            clicked "confirm". The app half now requires the controller tier
--            (Admin / DocCtrl / Manager / Supervisor) BY THE ROLE COLLECTION.
--            This migration gives the table the matching write policy so the
--            database states the same rule: a controller may INSERT or UPDATE
--            a completion in their own org; nobody deletes one; reading is
--            unchanged. `caller_holds_any_role` (20261045) is the funnel.
--
--   Widening: yes — a controller-tier member gains a direct INSERT/UPDATE path
--   that did not exist (only the service role could write). It is the same
--   set of people the orchestrator now accepts, so nothing is granted that
--   the app does not already grant; the inventory below is recorded BEFORE
--   apply per the DEC-2 reversal clause.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the controller tier, by the collection, may record an audit completion
DROP POLICY IF EXISTS drawing_audit_logs_controller_insert ON drawing_audit_logs;
CREATE POLICY drawing_audit_logs_controller_insert ON drawing_audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]));

-- ── 2. … and correct one (the upsert conflict target is org/sheet/revision)
DROP POLICY IF EXISTS drawing_audit_logs_controller_update ON drawing_audit_logs;
CREATE POLICY drawing_audit_logs_controller_update ON drawing_audit_logs
  FOR UPDATE TO authenticated
  USING (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]))
  WITH CHECK (caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]));

COMMENT ON POLICY drawing_audit_logs_controller_insert ON drawing_audit_logs IS
  'SURF-7 / EGRESS-3: recording an audit completion is a controller-tier act (by the role collection). No member DELETE policy exists by design.';

COMMIT;

-- ── Verification (read-only) — expect true × 4 ──────────────────────────────
SELECT 'caller_holds_any_role(uuid, text[]) is present (20261045)' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'caller_holds_any_role'
                 AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_roles text[]') AS ok
UNION ALL
SELECT 'INSERT policy: controller tier by collection, org-scoped',
       (SELECT cmd = 'INSERT' AND roles = '{authenticated}'::name[]
          AND with_check LIKE '%caller_holds_any_role(org_id, ARRAY[''Admin''%'
          AND with_check LIKE '%''DocCtrl''%' AND with_check LIKE '%''Manager''%' AND with_check LIKE '%''Supervisor''%'
          FROM pg_policies WHERE tablename = 'drawing_audit_logs' AND policyname = 'drawing_audit_logs_controller_insert')
UNION ALL
SELECT 'UPDATE policy: same tier on USING and WITH CHECK',
       (SELECT cmd = 'UPDATE' AND roles = '{authenticated}'::name[]
          AND qual LIKE '%caller_holds_any_role(org_id, ARRAY[''Admin''%' AND qual LIKE '%''Supervisor''%'
          AND with_check LIKE '%caller_holds_any_role(org_id, ARRAY[''Admin''%' AND with_check LIKE '%''Supervisor''%'
          FROM pg_policies WHERE tablename = 'drawing_audit_logs' AND policyname = 'drawing_audit_logs_controller_update')
UNION ALL
SELECT 'exactly three policies: the member SELECT (unchanged) plus the two controller writes; no DELETE',
       (SELECT COUNT(*) = 3 AND COUNT(*) FILTER (WHERE cmd = 'DELETE') = 0
          AND COUNT(*) FILTER (WHERE policyname = 'drawing_audit_logs_read' AND cmd = 'SELECT') = 1
          FROM pg_policies WHERE tablename = 'drawing_audit_logs');

-- ── Inventory (read-only, aggregate) — run BEFORE the DDL ───────────────────
-- Records the state the widening starts from (DEC-2 reversal clause).
SELECT 'audit-completion rows (all orgs)' AS what, COUNT(*) AS n FROM drawing_audit_logs
UNION ALL
SELECT 'policies on drawing_audit_logs before apply (expect 1: the member SELECT)', COUNT(*) FROM pg_policies WHERE tablename = 'drawing_audit_logs'
UNION ALL
SELECT 'write policies on drawing_audit_logs before apply (expect 0)', COUNT(*) FROM pg_policies WHERE tablename = 'drawing_audit_logs' AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
UNION ALL
SELECT 'controller-tier memberships by collection (the people this widens to)', COUNT(*)
  FROM org_members WHERE status = 'active' AND roles && ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[];
