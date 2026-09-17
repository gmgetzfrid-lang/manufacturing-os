-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — WF-11: the capability policy's guardrails
-- at the database.
--
-- The RESTRICTIVE policies of 20260831 gate WHICH KEY of org_configurations a
-- member may write (capability_policy → org controllers) but never the
-- CONTENT: a controller's direct PATCH could remove Admin from a critical
-- capability, grant themselves ticket.manage, and skip the audit row, because
-- validateCapabilityPolicy and the audit insert ran only in the browser. The
-- app half now routes every write through /api/admin/capability-policy
-- (service role — auth.uid() IS NULL here). This trigger holds the same rails
-- against a write that bypasses the route — an INSERT, an UPDATE, and a
-- DELETE of the row (the loader reads "no row" as the shipped defaults, so a
-- delete is the widest change there is):
--
--   * service pass (auth.uid() IS NULL): the route, restores, the SQL editor;
--   * the writer must be an org controller (is_org_controller — defence in
--     depth should the 20260831 policies ever be absent);
--   * the row cannot be re-keyed or moved to another org (either erases the
--     policy for this org exactly as a delete would, past a guard keyed to
--     NEW.key alone);
--   * a DELETE of the row requires Admin;
--   * the entries are read the way parseStoredCapabilityPolicy reads them
--     (`raw.caps ?? raw`): a present, non-null `caps` holds them, and only
--     an absent or null `caps` is the legacy flat shape — never both. A
--     present `caps` that is not an object is refused (the parser reads an
--     array or scalar there as "no entries", nothing writes that shape on
--     purpose, and the inventory below could not read the row). A flat
--     critical key beside `caps` is refused: the parser cannot see it, but
--     org_capability_allows_for's COALESCE can, and a COALESCE here let a
--     non-Admin reset every capability to its default with
--     {caps: {}, "<critical>": <the old value>};
--   * every token list of a CRITICAL capability keeps 'Admin' (or '*') —
--     mirrors validateCapabilityPolicy's rail over bare lists AND rule lists
--     (a scoped rule replaces the base list, so it is a second door); a list
--     is a rule list iff some element is not a string (normalizeCapabilityEntry),
--     and a list that mixes tokens with rules is refused — the parser would
--     drop the tokens, so 'Admin' among them is not Admin on the list;
--   * a change to a critical capability's entry, or to `grants` at all,
--     requires Admin (caller_holds_any_role) — controller is not enough;
--   * a grant naming the writer themself is a SELF-GRANT and is refused
--     unless that exact grant is already stored — jsonb equality against a
--     stored element (same cap, uid, expiry, note), never containment,
--     which would read a stored temporary or expired grant minus its
--     expiresAt as "already stored" and let the writer re-issue their own
--     delegation as a standing one;
--   * the write is AUDITED here (CAPABILITY_POLICY_CHANGED, before/after,
--     via = 'direct_write', user_id = the writer, op = insert | update |
--     delete) — a direct PATCH or DELETE cannot skip the row.
--
-- The critical list below mirrors lib/capabilityPolicy.ts CAPABILITY_DEFS
-- `critical: true` — a shape test compares the two on every run.
--
-- Widening: no — narrowing only; no member gains a write they did not have.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION capability_policy_write_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_had BOOLEAN;
  v_has BOOLEAN;
  v_org UUID;
  v_old JSONB;
  v_new JSONB;
  v_flat BOOLEAN;
  v_caps JSONB;
  v_old_caps JSONB;
  v_cap TEXT;
  v_entry JSONB;
  v_old_entry JSONB;
  v_rule JSONB;
  v_tokens JSONB;
  v_grant JSONB;
  v_admin BOOLEAN;
  v_email TEXT;
  v_role TEXT;
BEGIN
  -- Only the capability_policy row is guarded: the row written, the row
  -- deleted, or a row whose key moves to or from it. Service-role writes
  -- (the policy route, restores, the SQL editor) pass.
  v_had := CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.key = 'capability_policy' END;
  v_has := CASE WHEN TG_OP = 'DELETE' THEN false ELSE NEW.key = 'capability_policy' END;
  IF auth.uid() IS NULL OR NOT (v_had OR v_has) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Re-keying the row, or moving it to another org, erases the policy for
  -- this org exactly as a DELETE does — and slips past a guard keyed to
  -- NEW.key alone. No writer has a reason to: refused outright.
  IF TG_OP = 'UPDATE' AND (NEW.key IS DISTINCT FROM OLD.key OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    RAISE EXCEPTION 'The capability policy row cannot be re-keyed or moved to another org'
      USING ERRCODE = 'check_violation';
  END IF;
  v_org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  IF NOT is_org_controller(v_org) THEN
    RAISE EXCEPTION 'Only an Admin or DocCtrl may change the capability policy'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_admin := caller_holds_any_role(v_org, ARRAY['Admin']::text[]);
  v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.data END;
  v_new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.data END;

  IF TG_OP = 'DELETE' THEN
    -- Deleting the row resets every capability and every grant to the
    -- shipped defaults: Admin's, and audited below like any other change.
    IF NOT v_admin THEN
      RAISE EXCEPTION 'Only an Admin may delete the capability policy (the org would fall back to the shipped defaults)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- Critical capabilities: a change is Admin's, and Admin stays on EVERY
    -- list (the bare list, or each rule's tokens). The entries are read the
    -- way parseStoredCapabilityPolicy reads them (`raw.caps ?? raw`): a
    -- present, non-null `caps` holds them, and only an absent or null
    -- `caps` is the legacy flat shape. A present `caps` that is not an
    -- object is refused: the parser's indexing would read an array or
    -- scalar there as "no entries" (every capability at its default), no
    -- writer means that, and the inventory below reads the row as an
    -- object. A flat critical key BESIDE `caps` is invisible to the parser
    -- but visible to org_capability_allows_for's COALESCE, so it is refused
    -- rather than read either way.
    v_flat := COALESCE(jsonb_typeof(v_new->'caps'), 'null') = 'null';
    IF NOT v_flat AND jsonb_typeof(v_new->'caps') <> 'object' THEN
      RAISE EXCEPTION 'caps must be an object of capability entries (got a JSON %)', jsonb_typeof(v_new->'caps')
        USING ERRCODE = 'check_violation';
    END IF;
    v_caps := CASE WHEN v_flat THEN v_new ELSE v_new->'caps' END;
    v_old_caps := CASE WHEN COALESCE(jsonb_typeof(v_old->'caps'), 'null') = 'null' THEN v_old ELSE v_old->'caps' END;
    FOREACH v_cap IN ARRAY ARRAY['ticket.manage', 'ticket.force_close', 'ticket.reassign_engineer', 'checkout.force_release'] LOOP
      IF NOT v_flat AND v_new ? v_cap THEN
        RAISE EXCEPTION 'A critical capability (%) must be stored under caps, not beside it', v_cap
          USING ERRCODE = 'check_violation';
      END IF;
      v_entry := v_caps->v_cap;
      v_old_entry := v_old_caps->v_cap;
      IF v_entry IS DISTINCT FROM v_old_entry AND NOT v_admin THEN
        RAISE EXCEPTION 'Only an Admin may change a critical capability (%)', v_cap
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF v_entry IS NULL OR jsonb_typeof(v_entry) <> 'array' THEN CONTINUE; END IF;
      -- A bare list iff every element is a string (normalizeCapabilityEntry);
      -- otherwise a rule list, in which the parser keeps the objects and
      -- drops the rest — so a token mixed into a rule list is never a role,
      -- and the mix is refused rather than read as "Admin is on the list".
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entry) AS e(val) WHERE jsonb_typeof(e.val) <> 'string') THEN
        FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
          IF jsonb_typeof(v_rule) <> 'object' THEN
            RAISE EXCEPTION 'A critical capability (%) mixes role tokens with rules', v_cap
              USING ERRCODE = 'check_violation';
          END IF;
          v_tokens := v_rule->'tokens';
          IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' OR NOT (v_tokens ? 'Admin' OR v_tokens ? '*') THEN
            RAISE EXCEPTION 'Admin cannot be removed from a critical capability (%)', v_cap
              USING ERRCODE = 'check_violation';
          END IF;
        END LOOP;
      ELSIF NOT (v_entry ? 'Admin' OR v_entry ? '*') THEN
        RAISE EXCEPTION 'Admin cannot be removed from a critical capability (%)', v_cap
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;

    -- Grants: any change is Admin's; a grant to oneself is refused unless
    -- that EXACT grant is already stored — jsonb equality against each
    -- stored element, never containment (@>), which reads a stored
    -- temporary or expired grant minus its expiresAt as "already stored"
    -- and lets the writer re-issue their own delegation as a standing one.
    -- Re-storing one's own grants verbatim beside a change to someone
    -- else's passes; dropping one's own is a revocation and passes.
    IF COALESCE(v_new->'grants', '[]'::jsonb) IS DISTINCT FROM COALESCE(v_old->'grants', '[]'::jsonb) THEN
      IF NOT v_admin THEN
        RAISE EXCEPTION 'Only an Admin may grant or revoke a personal permission'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF jsonb_typeof(v_new->'grants') = 'array' THEN
        FOR v_grant IN SELECT jsonb_array_elements(v_new->'grants') LOOP
          IF v_grant->>'uid' = auth.uid()::text
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_old->'grants') = 'array' THEN v_old->'grants' ELSE '[]'::jsonb END) AS o(val)
                             WHERE o.val = v_grant) THEN
            RAISE EXCEPTION 'A personal permission cannot be granted to yourself'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  -- The audit row a direct write used to skip. Written in the same
  -- transaction as the change: if the write fails, so does the row.
  SELECT email, role INTO v_email, v_role FROM org_members
  WHERE org_id = v_org AND uid = auth.uid() AND status = 'active' LIMIT 1;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
  VALUES ('CAPABILITY_POLICY_CHANGED', 'org_configuration', v_org::text, v_org, auth.uid(), v_email, v_role,
          jsonb_build_object('op', lower(TG_OP), 'via', 'direct_write', 'before', v_old, 'after', v_new));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- One trigger, no WHEN clause: a WHEN can name OLD or NEW but not both across
-- INSERT/UPDATE/DELETE, and the guard must see the row being deleted and a
-- row whose key moves — the function's own key test is the single gate.
DROP TRIGGER IF EXISTS trg_capability_policy_write_guard ON org_configurations;
CREATE TRIGGER trg_capability_policy_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON org_configurations
  FOR EACH ROW
  EXECUTE FUNCTION capability_policy_write_guard();

COMMIT;

-- ── Verification + inventory (read-only), ONE result set ────────────────────
-- Probes: expect ok = true × 7 (n is NULL). Inventory: ok is NULL, n is the
-- aggregate count as text — never a customer row. The last two rows are the
-- two informational counts 20261052 deferred to "the next single paste".
SELECT 'guard function exists, SECURITY DEFINER, pins search_path' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'capability_policy_write_guard' AND prosecdef
                 AND array_to_string(proconfig, ',') LIKE '%search_path=public%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trigger installed BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW, no WHEN, on org_configurations',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_capability_policy_write_guard'
                 AND tgrelid = 'org_configurations'::regclass AND NOT tgisinternal
                 AND tgqual IS NULL
                 AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON public.org_configurations FOR EACH ROW EXECUTE FUNCTION %capability_policy_write_guard()%'),
       NULL
UNION ALL
SELECT 'service pass + controller check are in the body',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL OR NOT (v_had OR v_has) THEN%'
              AND prosrc LIKE '%IF NOT is_org_controller(v_org) THEN%'
          FROM pg_proc WHERE proname = 'capability_policy_write_guard'),
       NULL
UNION ALL
SELECT 'the four critical ids, the exact-match self-grant refusal (no containment) and the audit insert are in the body',
       (SELECT prosrc LIKE '%''ticket.manage'', ''ticket.force_close'', ''ticket.reassign_engineer'', ''checkout.force_release''%'
              AND prosrc LIKE '%cannot be granted to yourself%'
              AND prosrc LIKE '%WHERE o.val = v_grant) THEN%'
              AND prosrc NOT LIKE '%@> jsonb_build_array(v_grant)%'
              AND prosrc LIKE '%CAPABILITY_POLICY_CHANGED%'
          FROM pg_proc WHERE proname = 'capability_policy_write_guard'),
       NULL
UNION ALL
SELECT 'the delete rail, the re-key rail, the two caps-shape rails and the mixed-list rail are in the body',
       (SELECT prosrc LIKE '%Only an Admin may delete the capability policy%'
              AND prosrc LIKE '%cannot be re-keyed or moved to another org%'
              AND prosrc LIKE '%must be stored under caps, not beside it%'
              AND prosrc LIKE '%caps must be an object of capability entries%'
              AND prosrc LIKE '%mixes role tokens with rules%'
          FROM pg_proc WHERE proname = 'capability_policy_write_guard'),
       NULL
UNION ALL
SELECT 'the helpers it calls exist: is_org_controller(uuid), caller_holds_any_role(uuid, text[])',
       (SELECT COUNT(*) = 2 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND ((p.proname = 'is_org_controller' AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid')
             OR (p.proname = 'caller_holds_any_role' AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_roles text[]'))),
       NULL
UNION ALL
SELECT 'the 20260831 key rails are still in place (the trigger is defence in depth, not a replacement)',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE tablename = 'org_configurations' AND permissive = 'RESTRICTIVE'
           AND policyname IN ('org_config_cap_policy_insert', 'org_config_cap_policy_update', 'org_config_cap_policy_delete')),
       NULL
UNION ALL
SELECT 'inventory: expired grants stored (pruned on the next route write, WF-16)', NULL,
       (SELECT COUNT(*) FROM org_configurations c,
               jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
         WHERE c.key = 'capability_policy'
           AND g->>'expiresAt' IS NOT NULL AND (g->>'expiresAt')::timestamptz <= NOW())::text
UNION ALL
SELECT 'inventory: policies carrying at least one grant', NULL,
       (SELECT COUNT(*) FROM org_configurations c
         WHERE c.key = 'capability_policy'
           AND jsonb_typeof(c.data->'grants') = 'array' AND jsonb_array_length(c.data->'grants') > 0)::text
UNION ALL
SELECT 'inventory (deferred from 20261052): stored capability policies', NULL,
       (SELECT COUNT(*) FROM org_configurations WHERE key = 'capability_policy')::text
UNION ALL
-- The rule-list count reads each row as parseStoredCapabilityPolicy does:
-- a present non-null `caps` wins whatever its type (an object yields its
-- entries, anything else none), and only an absent or null `caps` is the
-- flat shape, read only when `data` is itself an object. A non-object
-- there (a row written before the trigger) yields no entries instead of
-- aborting the paste with "cannot call jsonb_each on a non-object".
SELECT 'inventory (deferred from 20261052): rule-list entries already stored', NULL,
       (SELECT COUNT(*) FROM org_configurations c,
               jsonb_each(CASE WHEN jsonb_typeof(c.data->'caps') = 'object' THEN c.data->'caps'
                               WHEN COALESCE(jsonb_typeof(c.data->'caps'), 'null') <> 'null' THEN '{}'::jsonb
                               WHEN jsonb_typeof(c.data) = 'object' THEN c.data
                               ELSE '{}'::jsonb END) e
         WHERE c.key = 'capability_policy'
           AND jsonb_typeof(e.value) = 'array'
           AND jsonb_array_length(e.value) > 0
           AND jsonb_typeof(e.value->0) = 'object')::text;
