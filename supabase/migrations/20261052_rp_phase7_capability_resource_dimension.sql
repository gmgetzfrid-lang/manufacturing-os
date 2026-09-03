-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round D3 — DEC-13 stage 2: the capability policy's
-- RESOURCE dimension at the database (DRAFT-1, WF-13, GAP-1).
--
-- lib/capabilityPolicy.ts now lets a capability entry be a list of RULES
-- `{tokens, when?}`; a rule whose `when` matches the resource being evaluated
-- (request type / unit / library / discipline) REPLACES the base token list.
-- The four evaluators must move together (GAP-1 "Do not"): getActions, holds,
-- the simulator, and this function. Here:
--
--   * org_capability_allows_for(p_org, p_cap, p_uid, p_resource jsonb) — the
--     evaluator with the resource argument. Resolves a rule list exactly as
--     the TS tokensFor does: first conditional rule matching the resource,
--     else the first unconditional rule, else the legacy bare list, else the
--     shipped default (the CASE is copied VERBATIM from 20261038 — a shape
--     test compares it against CAPABILITY_DEFS on every run).
--   * org_capability_allows(p_org, p_cap, p_uid) — kept with its signature
--     (document_holds policies and enforce_checkout_release_guard depend on
--     it) and re-created as a thin wrapper passing an EMPTY resource, so
--     every existing caller keeps seeing exactly the base list.
--
-- Behaviour change for an org that has configured no rule: none. A bare
-- string[] entry and an absent entry resolve as before; only a rule list
-- with a matching `when` can produce a different answer, and no caller
-- passes a non-empty resource until one is wired to _for.
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

-- The 3-argument entry point every existing policy and trigger calls: same
-- signature, now a wrapper. An empty resource can match no conditional rule,
-- so these callers see the base list — exactly what they saw before.
CREATE OR REPLACE FUNCTION org_capability_allows(p_org UUID, p_cap TEXT, p_uid UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN org_capability_allows_for(p_org, p_cap, p_uid, '{}'::jsonb);
END;
$$;

COMMIT;

-- ── Verification (read-only) — expect true × 5 ──────────────────────────────
SELECT 'resource evaluator exists with 4 arguments' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4) AS ok
UNION ALL
SELECT 'the 3-argument entry point is now the wrapper',
       (SELECT prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'
          FROM pg_proc WHERE proname = 'org_capability_allows' AND pronargs = 3)
UNION ALL
SELECT 'the evaluator reads the four resource keys and keeps the full default CASE',
       (SELECT prosrc LIKE '%''requestType'', ''unit'', ''libraryId'', ''discipline''%'
              AND prosrc LIKE '%ticket.assign%' AND prosrc LIKE '%admin.archive_view%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for')
UNION ALL
SELECT 'both functions pin search_path',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('org_capability_allows', 'org_capability_allows_for')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%')
UNION ALL
SELECT 'document_holds policies still call the 3-argument entry point',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename = 'document_holds'
           AND policyname IN ('document_holds_insert', 'document_holds_update')
           AND (COALESCE(qual, '') LIKE '%org_capability_allows(%' OR COALESCE(with_check, '') LIKE '%org_capability_allows(%'));

-- ── Inventory (read-only, paste back) — aggregate counts only:
-- 1. stored capability policies (one per org that ever saved the grid);
-- 2. of those, entries already in the rule-list shape (expect 0 before any
--    org uses the new override panel — the function reads both shapes).
SELECT 'stored capability policies' AS inventory, COUNT(*)::text AS n
FROM org_configurations WHERE key = 'capability_policy'
UNION ALL
SELECT 'rule-list entries already stored', COUNT(*)::text
FROM org_configurations c,
     jsonb_each(COALESCE(c.data->'caps', c.data)) e
WHERE c.key = 'capability_policy'
  AND jsonb_typeof(e.value) = 'array'
  AND jsonb_array_length(e.value) > 0
  AND jsonb_typeof(e.value->0) = 'object';
