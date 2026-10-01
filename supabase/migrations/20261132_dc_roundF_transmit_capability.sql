-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 2 — P7 TRANSMITTALS (1 of 2): transmit
-- authority becomes a capability the database can read (TRX-1, DEC-13,
-- DEC-35).
--
--   org_capability_allows_for: the body from 20261063 (the newest
--   re-creation — 20261052 + the DEC-13 stage-3 row + admin.audit_view)
--   VERBATIM plus ONE line in the shipped-default CASE —
--     WHEN 'transmittal.issue' THEN ["Admin","DocCtrl"]
--   the list the transmittals UPDATE policy (is_org_controller) and the
--   email route named until now. lib/capabilityPolicy.ts CAPABILITY_DEFS
--   carries the same default; a shape test pins this body against 20261063
--   line by line and the CASE against CAPABILITY_DEFS. The 3-argument wrapper
--   org_capability_allows is untouched.
--
-- On its own this file changes nobody's authority: nothing reads
-- 'transmittal.issue' until 20261133 (the transmittal rails) is applied, and
-- every org that never stored an entry evaluates to the default. Apply THIS
-- FILE FIRST — 20261133's trigger asks the evaluator for this capability, and
-- an evaluator without the row answers the CASE's ELSE '[]' (nobody may issue).
--
-- The pre-apply inventory (aggregate counts only) is captured BEFORE the
-- transaction and returned with the probes: stored policies / grants that
-- already name the capability (expect 0 — the id is new), and the AFTER rows
-- ask the re-created evaluator who it admits and how many members' answer
-- differs from the controller pair the policies hardcoded (expect 0).
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS dc_round_f_132_before;
CREATE TEMP TABLE dc_round_f_132_before AS
SELECT 'BEFORE: active members holding Admin or DocCtrl (the controller pair the transmittal policies name today)' AS inventory, COUNT(*)::text AS n
  FROM org_members
 WHERE status = 'active' AND (role = ANY(ARRAY['Admin','DocCtrl']::text[]) OR roles && ARRAY['Admin','DocCtrl']::text[])
UNION ALL
SELECT 'BEFORE: stored policies already carrying a transmittal.issue entry (expect 0)', COUNT(*)::text
  FROM org_configurations
 WHERE key = 'capability_policy' AND COALESCE(data->'caps', data) ? 'transmittal.issue'
UNION ALL
SELECT 'BEFORE: live per-person grants of transmittal.issue (expect 0)', COUNT(*)::text
  FROM org_configurations c,
       jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g
 WHERE c.key = 'capability_policy' AND g->>'cap' = 'transmittal.issue';

BEGIN;

-- ── the evaluator learns the transmit capability's shipped default ─────────
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

-- ── Verification + inventory (ONE result set): expect ok = true × 4 ─────────
SELECT 'evaluator carries the transmittal.issue default (Admin, DocCtrl)' AS check,
       (SELECT prosrc LIKE '%WHEN ''transmittal.issue''        THEN ''["Admin","DocCtrl"]''::jsonb%'
          FROM pg_proc WHERE proname = 'org_capability_allows_for' AND pronargs = 4) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'evaluator still reads the four resource keys and every earlier default',
       (SELECT prosrc LIKE '%''requestType'', ''unit'', ''libraryId'', ''discipline''%'
              AND prosrc LIKE '%admin.audit_view%' AND prosrc LIKE '%admin.archive_view%'
              AND prosrc LIKE '%checkout.force_release%' AND prosrc LIKE '%ticket.engineer_gate_exempt%'
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
SELECT inventory, NULL::boolean, n FROM dc_round_f_132_before
UNION ALL
SELECT 'AFTER: active members the re-created evaluator admits to transmittal.issue', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active' AND org_capability_allows_for(m.org_id, 'transmittal.issue', m.uid, '{}'::jsonb)
UNION ALL
SELECT 'AFTER: active members whose controller-pair answer differs from the evaluator (expect 0 - the default is the pair)', NULL::boolean, COUNT(*)::text
  FROM org_members m
 WHERE m.status = 'active'
   AND (m.role = ANY(ARRAY['Admin','DocCtrl']::text[]) OR m.roles && ARRAY['Admin','DocCtrl']::text[])
       <> org_capability_allows_for(m.org_id, 'transmittal.issue', m.uid, '{}'::jsonb);
