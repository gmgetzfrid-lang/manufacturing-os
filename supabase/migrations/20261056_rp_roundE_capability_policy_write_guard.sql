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
-- against a write that bypasses the route:
--
--   * service pass (auth.uid() IS NULL): the route, restores, the SQL editor;
--   * the writer must be an org controller (is_org_controller — defence in
--     depth should the 20260831 policies ever be absent);
--   * every token list of a CRITICAL capability keeps 'Admin' (or '*') —
--     mirrors validateCapabilityPolicy's rail over bare lists AND rule lists
--     (a scoped rule replaces the base list, so it is a second door);
--   * a change to a critical capability's entry, or to `grants` at all,
--     requires Admin (caller_holds_any_role) — controller is not enough;
--   * a grant naming the writer themself that was not already stored is a
--     SELF-GRANT and is refused;
--   * the write is AUDITED here (CAPABILITY_POLICY_CHANGED, before/after,
--     via = 'direct_write', user_id = the writer) — a direct PATCH cannot
--     skip the row.
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
  v_old JSONB;
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
  -- Service-role writes (the policy route, restores, the SQL editor) pass.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF NEW.key <> 'capability_policy' THEN RETURN NEW; END IF;

  IF NOT is_org_controller(NEW.org_id) THEN
    RAISE EXCEPTION 'Only an Admin or DocCtrl may change the capability policy'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.data ELSE NULL END;
  v_admin := caller_holds_any_role(NEW.org_id, ARRAY['Admin']::text[]);

  -- Critical capabilities: a change is Admin's, and Admin stays on EVERY list
  -- (the bare list, or each rule's tokens). Both stored shapes are read the
  -- way org_capability_allows_for reads them: caps.<id>, else the flat <id>.
  FOREACH v_cap IN ARRAY ARRAY['ticket.manage', 'ticket.force_close', 'ticket.reassign_engineer', 'checkout.force_release'] LOOP
    v_entry := COALESCE(NEW.data->'caps'->v_cap, NEW.data->v_cap);
    v_old_entry := COALESCE(v_old->'caps'->v_cap, v_old->v_cap);
    IF v_entry IS DISTINCT FROM v_old_entry AND NOT v_admin THEN
      RAISE EXCEPTION 'Only an Admin may change a critical capability (%)', v_cap
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_entry IS NULL OR jsonb_typeof(v_entry) <> 'array' THEN CONTINUE; END IF;
    IF jsonb_array_length(v_entry) > 0 AND jsonb_typeof(v_entry->0) = 'object' THEN
      FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
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

  -- Grants: any change is Admin's; a grant to oneself that was not already
  -- stored is refused.
  IF COALESCE(NEW.data->'grants', '[]'::jsonb) IS DISTINCT FROM COALESCE(v_old->'grants', '[]'::jsonb) THEN
    IF NOT v_admin THEN
      RAISE EXCEPTION 'Only an Admin may grant or revoke a personal permission'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF jsonb_typeof(NEW.data->'grants') = 'array' THEN
      FOR v_grant IN SELECT jsonb_array_elements(NEW.data->'grants') LOOP
        IF v_grant->>'uid' = auth.uid()::text
           AND NOT (COALESCE(v_old->'grants', '[]'::jsonb) @> jsonb_build_array(v_grant)) THEN
          RAISE EXCEPTION 'A personal permission cannot be granted to yourself'
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- The audit row a direct write used to skip. Written in the same
  -- transaction as the change: if the write fails, so does the row.
  SELECT email, role INTO v_email, v_role FROM org_members
  WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active' LIMIT 1;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
  VALUES ('CAPABILITY_POLICY_CHANGED', 'org_configuration', NEW.org_id::text, NEW.org_id, auth.uid(), v_email, v_role,
          jsonb_build_object('op', lower(TG_OP), 'via', 'direct_write', 'before', v_old, 'after', NEW.data));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capability_policy_write_guard ON org_configurations;
CREATE TRIGGER trg_capability_policy_write_guard
  BEFORE INSERT OR UPDATE ON org_configurations
  FOR EACH ROW
  WHEN (NEW.key = 'capability_policy')
  EXECUTE FUNCTION capability_policy_write_guard();

COMMIT;

-- ── Verification + inventory (read-only), ONE result set ────────────────────
-- Probes: expect ok = true × 6 (n is NULL). Inventory: ok is NULL, n is the
-- aggregate count as text — never a customer row. The last two rows are the
-- two informational counts 20261052 deferred to "the next single paste".
SELECT 'guard function exists, SECURITY DEFINER, pins search_path' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'capability_policy_write_guard' AND prosecdef
                 AND array_to_string(proconfig, ',') LIKE '%search_path=public%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trigger installed BEFORE INSERT OR UPDATE on org_configurations, keyed to capability_policy',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_capability_policy_write_guard'
                 AND tgrelid = 'org_configurations'::regclass AND NOT tgisinternal
                 AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE ON public.org_configurations%'
                 AND pg_get_triggerdef(oid) LIKE '%capability_policy%'),
       NULL
UNION ALL
SELECT 'service pass + controller check are in the body',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
              AND prosrc LIKE '%IF NOT is_org_controller(NEW.org_id) THEN%'
          FROM pg_proc WHERE proname = 'capability_policy_write_guard'),
       NULL
UNION ALL
SELECT 'the four critical ids, the self-grant refusal and the audit insert are in the body',
       (SELECT prosrc LIKE '%''ticket.manage'', ''ticket.force_close'', ''ticket.reassign_engineer'', ''checkout.force_release''%'
              AND prosrc LIKE '%cannot be granted to yourself%'
              AND prosrc LIKE '%CAPABILITY_POLICY_CHANGED%'
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
SELECT 'inventory (deferred from 20261052): rule-list entries already stored', NULL,
       (SELECT COUNT(*) FROM org_configurations c,
               jsonb_each(COALESCE(c.data->'caps', c.data)) e
         WHERE c.key = 'capability_policy'
           AND jsonb_typeof(e.value) = 'array'
           AND jsonb_array_length(e.value) > 0
           AND jsonb_typeof(e.value->0) = 'object')::text;
