-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G — I-05 (GOV-10): spend authority becomes a capability
-- the evaluators can read (DEC-13, DEC-35).
--
--   org_capability_allows_for: the body from 20261132 (the newest
--   re-creation — DC P7's, which carried 20261063 forward and added
--   transmittal.issue) VERBATIM plus ONE line in the shipped-default CASE —
--     WHEN 'ai.manage_caps' THEN ["Admin"]
--   who may set the workspace's default monthly AI cap and any person's own
--   cap. lib/capabilityPolicy.ts CAPABILITY_DEFS carries the same default;
--   /api/ai/usage reads it there. A shape test compares this body line by line against whichever
--   migration defined the evaluator most recently before this file (found by
--   scanning the sequence, not by name) and admits only this one row, and
--   compares the CASE against CAPABILITY_DEFS. The 3-argument wrapper
--   org_capability_allows is untouched.
--
--   capability_policy_write_guard: the body from 20261056 (its only
--   definition) VERBATIM with 'ai.manage_caps' added to its critical list —
--   ai.manage_caps is `critical: true` in CAPABILITY_DEFS. A change to its
--   entry is Admin's and Admin stays on every list of it, so a Doc
--   Controller cannot set it to [DocCtrl] by a direct write, become its sole
--   holder and raise their own cap (the policy route holds the same rail
--   for the console). A second shape test compares this body line by line
--   against the newest earlier definer of the guard and admits only the one
--   changed line; the trigger itself is untouched.
--
--   DRLS-16 rule: each re-created SECURITY DEFINER function takes EXECUTE
--   away from PUBLIC and anon and grants it to the roles that call it —
--   authenticated (the transmittals guard runs with the caller's rights) and
--   service_role. The 3-argument wrapper, which every policy calls, is itself
--   SECURITY DEFINER and reaches the evaluator as its owner. The write guard
--   is a trigger function, never called directly; its grants are restated
--   the same way.
--
-- Database authority after this file: no policy or trigger asks the
-- evaluator about 'ai.manage_caps' — the app's cap editor does — and the
-- write guard now refuses a non-Admin's direct write that changes the
-- ai.manage_caps entry, or one that leaves Admin off it (narrowing only). What changes with the app half: Doc Control no longer
-- sets AI caps unless an Admin grants the capability, and a stored $0 cap
-- now LOCKS (GOV-3) where it used to mean "no cap" — the pre-apply inventory
-- counts both.
--
-- The pre-apply inventory (aggregate counts only) is captured BEFORE the
-- transaction and returned with the probes; the AFTER rows ask the
-- re-created evaluator who it admits.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS intel_round_g_137_before;
CREATE TEMP TABLE intel_round_g_137_before AS
SELECT 'BEFORE: active members holding Admin (the shipped default for ai.manage_caps)' AS inventory, COUNT(*)::text AS n
  FROM org_members
 WHERE status = 'active' AND (role = 'Admin' OR roles && ARRAY['Admin']::text[])
UNION ALL
SELECT 'BEFORE: active members holding DocCtrl but not Admin (they stop setting AI caps unless the policy console grants ai.manage_caps)', COUNT(*)::text
  FROM org_members
 WHERE status = 'active'
   AND (role = 'DocCtrl' OR roles && ARRAY['DocCtrl']::text[])
   AND NOT (role = 'Admin' OR roles && ARRAY['Admin']::text[])
UNION ALL
SELECT 'BEFORE: stored policies already carrying an ai.manage_caps entry (expect 0 - from this file on it is critical, and an entry without Admin would block every later save until Admin is restored)', COUNT(*)::text
  FROM org_configurations
 WHERE key = 'capability_policy' AND COALESCE(data->'caps', data) ? 'ai.manage_caps'
UNION ALL
SELECT 'BEFORE: live per-person grants of ai.manage_caps (expect 0)', COUNT(*)::text
  FROM org_configurations c,
       jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
 WHERE c.key = 'capability_policy' AND g->>'cap' = 'ai.manage_caps'
UNION ALL
SELECT 'BEFORE: per-person AI caps stored as $0 (they LOCK from now on; $0 used to mean no cap)', COUNT(*)::text
  FROM ai_usage_limits
 WHERE user_id IS NOT NULL AND monthly_cap_usd = 0
UNION ALL
SELECT 'BEFORE: workspace-default AI caps stored as $0 (every member without their own cap is locked from now on)', COUNT(*)::text
  FROM ai_usage_limits
 WHERE user_id IS NULL AND monthly_cap_usd = 0;

BEGIN;

-- ── the evaluator learns the spend-authority capability's shipped default ──
CREATE OR REPLACE FUNCTION org_capability_allows_for(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_val JSONB;
  v_entry JSONB;
  v_tokens JSONB;
  v_rule JSONB;
  v_list JSONB;
  v_key TEXT;
  v_cond BOOLEAN;
  v_hit BOOLEAN;
  v_role TEXT;
  v_roles TEXT[];
  v_grant JSONB;
  t TEXT;
BEGIN
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
  FROM org_members
  WHERE org_id = p_org AND uid = p_uid AND status = 'active'
  LIMIT 1;
  IF v_role IS NULL THEN RETURN FALSE; END IF;

  SELECT data INTO v_val FROM org_configurations
  WHERE org_id = p_org AND key = 'capability_policy';

  p_resource := COALESCE(p_resource, '{}'::jsonb);
  v_entry := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);

  IF v_entry IS NOT NULL AND jsonb_typeof(v_entry) = 'array' THEN
    IF jsonb_array_length(v_entry) > 0 AND jsonb_typeof(v_entry->0) = 'object' THEN
      -- A RULE LIST (DEC-13). The resource keys read here are the ONLY keys
      -- either evaluator reads — lib/capabilityPolicy.ts RESOURCE_KEYS.
      -- 1. The first conditional rule whose every listed key matches.
      FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
        v_cond := FALSE;
        v_hit := TRUE;
        FOREACH v_key IN ARRAY ARRAY['requestType', 'unit', 'libraryId', 'discipline'] LOOP
          v_list := v_rule->'when'->v_key;
          IF v_list IS NOT NULL AND jsonb_typeof(v_list) = 'array' AND jsonb_array_length(v_list) > 0 THEN
            v_cond := TRUE;
            IF p_resource->>v_key IS NULL OR NOT (v_list ? (p_resource->>v_key)) THEN
              v_hit := FALSE;
            END IF;
          END IF;
        END LOOP;
        IF v_cond AND v_hit THEN
          v_tokens := v_rule->'tokens';
          EXIT;
        END IF;
      END LOOP;
      -- 2. Otherwise the first unconditional rule — the base list.
      IF v_tokens IS NULL THEN
        FOR v_rule IN SELECT jsonb_array_elements(v_entry) LOOP
          v_cond := FALSE;
          FOREACH v_key IN ARRAY ARRAY['requestType', 'unit', 'libraryId', 'discipline'] LOOP
            v_list := v_rule->'when'->v_key;
            IF v_list IS NOT NULL AND jsonb_typeof(v_list) = 'array' AND jsonb_array_length(v_list) > 0 THEN
              v_cond := TRUE;
            END IF;
          END LOOP;
          IF NOT v_cond THEN
            v_tokens := v_rule->'tokens';
            EXIT;
          END IF;
        END LOOP;
      END IF;
    ELSE
      -- The legacy bare token list (an empty list included: it denies).
      v_tokens := v_entry;
    END IF;
  END IF;

  IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' THEN
    -- Mirrors lib/capabilityPolicy.ts CAPABILITY_DEFS defaultRoles exactly —
    -- a shape test compares this CASE against the TS source on every run.
    v_tokens := CASE p_cap
      WHEN 'ticket.manage'            THEN '["Admin","Manager","Supervisor"]'::jsonb
      WHEN 'ticket.initial_review'    THEN '["Admin","Manager","Supervisor","Engineer"]'::jsonb
      WHEN 'ticket.eng_review'        THEN '["Engineer"]'::jsonb
      WHEN 'ticket.assign'            THEN '["Admin","Manager","Supervisor","DraftingSupervisor"]'::jsonb
      WHEN 'ticket.self_assign'       THEN '["Drafter"]'::jsonb
      WHEN 'ticket.draft_work'        THEN '["Drafter"]'::jsonb
      WHEN 'ticket.requester_review'  THEN '["Requester"]'::jsonb
      WHEN 'ticket.direct_approve'    THEN '["Engineer"]'::jsonb
      WHEN 'ticket.final_approve'     THEN '["Engineer"]'::jsonb
      WHEN 'ticket.reopen'            THEN '["Admin","Manager","Supervisor"]'::jsonb
      WHEN 'ticket.force_close'       THEN '["Admin","Manager","Supervisor"]'::jsonb
      WHEN 'ticket.reassign_engineer' THEN '["Admin"]'::jsonb
      WHEN 'ticket.engineer_gate_exempt' THEN '["Admin","Manager","Supervisor","Engineer","DocCtrl"]'::jsonb
      WHEN 'holds.open'               THEN '["*"]'::jsonb
      WHEN 'holds.release'            THEN '["*"]'::jsonb
      WHEN 'checkout.force_release'   THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.analytics_view'     THEN '["Admin","Manager","Supervisor","DocCtrl"]'::jsonb
      WHEN 'admin.archive_view'       THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'admin.audit_view'         THEN '["Admin","Manager","Supervisor","DocCtrl","Auditor"]'::jsonb
      WHEN 'transmittal.issue'        THEN '["Admin","DocCtrl"]'::jsonb
      WHEN 'ai.manage_caps'           THEN '["Admin"]'::jsonb
      ELSE '[]'::jsonb
    END;
  END IF;

  FOR t IN SELECT jsonb_array_elements_text(v_tokens) LOOP
    IF t = '*' THEN RETURN TRUE; END IF;
    IF t = 'Engineer' AND EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE r LIKE '%Engineer%') THEN
      RETURN TRUE;
    END IF;
    IF t = ANY(v_roles) THEN RETURN TRUE; END IF;
  END LOOP;

  IF v_val ? 'grants' AND jsonb_typeof(v_val->'grants') = 'array' THEN
    FOR v_grant IN SELECT jsonb_array_elements(v_val->'grants') LOOP
      IF v_grant->>'cap' = p_cap AND v_grant->>'uid' = p_uid::text
         AND (v_grant->>'expiresAt' IS NULL
              OR (v_grant->>'expiresAt')::timestamptz > NOW()) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END;
$$;

-- DRLS-16: EXECUTE for the roles that call it, never PUBLIC or anon.
REVOKE EXECUTE ON FUNCTION org_capability_allows_for(UUID, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION org_capability_allows_for(UUID, TEXT, UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION org_capability_allows_for(UUID, TEXT, UUID, JSONB) TO authenticated, service_role;

-- ── the write guard learns that ai.manage_caps is critical (GOV-10) ────────
-- capability_policy_write_guard from 20261056 (its only definition) VERBATIM
-- with 'ai.manage_caps' added to the critical list. A direct write that
-- changes the ai.manage_caps entry is then Admin's, and every list of it
-- keeps Admin (or '*') — the same rail the policy route and
-- validateCapabilityPolicy hold, so a Doc Controller can neither widen the
-- capability to themselves nor narrow Admin out of it. The trigger
-- (trg_capability_policy_write_guard) is untouched: CREATE OR REPLACE keeps
-- the function's identity, so the installed trigger runs the new body.
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
    FOREACH v_cap IN ARRAY ARRAY['ticket.manage', 'ticket.force_close', 'ticket.reassign_engineer', 'checkout.force_release', 'ai.manage_caps'] LOOP
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

-- DRLS-16: a trigger function is never called directly (PostgreSQL refuses
-- that, and a firing trigger checks no EXECUTE privilege) — the grants are
-- restated for the roles whose writes fire it, and PUBLIC and anon lose it.
REVOKE EXECUTE ON FUNCTION capability_policy_write_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION capability_policy_write_guard() FROM anon;
GRANT EXECUTE ON FUNCTION capability_policy_write_guard() TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 10 ────────
SELECT 'evaluator carries the ai.manage_caps default (Admin)' AS check,
       (SELECT prosrc LIKE '%WHEN ''ai.manage_caps''           THEN ''["Admin"]''::jsonb%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'evaluator still reads the four resource keys and every earlier default',
       (SELECT prosrc LIKE '%''requestType'', ''unit'', ''libraryId'', ''discipline''%'
              AND prosrc LIKE '%transmittal.issue%' AND prosrc LIKE '%admin.audit_view%'
              AND prosrc LIKE '%admin.archive_view%' AND prosrc LIKE '%checkout.force_release%'
              AND prosrc LIKE '%ticket.engineer_gate_exempt%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4),
       NULL::text
UNION ALL
SELECT 'the 3-argument wrapper is untouched and still delegates with an empty resource',
       (SELECT prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'
          FROM pg_proc WHERE proname = 'org_capability_allows' AND pronargs = 3),
       NULL::text
UNION ALL
SELECT 'search_path pinned on both evaluator entry points',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('org_capability_allows', 'org_capability_allows_for')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%'),
       NULL::text
UNION ALL
SELECT 'anon cannot execute the 4-argument evaluator (DRLS-16)',
       NOT has_function_privilege('anon', 'org_capability_allows_for(uuid, text, uuid, jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'authenticated and service_role can still execute the 4-argument evaluator',
       has_function_privilege('authenticated', 'org_capability_allows_for(uuid, text, uuid, jsonb)', 'EXECUTE')
         AND has_function_privilege('service_role', 'org_capability_allows_for(uuid, text, uuid, jsonb)', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'write guard carries ai.manage_caps on its critical list (a change is Admin''s; Admin stays on it)',
       (SELECT prosrc LIKE '%ARRAY[''ticket.manage'', ''ticket.force_close'', ''ticket.reassign_engineer'', ''checkout.force_release'', ''ai.manage_caps''] LOOP%'
          FROM pg_proc WHERE proname = 'capability_policy_write_guard'),
       NULL::text
UNION ALL
SELECT 'write guard keeps every earlier rail (controller check, delete, self-grant, mixed list, audit row)',
       (SELECT prosrc LIKE '%IF NOT is_org_controller(v_org) THEN%'
              AND prosrc LIKE '%Only an Admin may delete the capability policy%'
              AND prosrc LIKE '%cannot be granted to yourself%'
              AND prosrc LIKE '%mixes role tokens with rules%'
              AND prosrc LIKE '%CAPABILITY_POLICY_CHANGED%'
          FROM pg_proc WHERE proname = 'capability_policy_write_guard'),
       NULL::text
UNION ALL
SELECT 'write guard is SECURITY DEFINER with search_path pinned, and its trigger still runs it on org_configurations',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger t ON t.tgfoid = p.oid
                WHERE p.proname = 'capability_policy_write_guard' AND p.prosecdef
                  AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND t.tgname = 'trg_capability_policy_write_guard'
                  AND t.tgrelid = 'org_configurations'::regclass AND NOT t.tgisinternal),
       NULL::text
UNION ALL
SELECT 'anon cannot execute the write guard (DRLS-16)',
       NOT has_function_privilege('anon', 'capability_policy_write_guard()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM intel_round_g_137_before
UNION ALL
SELECT 'AFTER: active members the re-created evaluator admits to ai.manage_caps', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active' AND org_capability_allows_for(m.org_id, 'ai.manage_caps', m.uid, '{}'::jsonb)
UNION ALL
SELECT 'AFTER: active Admins the evaluator does not admit to ai.manage_caps (expect 0 - nothing stored names it yet)', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active'
   AND (m.role = 'Admin' OR m.roles && ARRAY['Admin']::text[])
   AND NOT org_capability_allows_for(m.org_id, 'ai.manage_caps', m.uid, '{}'::jsonb);
