-- ─────────────────────────────────────────────────────────────────────────────
-- DB-1 + DB-2: fix the two column-name typos that made SECURITY DEFINER
-- functions raise 42703 at first execution.
--
-- Both functions live in 20260901_db_hard_enforcement.sql. plpgsql bodies are
-- not column-checked at CREATE time, so 20260901 applied cleanly and failed at
-- first use. CREATE OR REPLACE below repairs the bodies whether or not the
-- surrounding policies exist:
--   · if 20260901's policies ARE installed, this immediately makes them work;
--   · if they are NOT, these corrected functions simply sit unused until the
--     rest of 20260901 is applied — this migration activates nothing on its own.
--
-- ⚠ APPLY ORDER: run 20261024 (the roles backfill) FIRST. org_capability_allows
-- reads COALESCE(roles, ARRAY[role]); against an un-backfilled empty roles[]
-- the checkout.force_release check would refuse an Admin whose roles[] is empty.
-- The backfill removes that. (Holds default to '*', so they are unaffected
-- either way.)
--
-- DB-1: org_capability_allows read `value`; the column is `data`
--       (org_configurations is id, org_id, key, data, updated_at). The app
--       twin (lib/capabilityPolicy.ts) is fixed to `data` in the same change,
--       so both layers read the same column.
-- DB-2: acl_index_denies compared `team_members.user_id` (does not exist) to
--       p_uid::text; the column is `uid` (uuid). Fixed to `tm.uid = p_uid`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── DB-1: capability policy reads `data`, not `value` ───────────────────────
CREATE OR REPLACE FUNCTION org_capability_allows(p_org UUID, p_cap TEXT, p_uid UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_val JSONB;
  v_tokens JSONB;
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

  -- was: SELECT value INTO v_val ...  (phantom column → 42703)
  SELECT data INTO v_val FROM org_configurations
  WHERE org_id = p_org AND key = 'capability_policy';

  v_tokens := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);
  IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' THEN
    v_tokens := CASE p_cap
      WHEN 'holds.open' THEN '["*"]'::jsonb
      WHEN 'holds.release' THEN '["*"]'::jsonb
      WHEN 'checkout.force_release' THEN '["Admin","DocCtrl"]'::jsonb
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

-- ── DB-2: team deny check reads team_members.uid, not user_id ───────────────
CREATE OR REPLACE FUNCTION acl_index_denies(p_idx JSONB, p_org UUID, p_uid UUID, p_action TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_roles TEXT[];
BEGIN
  IF p_idx IS NULL THEN RETURN FALSE; END IF;
  IF p_idx->'deny'->'users'->p_action ? p_uid::text THEN RETURN TRUE; END IF;
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
  FROM org_members WHERE org_id = p_org AND uid = p_uid AND status = 'active' LIMIT 1;
  IF v_roles IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_roles) r
    WHERE p_idx->'deny'->'roles'->p_action ? r
  ) THEN RETURN TRUE; END IF;
  -- was: WHERE tm.user_id = p_uid::text  (phantom column → 42703)
  IF EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.uid = p_uid
      AND p_idx->'deny'->'teams'->p_action ? tm.team_id::text
  ) THEN RETURN TRUE; END IF;
  RETURN FALSE;
END;
$$;
