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
--   DRLS-16 rule: the re-created SECURITY DEFINER function takes EXECUTE away
--   from PUBLIC and anon and grants it to the roles that call it —
--   authenticated (the transmittals guard runs with the caller's rights) and
--   service_role. The 3-argument wrapper, which every policy calls, is itself
--   SECURITY DEFINER and reaches this function as its owner.
--
-- On its own this file changes nobody's database authority: no policy or
-- trigger reads 'ai.manage_caps'; the app's cap editor does. What changes
-- with the app half: Doc Control no longer sets AI caps unless the policy
-- console grants the capability, and a stored $0 cap now LOCKS (GOV-3) where
-- it used to mean "no cap" — the pre-apply inventory counts both.
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
SELECT 'BEFORE: stored policies already carrying an ai.manage_caps entry (expect 0)', COUNT(*)::text
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

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 6 ─────────
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
