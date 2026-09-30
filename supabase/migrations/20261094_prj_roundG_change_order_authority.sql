-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — J3 MONEY-LEDGER: change-order authority (COST-6).
--
-- 20261013's `change_orders_write` was ONE `FOR ALL` grant for the controller
-- OR the project owner, so the identity that inserts a proposed change order
-- could flip it to approved in the same breath, for any amount — and DELETE
-- it. This migration:
--
--   1. SPLITS the grant. `change_orders_insert` admits a row only in status
--      'proposed' and only with `created_by = auth.uid()` — the proposer is
--      the signed-in caller, never a client-chosen (or NULL) uid;
--      `change_orders_update` carries the same controller-or-owner predicate
--      on USING and WITH CHECK (byte-carried from 20261013 so the two cannot
--      drift); NO policy admits DELETE (20261093's guard refuses it
--      regardless). Reads (`change_orders_member_read`, 20261013) are untouched.
--   2. Adds `enforce_change_order_decision_guard`, a BEFORE UPDATE trigger —
--      a TRIGGER, not a second permissive policy (DRLS-1: a permissive policy
--      ORs, it never narrows). On EVERY update: the proposer (created_by) is
--      never rewritten, and the decider (decided_by) is written only by the
--      decision itself (proposed → decided) or cleared by its revert
--      (→ proposed). On the proposed → approved/rejected transition the
--      decider is the SIGNED-IN CALLER: a session must record itself as
--      decided_by, and both rules below judge COALESCE(auth.uid(),
--      NEW.decided_by) — a client-written decided_by is never trusted (a
--      service-role or SQL-editor write, with no auth.uid(), is judged on
--      the decider it records):
--        · self-decision (decided_by = created_by) is refused while the org
--          has another eligible decider — an active member holding the
--          controller tier, or the project owner (DEC-12's shape, derived from
--          the count, no toggle; DEC-37: the rule is about ONE deliverable's
--          proposer versus its decider, not about hats). Below that, the
--          single-person loop still completes and the row is marked in the UI.
--        · an org may set org_configurations key
--          `change_order_approval_threshold` = {"amount": N}; above it only a
--          member holding the controller tier may approve (DEC-35: the
--          threshold and the deciders are configuration and the controller
--          collection, never a facility role name in code). Default: no
--          threshold until an org sets one — a shipped default that blocked
--          every large change order would strand real approvals. The amount
--          is a JSON number or a string of plain digits; anything else
--          ("10k", "-5") is MALFORMED and means no threshold — here, in the
--          inventory below, and in lib/changeOrders.parseThresholdAmount —
--          never a raw cast error that would refuse every approval in the org.
--      The controller predicate is byte-carried from is_org_controller
--      (20260814) and evaluated for the decider above (the caller).
--      lib/changeOrders.decideChangeOrder applies the same two rules with a
--      readable refusal BEFORE the write; this trigger is the rail behind it.
--
-- NARROWS only (fewer writes admitted than before), so no pre-apply inventory
-- is required (DEC-30); the counts below are for the record.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the split ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS change_orders_write ON change_orders;

DROP POLICY IF EXISTS change_orders_insert ON change_orders;
CREATE POLICY change_orders_insert ON change_orders FOR INSERT
  WITH CHECK (status = 'proposed' AND created_by = auth.uid() AND (is_org_controller(org_id) OR user_owns_project(project_id)));

DROP POLICY IF EXISTS change_orders_update ON change_orders;
CREATE POLICY change_orders_update ON change_orders FOR UPDATE
  USING (is_org_controller(org_id) OR user_owns_project(project_id))
  WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));

COMMENT ON POLICY change_orders_insert ON change_orders IS
  'COST-6: a change order is BORN proposed, proposed by the signed-in caller (created_by = auth.uid()); the controller-or-owner predicate is 20261013''s, carried byte-for-byte.';
COMMENT ON POLICY change_orders_update ON change_orders IS
  'COST-6: decisions and unwinds by the controller or the project owner; the decision itself is guarded by enforce_change_order_decision_guard. No policy admits DELETE (20261093).';

-- ── 2. the decision guard ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_change_order_decision_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_decider uuid;
  v_others integer := 0;
  v_threshold numeric;
  v_decider_is_controller boolean := false;
BEGIN
  -- The proposer is part of the record: never rewritten.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'The proposer of a change order is never rewritten. COST-6, 20261094'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The decider is written by the decision (proposed -> decided) or cleared
  -- by its revert (-> proposed), and by nothing else.
  IF NEW.decided_by IS DISTINCT FROM OLD.decided_by
     AND NOT (OLD.status = 'proposed' AND NEW.status <> 'proposed')
     AND NOT (NEW.status = 'proposed' AND NEW.decided_by IS NULL) THEN
    RAISE EXCEPTION 'The decider of a change order is recorded by the decision itself and never rewritten. COST-6, 20261094'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'proposed' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  -- The decider is the signed-in caller, never a client-written uid.
  IF v_uid IS NOT NULL AND NEW.decided_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'A change order is decided by the signed-in caller: decided_by must be the caller. COST-6, 20261094'
      USING ERRCODE = 'check_violation';
  END IF;
  v_decider := COALESCE(v_uid, NEW.decided_by);

  -- Separation of duties, derived from who else could decide (DEC-12 shape).
  IF v_decider IS NOT NULL AND OLD.created_by IS NOT NULL AND v_decider = OLD.created_by THEN
    SELECT COUNT(*) INTO v_others FROM (
      SELECT uid FROM org_members
      WHERE org_id = NEW.org_id
        AND status = 'active'
        AND uid <> v_decider
        AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
      UNION
      SELECT p.owner_user_id FROM projects p
      WHERE p.id = NEW.project_id AND p.owner_user_id IS NOT NULL AND p.owner_user_id <> v_decider
    ) others;
    IF v_others > 0 THEN
      RAISE EXCEPTION 'A change order is decided by a second person when the org has one (% other eligible decider(s)). COST-6, 20261094', v_others
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The approval threshold the org configured: above it, a controller
  -- approves. A malformed amount means no threshold (never a cast error).
  IF NEW.status = 'approved' THEN
    SELECT CASE WHEN c.data->>'amount' ~ '^\s*\d+(\.\d+)?\s*$' THEN (c.data->>'amount')::numeric END INTO v_threshold
      FROM org_configurations c
     WHERE c.org_id = NEW.org_id AND c.key = 'change_order_approval_threshold';
    IF v_threshold IS NOT NULL AND abs(NEW.amount) > v_threshold THEN
      SELECT EXISTS (
        SELECT 1 FROM org_members
        WHERE uid = v_decider
          AND org_id = NEW.org_id
          AND status = 'active'
          AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
      ) INTO v_decider_is_controller;
      IF NOT COALESCE(v_decider_is_controller, false) THEN
        RAISE EXCEPTION 'This change order is above the approval threshold the org set (%) — a member holding the controller tier has to approve it. COST-6, 20261094', v_threshold
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_change_order_decision_guard() IS
  'COST-6: created_by is never rewritten and decided_by only by the decision or its revert; on proposed → approved/rejected the decider is the caller (auth.uid(), else the recorded decided_by for a service write), a self-decision is refused while another eligible decider exists, and an approval above org_configurations.change_order_approval_threshold (malformed = none) by a non-controller.';

DROP TRIGGER IF EXISTS trg_change_orders_decision_guard ON change_orders;
CREATE TRIGGER trg_change_orders_decision_guard
  BEFORE UPDATE ON change_orders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_change_order_decision_guard();

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows are aggregate counts
--    only (n). pg_policies.qual / with_check are DEPARSED, so the probes match
--    the function calls and the literal, never a cast.
SELECT 'change_orders_write (FOR ALL) is gone' AS check,
       (SELECT COUNT(*) = 0 FROM pg_policies WHERE tablename = 'change_orders' AND policyname = 'change_orders_write') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'change_orders_insert is FOR INSERT and admits only status = proposed, proposed by the caller, for the controller or the owner',
       (SELECT cmd = 'INSERT'
           AND with_check LIKE '%proposed%'
           AND with_check LIKE '%created_by = auth.uid()%'
           AND with_check LIKE '%is_org_controller(org_id)%'
           AND with_check LIKE '%user_owns_project(project_id)%'
          FROM pg_policies WHERE tablename = 'change_orders' AND policyname = 'change_orders_insert'),
       NULL
UNION ALL
SELECT 'change_orders_update is FOR UPDATE with the controller-or-owner predicate on USING and WITH CHECK',
       (SELECT cmd = 'UPDATE'
           AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(project_id)%'
           AND with_check LIKE '%is_org_controller(org_id)%' AND with_check LIKE '%user_owns_project(project_id)%'
          FROM pg_policies WHERE tablename = 'change_orders' AND policyname = 'change_orders_update'),
       NULL
UNION ALL
SELECT 'no policy on change_orders admits DELETE (no DELETE, no FOR ALL)',
       (SELECT COUNT(*) = 0 FROM pg_policies WHERE tablename = 'change_orders' AND cmd IN ('DELETE', 'ALL')),
       NULL
UNION ALL
SELECT 'change_orders_member_read (20261013) untouched',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE tablename = 'change_orders' AND policyname = 'change_orders_member_read' AND cmd = 'SELECT'),
       NULL
UNION ALL
SELECT 'decision guard is SECURITY DEFINER with search_path pinned, judges the caller, pins the proposer, parses the threshold defensively',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
           AND prosrc LIKE '%change_order_approval_threshold%'
           AND prosrc LIKE '%v_decider := COALESCE(v_uid, NEW.decided_by)%'
           AND prosrc LIKE '%NEW.decided_by IS DISTINCT FROM v_uid%'
           AND prosrc LIKE '%NEW.created_by IS DISTINCT FROM OLD.created_by%'
           AND prosrc LIKE '%CASE WHEN c.data->>%'
          FROM pg_proc WHERE proname = 'enforce_change_order_decision_guard' AND pronargs = 0),
       NULL
UNION ALL
SELECT 'trg_change_orders_decision_guard is a BEFORE UPDATE row trigger',
       (SELECT COUNT(*) = 1 FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgname = 'trg_change_orders_decision_guard'
           AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 1) = 1),
       NULL
UNION ALL
SELECT 'inventory: change orders decided by their proposer (flagged in the UI, never rewritten)', NULL,
       (SELECT COUNT(*) FROM change_orders WHERE decided_by IS NOT NULL AND decided_by = created_by)::text
UNION ALL
SELECT 'inventory: orgs that have set change_order_approval_threshold', NULL,
       (SELECT COUNT(*) FROM org_configurations WHERE key = 'change_order_approval_threshold')::text
UNION ALL
SELECT 'inventory: orgs whose change_order_approval_threshold is malformed (read as NO threshold)', NULL,
       (SELECT COUNT(*) FROM org_configurations
         WHERE key = 'change_order_approval_threshold'
           AND COALESCE(data->>'amount', '') !~ '^\s*\d+(\.\d+)?\s*$')::text
UNION ALL
SELECT 'inventory: approved change orders above their org threshold (decided before this rail)', NULL,
       (SELECT COUNT(*) FROM change_orders c
          JOIN org_configurations o ON o.org_id = c.org_id AND o.key = 'change_order_approval_threshold'
         WHERE c.status = 'approved'
           AND abs(c.amount) > CASE WHEN o.data->>'amount' ~ '^\s*\d+(\.\d+)?\s*$' THEN (o.data->>'amount')::numeric END)::text
UNION ALL
SELECT 'inventory: change orders with no proposer recorded (created_by NULL — the self-decision rule cannot see them)', NULL,
       (SELECT COUNT(*) FROM change_orders WHERE created_by IS NULL)::text;
