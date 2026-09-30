-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — J3 MONEY-LEDGER: change-order authority (COST-6).
--
-- 20261013's `change_orders_write` was ONE `FOR ALL` grant for the controller
-- OR the project owner, so the identity that inserts a proposed change order
-- could flip it to approved in the same breath, for any amount — and DELETE
-- it. This migration:
--
--   1. SPLITS the grant. `change_orders_insert` admits a row only as the app
--      proposes it: status 'proposed', `created_by = auth.uid()` (the
--      proposer is the signed-in caller, never a client-chosen or NULL uid),
--      NO decision and NO link yet (posted_entry_id, decided_by, decided_at,
--      decided_by_name and decision_note all NULL — a row born with a link
--      or a decider would carry them past every UPDATE rule below), and
--      `org_id = project_org(project_id)` (the row's org IS its project's
--      org, so the controller test, the eligible-decider count and the
--      threshold are read for the right org); `change_orders_update` carries
--      the same controller-or-owner predicate on USING and WITH CHECK
--      (byte-carried from 20261013 so the two cannot drift); NO policy admits
--      DELETE (20261093's guard refuses it regardless). Reads
--      (`change_orders_member_read`, 20261013) are untouched. The service
--      role bypasses RLS, so a service-role restore (lib/dataRestore) still
--      re-inserts rows with their decision history — deliberately.
--   2. Adds `enforce_change_order_decision_guard`, a BEFORE UPDATE trigger —
--      a TRIGGER, not a second permissive policy (DRLS-1: a permissive policy
--      ORs, it never narrows). On EVERY update: the proposer (created_by) is
--      never rewritten, and the decider (decided_by) is written only by the
--      decision itself (proposed → decided) or cleared by its revert
--      (→ proposed).
--      A SIGNED-IN caller's UPDATE (auth.uid() set) may make exactly the
--      updates lib/changeOrders.ts makes, and no others. Each step names the
--      columns it writes; EVERY other column of the row must stay as it was
--      (to_jsonb(NEW) minus those columns = to_jsonb(OLD) minus them):
--        · proposed → proposed — the budget-line pick before an approval
--          (ChangeOrdersPanel): cost_account_id only. A proposed CO's
--          amount, reason, title, party, number and decision fields never
--          change — the decider decides what was proposed.
--        · proposed → approved | rejected | void — the decision
--          (decideChangeOrder's claim): status, decided_at, decided_by,
--          decided_by_name, decision_note. It records the caller:
--          NEW.decided_by must be auth.uid(). approved / rejected run the two
--          rules below; void (a proposer withdrawing, or anyone closing the
--          paper) moves no money and runs neither, exactly as the lib. An
--          approval needs a row with no link yet (a row given one before
--          this rail cannot be approved as it is).
--        · approved → approved — the posted_entry_id link (decideChangeOrder
--          after the post; repairChangeOrder link): posted_entry_id only.
--        · approved → void — the unwind (unwindChangeOrder, which voids the
--          CO's entry FIRST and then the CO) and the repair reverse
--          (repairChangeOrder): status and decision_note only; the approver
--          stays decided_by.
--        · approved → proposed — ONLY revertDecision after a failed post: by
--          the caller who approved (OLD.decided_by = auth.uid()), clearing
--          every decision field, with no posted_entry_id and no unlinked
--          posted commitment carrying this CO's number on its budget line
--          (an entry's reference cannot be edited once posted — 20261093).
--        · everything else is refused: rejected and void are TERMINAL (no
--          update of any column; void → approved does not exist — the
--          unwind never needs a put-back), and approved → rejected does not
--          exist.
--      posted_entry_id, when the link step writes it, goes only to a POSTED
--      commitment of the same project and budget line whose trimmed
--      reference is the CO number, with no source document and no other
--      change order's link (repairChangeOrder's link tie); it is never
--      cleared, and repointed only away from a void or missing entry (the
--      repair link path) — never away from a posted one.
--      lib/changeOrders.decideChangeOrder also binds the decision to the
--      amount the decider was shown (`shownAmount`, a compare-and-swap on
--      amount) — the same guarantee before this migration is applied, and
--      against a service-role write.
--      NOT pinned here: which budget line a proposed CO names (any
--      cost_account_id — the pick is the one column a proposed CO may
--      change, and the id is not tied to the CO's project); decided_at is
--      the caller's clock.
--      The service role / SQL editor (auth.uid() IS NULL) keeps its pass on
--      the transitions and the link; it is held to the two pins above and,
--      on proposed → approved/rejected, to the two rules below judged on the
--      decider it records.
--      On the proposed → approved/rejected transition the decider is the
--      SIGNED-IN CALLER: a session must record itself as decided_by, and both
--      rules below judge COALESCE(auth.uid(), NEW.decided_by) — a
--      client-written decided_by is never trusted:
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
  WITH CHECK (status = 'proposed' AND created_by = auth.uid()
              AND posted_entry_id IS NULL AND decided_by IS NULL AND decided_at IS NULL
              AND decided_by_name IS NULL AND decision_note IS NULL
              AND org_id = project_org(project_id)
              AND (is_org_controller(org_id) OR user_owns_project(project_id)));

DROP POLICY IF EXISTS change_orders_update ON change_orders;
CREATE POLICY change_orders_update ON change_orders FOR UPDATE
  USING (is_org_controller(org_id) OR user_owns_project(project_id))
  WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));

COMMENT ON POLICY change_orders_insert ON change_orders IS
  'COST-6: a change order is BORN proposed, proposed by the signed-in caller (created_by = auth.uid()), with no decision and no link yet, in its project''s org (org_id = project_org(project_id)); the controller-or-owner predicate is 20261013''s, carried byte-for-byte. The service role bypasses RLS (restores keep their history).';
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
  v_may text[];
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

  -- A signed-in caller makes exactly the updates lib/changeOrders.ts makes:
  -- each step names the columns it writes (v_may), and every other column
  -- of the row must stay as it was. The service role (auth.uid() IS NULL)
  -- keeps its pass here.
  IF v_uid IS NOT NULL THEN
    IF OLD.status = 'proposed' AND NEW.status = 'proposed' THEN
      -- The budget-line pick before an approval (ChangeOrdersPanel): the
      -- budget line only. Amount, reason, title and the decision fields of a
      -- proposed CO never change (the decider approves what was proposed).
      v_may := ARRAY['cost_account_id'];
    ELSIF OLD.status = 'proposed' THEN
      -- The decision (decideChangeOrder's claim): approved | rejected | void,
      -- recording the caller.
      v_may := ARRAY['status', 'decided_at', 'decided_by', 'decided_by_name', 'decision_note'];
      IF NEW.decided_by IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'A change order is decided by the signed-in caller: decided_by must be the caller. COST-6, 20261094'
          USING ERRCODE = 'check_violation';
      END IF;
      -- An approval starts with no link: the link is written after the post
      -- (approved -> approved, tied below), never carried in from before.
      IF NEW.status = 'approved' AND NEW.posted_entry_id IS NOT NULL THEN
        RAISE EXCEPTION 'A change order is approved before its cost entry is linked; this one already carries a link, so it cannot be approved as it is. COST-6, 20261094'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.status = 'approved' AND NEW.status = 'approved' THEN
      -- The link (decideChangeOrder after the post; repairChangeOrder link).
      v_may := ARRAY['posted_entry_id'];
    ELSIF OLD.status = 'approved' AND NEW.status = 'void' THEN
      -- The unwind and the repair reverse: the reversal note only; the
      -- approval record (decided_by, decided_at) stays.
      v_may := ARRAY['status', 'decision_note'];
    ELSIF OLD.status = 'approved' AND NEW.status = 'proposed' THEN
      -- revertDecision, ONLY after a failed post: by the caller who approved,
      -- clearing the decision, while no entry is linked and no unlinked
      -- posted commitment of this CO (its number, on its budget line) is on
      -- the ledger. An entry's reference cannot be edited after it posts
      -- (20261093), so a post that landed unlinked is always found here.
      v_may := ARRAY['status', 'decided_at', 'decided_by', 'decided_by_name', 'decision_note'];
      IF OLD.decided_by IS DISTINCT FROM v_uid
         OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL
         OR NEW.decided_by_name IS NOT NULL OR NEW.decision_note IS NOT NULL
         OR OLD.posted_entry_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM cost_entries e
            WHERE e.project_id = OLD.project_id AND e.cost_account_id = OLD.cost_account_id
              AND e.entry_type = 'commitment' AND e.status = 'posted' AND e.source_document_id IS NULL
              AND btrim(e.reference) = OLD.co_number
              AND NOT EXISTS (SELECT 1 FROM change_orders o WHERE o.posted_entry_id = e.id AND o.id <> OLD.id)) THEN
        RAISE EXCEPTION 'An approved change order goes back to proposed only when its approval posted no money, only by the caller who approved it, and with its decision cleared. COST-6, 20261094'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.status IN ('rejected', 'void') THEN
      -- Terminal: no update of any column, and no way back to approved (the
      -- unwind voids the entry first, so it never needs a put-back).
      RAISE EXCEPTION 'A % change order is final: nothing on it changes any more. COST-6, 20261094', OLD.status
        USING ERRCODE = 'check_violation';
    ELSE
      RAISE EXCEPTION 'An approved change order is reversed (void), never rejected. COST-6, 20261094'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Every column that step does not write stays as it was.
    IF (to_jsonb(NEW) - v_may) IS DISTINCT FROM (to_jsonb(OLD) - v_may) THEN
      RAISE EXCEPTION 'This update changes a column the app does not write in the % -> % step: only % may change. COST-6, 20261094',
        OLD.status, NEW.status, array_to_string(v_may, ', ')
        USING ERRCODE = 'check_violation';
    END IF;

    -- posted_entry_id links an approved CO to its OWN commitment.
    IF NEW.posted_entry_id IS DISTINCT FROM OLD.posted_entry_id THEN
      IF OLD.status <> 'approved' OR NEW.status <> 'approved' OR NEW.posted_entry_id IS NULL
         OR EXISTS (SELECT 1 FROM cost_entries e WHERE e.id = OLD.posted_entry_id AND e.status = 'posted')
         OR NOT EXISTS (
           SELECT 1 FROM cost_entries e
            WHERE e.id = NEW.posted_entry_id
              AND e.project_id = NEW.project_id AND e.cost_account_id = NEW.cost_account_id
              AND e.entry_type = 'commitment' AND e.status = 'posted' AND e.source_document_id IS NULL
              AND btrim(e.reference) = NEW.co_number)
         OR EXISTS (SELECT 1 FROM change_orders o WHERE o.posted_entry_id = NEW.posted_entry_id AND o.id <> NEW.id) THEN
        RAISE EXCEPTION 'A change order links only its own posted commitment (same project and budget line, reference = its number, no source document, no other change order linked), only while approved, and never away from a posted entry. COST-6, 20261094'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF OLD.status <> 'proposed' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  -- The decider is the signed-in caller (recorded as decided_by, checked
  -- above), never a client-written uid; a service write is judged on the
  -- decider it records.
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
  'COST-6: created_by is never rewritten and decided_by only by the decision or its revert. A signed-in caller''s UPDATE makes only the app updates, each changing only its own columns (every other column stays as it was): proposed -> proposed (cost_account_id), proposed -> approved | rejected | void (status and the decision fields; the decision records the caller as decided_by; an approval needs a row with no link yet), approved -> approved (posted_entry_id), approved -> void (status, decision_note: unwind, repair reverse), approved -> proposed only by its approver, decision cleared, while no money of it is on the ledger (the failed-post revert); rejected and void are terminal (void -> approved does not exist). posted_entry_id goes only to the CO''s own posted commitment (same project and line, reference = its number, no source document, no other CO linked), never away from a posted entry. On proposed -> approved/rejected a self-decision is refused while another eligible decider exists, and an approval above org_configurations.change_order_approval_threshold (malformed = none) by a non-controller. The service role keeps its pass on the transitions and the columns. The INSERT half (born proposed, no decision, no link, in its project org) is change_orders_insert.';

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
SELECT 'change_orders_insert is FOR INSERT and admits only status = proposed, proposed by the caller, with no decision and no link, in its project org, for the controller or the owner',
       (SELECT cmd = 'INSERT'
           AND with_check LIKE '%proposed%'
           AND with_check LIKE '%created_by = auth.uid()%'
           AND with_check LIKE '%posted_entry_id IS NULL%'
           AND with_check LIKE '%decided_by IS NULL%'
           AND with_check LIKE '%decided_at IS NULL%'
           AND with_check LIKE '%decided_by_name IS NULL%'
           AND with_check LIKE '%decision_note IS NULL%'
           AND with_check LIKE '%org_id = project_org(project_id)%'
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
SELECT 'decision guard: for a signed-in caller rejected and void are TERMINAL (no void to approved branch); only the failed-post revert (approved to proposed, by its approver) steps back; an approval needs a row with no link',
       (SELECT prosrc LIKE '%IF v_uid IS NOT NULL THEN%'
           AND prosrc LIKE '%ELSIF OLD.status IN (''rejected'', ''void'') THEN%'
           AND prosrc LIKE '%change order is final%'
           AND prosrc NOT LIKE '%OLD.status = ''void'' AND NEW.status = ''approved''%'
           AND prosrc LIKE '%ELSIF OLD.status = ''approved'' AND NEW.status = ''proposed'' THEN%'
           AND prosrc LIKE '%IF OLD.decided_by IS DISTINCT FROM v_uid%'
           AND prosrc LIKE '%IF NEW.status = ''approved'' AND NEW.posted_entry_id IS NOT NULL THEN%'
          FROM pg_proc WHERE proname = 'enforce_change_order_decision_guard' AND pronargs = 0),
       NULL
UNION ALL
SELECT 'decision guard: posted_entry_id is set only on an approved change order, to its own posted commitment (same project and line, its number, no source document, no other link), never away from a posted entry',
       (SELECT prosrc LIKE '%IF NEW.posted_entry_id IS DISTINCT FROM OLD.posted_entry_id THEN%'
           AND prosrc LIKE '%IF OLD.status <> ''approved'' OR NEW.status <> ''approved'' OR NEW.posted_entry_id IS NULL%'
           AND prosrc LIKE '%AND e.project_id = NEW.project_id AND e.cost_account_id = NEW.cost_account_id%'
           AND prosrc LIKE '%AND btrim(e.reference) = NEW.co_number)%'
           AND prosrc LIKE '%WHERE o.posted_entry_id = NEW.posted_entry_id AND o.id <> NEW.id%'
          FROM pg_proc WHERE proname = 'enforce_change_order_decision_guard' AND pronargs = 0),
       NULL
UNION ALL
SELECT 'decision guard: each app step names the columns it writes and every other column stays as it was (proposed to proposed: the budget line only; the decision: status and the decision fields; the link: posted_entry_id; the reverse: status and the note)',
       (SELECT prosrc LIKE '%IF (to_jsonb(NEW) - v_may) IS DISTINCT FROM (to_jsonb(OLD) - v_may) THEN%'
           AND prosrc LIKE '%v_may := ARRAY[''cost_account_id''];%'
           AND prosrc LIKE '%v_may := ARRAY[''status'', ''decided_at'', ''decided_by'', ''decided_by_name'', ''decision_note''];%'
           AND prosrc LIKE '%v_may := ARRAY[''posted_entry_id''];%'
           AND prosrc LIKE '%v_may := ARRAY[''status'', ''decision_note''];%'
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
       (SELECT COUNT(*) FROM change_orders WHERE created_by IS NULL)::text
UNION ALL
SELECT 'inventory: change orders whose posted_entry_id is not a commitment of their own (project, budget line, CO number) — linked before this rail, left as they are', NULL,
       (SELECT COUNT(*) FROM change_orders c
         WHERE c.posted_entry_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM cost_entries e
                            WHERE e.id = c.posted_entry_id AND e.project_id = c.project_id
                              AND e.cost_account_id = c.cost_account_id AND e.entry_type = 'commitment'
                              AND btrim(e.reference) = c.co_number))::text
UNION ALL
SELECT 'inventory: void change orders whose linked entry is still POSTED (a reversal that did not void its entry — the CO stays void; void the entry by hand)', NULL,
       (SELECT COUNT(*) FROM change_orders c
         WHERE c.status = 'void'
           AND EXISTS (SELECT 1 FROM cost_entries e WHERE e.id = c.posted_entry_id AND e.status = 'posted'))::text
UNION ALL
SELECT 'inventory: proposed change orders already carrying a posted_entry_id (written before this rail — cannot be approved as they are; reject or void them)', NULL,
       (SELECT COUNT(*) FROM change_orders
         WHERE status = 'proposed' AND posted_entry_id IS NOT NULL)::text
UNION ALL
SELECT 'inventory: proposed change orders carrying decision fields (written before this rail — the decision overwrites them; nothing else can)', NULL,
       (SELECT COUNT(*) FROM change_orders
         WHERE status = 'proposed'
           AND (decided_by IS NOT NULL OR decided_at IS NOT NULL OR decided_by_name IS NOT NULL OR decision_note IS NOT NULL))::text
UNION ALL
SELECT 'inventory: change orders whose org_id is not their project org (inserted before this rail)', NULL,
       (SELECT COUNT(*) FROM change_orders c JOIN projects p ON p.id = c.project_id
         WHERE c.org_id IS DISTINCT FROM p.org_id)::text;
