-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — package D (roles & admin): ROLE-5 done-when 2
-- and SURF-9 / WF-20's audit surface. `admin.audit_view` becomes a REAL
-- capability: the /admin/audit gate reads it (lib/adminGate.ts, by role
-- collection, then a per-person grant) and so does the database.
--
--   1. org_capability_allows_for: the body from 20261052 VERBATIM plus ONE
--      line in the shipped-default CASE —
--        WHEN 'admin.audit_view' THEN ["Admin","Manager","Supervisor","DocCtrl","Auditor"]
--      (the roles the audit page hardcoded until now). Without this line an
--      org that never edited the policy would hit the CASE's ELSE '[]' and be
--      locked out of its own audit trail. A shape test pins the body against
--      20261052 and the CASE against lib/capabilityPolicy.ts CAPABILITY_DEFS.
--      The 3-argument wrapper org_capability_allows is untouched.
--   2. audit_logs_admin_trail (the DEC-17 RESTRICTIVE SELECT overlay from
--      20261045): the hardcoded role list becomes
--      org_capability_allows(org_id, 'admin.audit_view', auth.uid()). The
--      org-level predicate (which rows count as the authority trail) is
--      copied verbatim; document-level history stays readable by every
--      member exactly as before.
--
-- WIDENING (DEC-2): an Admin may now widen the trail's readers — a token the
-- page never allowed, or a per-person grant — so the pre-apply inventory is
-- captured FIRST, outside the transaction, and returned with the probes.
-- On apply nothing changes for anyone: no org stores an admin.audit_view
-- entry yet (probe below), so every org evaluates to the shipped default,
-- which is byte-identical to the list the overlay hardcoded.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
CREATE TEMP TABLE rp_round_e_63_before AS
SELECT 'BEFORE: active members who can read the org-level audit trail (hold any of the five roles)' AS inventory, COUNT(*)::text AS n
  FROM org_members
 WHERE status = 'active' AND (role = ANY(ARRAY['Admin','Manager','Supervisor','DocCtrl','Auditor']::text[]) OR roles && ARRAY['Admin','Manager','Supervisor','DocCtrl','Auditor']::text[])
UNION ALL
SELECT 'BEFORE: stored policies already carrying an admin.audit_view entry (expect 0)', COUNT(*)::text
  FROM org_configurations
 WHERE key = 'capability_policy' AND COALESCE(data->'caps', data) ? 'admin.audit_view'
UNION ALL
SELECT 'BEFORE: live per-person grants of admin.audit_view (expect 0)', COUNT(*)::text
  FROM org_configurations c,
       jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
 WHERE c.key = 'capability_policy' AND g->>'cap' = 'admin.audit_view';

BEGIN;

-- ── 1. the evaluator learns the new capability's shipped default ────────────
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
      WHEN 'admin.audit_view'         THEN '["Admin","Manager","Supervisor","DocCtrl","Auditor"]'::jsonb
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

-- ── 2. the audit trail overlay reads the policy ─────────────────────────────
DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    org_capability_allows(org_id, 'admin.audit_view', auth.uid())
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
  );

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 6 ─────────
SELECT 'evaluator carries the admin.audit_view default (five roles, in order)' AS check,
       (SELECT prosrc LIKE '%WHEN ''admin.audit_view''         THEN ''["Admin","Manager","Supervisor","DocCtrl","Auditor"]''::jsonb%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4)::text AS result
UNION ALL
SELECT 'evaluator still reads the four resource keys and every earlier default',
       (SELECT prosrc LIKE '%''requestType'', ''unit'', ''libraryId'', ''discipline''%'
              AND prosrc LIKE '%admin.archive_view%' AND prosrc LIKE '%checkout.force_release%' AND prosrc LIKE '%ticket.assign%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4)::text
UNION ALL
SELECT 'the 3-argument wrapper is untouched and still delegates with an empty resource',
       (SELECT prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'
          FROM pg_proc WHERE proname = 'org_capability_allows' AND pronargs = 3)::text
UNION ALL
SELECT 'audit_logs_admin_trail is RESTRICTIVE SELECT and reads admin.audit_view through the policy evaluator',
       (SELECT permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
              AND qual LIKE '%org_capability_allows(org_id, ''admin.audit_view''%'
              AND qual NOT LIKE '%caller_holds_any_role%'
          FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail')::text
UNION ALL
SELECT 'the overlay keeps the org-level predicate (document history stays member-readable)',
       (SELECT qual LIKE '%capability_policy%' AND qual LIKE '%export_destination%'
              AND qual LIKE '%CAPABILITY_%' AND qual LIKE '%RESTORE_%' AND qual LIKE '%PURGE_%'
          FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail')::text
UNION ALL
SELECT 'search_path pinned on both evaluator entry points',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('org_capability_allows', 'org_capability_allows_for')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%')::text
UNION ALL
SELECT inventory, n FROM rp_round_e_63_before
UNION ALL
SELECT 'AFTER: active members who can read the org-level audit trail (default list, no org overrides it yet)', COUNT(*)::text
  FROM org_members
 WHERE status = 'active' AND (role = ANY(ARRAY['Admin','Manager','Supervisor','DocCtrl','Auditor']::text[]) OR roles && ARRAY['Admin','Manager','Supervisor','DocCtrl','Auditor']::text[])
UNION ALL
SELECT 'AFTER: org-level authority-trail rows now behind the policy-driven overlay', COUNT(*)::text
  FROM audit_logs
 WHERE COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
    OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
    OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
    OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%';
