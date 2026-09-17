-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — DEC-13 stage 3: the engineer gate is a real
-- capability (`ticket.engineer_gate_exempt`), and the SQL default CASE gains
-- its row.
--
-- lib/workflow.ts engineerApprovalRequired now asks the org's
-- `ticket.engineer_gate_exempt` list which roles may approve their OWN request
-- without an engineer (default: Admin, Manager, Supervisor, every Engineer
-- tier, DocCtrl — byte-identical to the hardcoded test it replaces; the
-- DEC-16 snapshot-OR-current disjunction is unchanged). The SQL evaluator's
-- fallback CASE mirrors CAPABILITY_DEFS capability-for-capability (the WF-23
-- census in lib/__tests__/rpPhase4Migration.test.ts), so it gains the same
-- row. org_capability_allows_for is re-created VERBATIM from 20261052 with
-- that ONE line added — a shape test diffs the two bodies line by line. The
-- 3-argument wrapper of 20261052 is untouched.
--
-- Widening: no. No policy or trigger evaluates this capability at the
-- database (the gate is enforced in the workflow route); the row only keeps
-- the SQL and TS defaults in agreement.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

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

COMMIT;

-- ── Verification + inventory (read-only), ONE result set ────────────────────
-- Probes: expect ok = true × 5 (n is NULL). Inventory: ok is NULL, n is the
-- aggregate count as text — never a customer row.
SELECT 'org_capability_allows_for keeps 4 arguments and pins search_path' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4
                 AND array_to_string(proconfig, ',') LIKE '%search_path=public%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the default CASE has the engineer-gate row with the shipped default',
       (SELECT prosrc LIKE '%WHEN ''ticket.engineer_gate_exempt'' THEN ''["Admin","Manager","Supervisor","Engineer","DocCtrl"]''::jsonb%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for'),
       NULL
UNION ALL
SELECT 'the evaluator still reads the four resource keys and the full CASE',
       (SELECT prosrc LIKE '%''requestType'', ''unit'', ''libraryId'', ''discipline''%'
              AND prosrc LIKE '%ticket.assign%' AND prosrc LIKE '%admin.archive_view%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for'),
       NULL
UNION ALL
SELECT 'the 3-argument wrapper of 20261052 is untouched',
       (SELECT prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'
          FROM pg_proc WHERE proname = 'org_capability_allows' AND pronargs = 3),
       NULL
UNION ALL
SELECT 'the body compiles: a non-member is denied the new capability',
       org_capability_allows('00000000-0000-0000-0000-000000000000'::uuid, 'ticket.engineer_gate_exempt',
                             '00000000-0000-0000-0000-000000000000'::uuid) = false,
       NULL
UNION ALL
SELECT 'inventory: stored capability policies', NULL,
       (SELECT COUNT(*) FROM org_configurations WHERE key = 'capability_policy')::text
UNION ALL
SELECT 'inventory: policies already storing an engineer-gate entry (expect 0)', NULL,
       (SELECT COUNT(*) FROM org_configurations c
         WHERE c.key = 'capability_policy'
           AND COALESCE(c.data->'caps'->'ticket.engineer_gate_exempt', c.data->'ticket.engineer_gate_exempt') IS NOT NULL)::text;
