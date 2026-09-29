-- 20261099_prj_roundG_baseline_authority.sql
--
-- projects Round G — PC SCHED-3 / PT SAF-7: the approved baseline gets a rail.
--
--   * Authority at the data layer: set_project_baseline / clear_project_
--     baseline (SECURITY DEFINER) enforce can_edit_project_schedule (20261098)
--     — the same predicate apply_milestone_moves enforces — and refuse the
--     anon key the same way. EXECUTE is revoked from PUBLIC and anon.
--   * Atomicity: each RPC applies the whole project in ONE UPDATE, so a
--     baseline cannot half-apply.
--   * History: milestone_baseline_history keeps every prior snapshot before a
--     re-baseline or a clear overwrites it (SAF-7's "irreversible").
--   * Audit: SCHEDULE_BASELINED / SCHEDULE_BASELINE_CLEARED are written by the
--     RPCs themselves with the row count and the history id.
--   * The rail: a BEFORE UPDATE trigger on milestones refuses a direct write
--     to any baseline_* column outside those RPCs (milestones_member_all is a
--     permissive FOR ALL, so a second policy would be decorative — DRLS-1).
--
-- NOT widening: nobody gains a write they did not have; every active member
-- LOSES the direct baseline write. Apply after 20261098.

-- ── DEC-30 inventory, captured BEFORE the transaction ─────────────────────
CREATE TEMP TABLE prj_roundg_baseline_inventory AS
SELECT 'inventory: projects with a baseline on some but not all leaf rows (half-applied)' AS check,
       COUNT(*)::text AS n
  FROM (
    SELECT m.project_id
      FROM milestones m
     WHERE m.project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM milestones c WHERE c.parent_id = m.id)
     GROUP BY m.project_id
    HAVING COUNT(*) FILTER (WHERE m.baseline_finish_at IS NOT NULL) > 0
       AND COUNT(*) FILTER (WHERE m.baseline_finish_at IS NULL) > 0
  ) half
UNION ALL
SELECT 'inventory: projects with any baseline', COUNT(DISTINCT project_id)::text
  FROM milestones WHERE project_id IS NOT NULL AND baseline_finish_at IS NOT NULL;

BEGIN;

-- ── 1. History ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS milestone_baseline_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  taken_by    UUID,
  -- 'rebaseline' → a new baseline replaced this one; 'clear' → it was removed.
  reason      TEXT NOT NULL CHECK (reason IN ('rebaseline', 'clear')),
  row_count   INT NOT NULL,
  -- [{id, baseline_start_at, baseline_finish_at, baseline_set_at, baseline_set_by}, …]
  rows        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS milestone_baseline_history_project_idx
  ON milestone_baseline_history(project_id, taken_at DESC);
COMMENT ON TABLE milestone_baseline_history IS
  'Every prior approved-plan snapshot, written by set_project_baseline / clear_project_baseline before the live baseline_* columns are overwritten.';

ALTER TABLE milestone_baseline_history ENABLE ROW LEVEL SECURITY;
-- Read: active members of the org. Write: the SECURITY DEFINER RPCs only
-- (no INSERT / UPDATE / DELETE policy for any role).
DROP POLICY IF EXISTS milestone_baseline_history_member_read ON milestone_baseline_history;
CREATE POLICY milestone_baseline_history_member_read ON milestone_baseline_history
  FOR SELECT TO authenticated
  USING (caller_is_active_member(org_id));

-- ── 2. The rail: no direct baseline writes ───────────────────────────────
CREATE OR REPLACE FUNCTION milestones_baseline_write_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.baseline_start_at  IS DISTINCT FROM OLD.baseline_start_at
  OR NEW.baseline_finish_at IS DISTINCT FROM OLD.baseline_finish_at
  OR NEW.baseline_set_at    IS DISTINCT FROM OLD.baseline_set_at
  OR NEW.baseline_set_by    IS DISTINCT FROM OLD.baseline_set_by THEN
    -- The RPCs set this transaction-local flag before their UPDATE.
    IF COALESCE(current_setting('app.baseline_rpc', true), '') <> '1' THEN
      RAISE EXCEPTION 'The baseline is set and cleared through set_project_baseline / clear_project_baseline only.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_milestones_baseline_write_guard ON milestones;
CREATE TRIGGER trg_milestones_baseline_write_guard
  BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION milestones_baseline_write_guard();

-- ── 3. set_project_baseline ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_project_baseline(p_org uuid, p_project uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_count INT := 0;
  v_prior_count INT := 0;
  v_prior JSONB := '[]'::jsonb;
  v_history UUID;
BEGIN
  IF v_uid IS NULL THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT caller_is_active_member(p_org) THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
    IF NOT can_edit_project_schedule(p_org, p_project) THEN
      RAISE EXCEPTION 'You do not have schedule-editing rights on this project' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.baseline_rpc', '1', true);

  -- Keep the prior snapshot before overwriting it.
  SELECT COUNT(*),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'baseline_start_at', baseline_start_at, 'baseline_finish_at', baseline_finish_at,
           'baseline_set_at', baseline_set_at, 'baseline_set_by', baseline_set_by)), '[]'::jsonb)
    INTO v_prior_count, v_prior
    FROM milestones
   WHERE org_id = p_org AND project_id = p_project AND baseline_finish_at IS NOT NULL;
  IF v_prior_count > 0 THEN
    INSERT INTO milestone_baseline_history (org_id, project_id, taken_by, reason, row_count, rows)
    VALUES (p_org, p_project, v_uid, 'rebaseline', v_prior_count, v_prior)
    RETURNING id INTO v_history;
  END IF;

  -- One statement: the whole project or nothing.
  UPDATE milestones
     SET baseline_start_at  = COALESCE(planned_start_at, planned_at),
         baseline_finish_at = planned_at,
         baseline_set_at    = NOW(),
         baseline_set_by    = v_uid
   WHERE org_id = p_org AND project_id = p_project;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('SCHEDULE_BASELINED', 'project', p_project::text, p_org, v_uid, NULLIF(auth.jwt() ->> 'email', ''),
          jsonb_build_object('count', v_count, 'previous_rows', v_prior_count, 'history_id', v_history));

  RETURN jsonb_build_object('count', v_count, 'previous_rows', v_prior_count, 'history_id', v_history);
END;
$$;

-- ── 4. clear_project_baseline ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION clear_project_baseline(p_org uuid, p_project uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_count INT := 0;
  v_prior_count INT := 0;
  v_prior JSONB := '[]'::jsonb;
  v_history UUID;
BEGIN
  IF v_uid IS NULL THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT caller_is_active_member(p_org) THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
    IF NOT can_edit_project_schedule(p_org, p_project) THEN
      RAISE EXCEPTION 'You do not have schedule-editing rights on this project' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.baseline_rpc', '1', true);

  SELECT COUNT(*),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'baseline_start_at', baseline_start_at, 'baseline_finish_at', baseline_finish_at,
           'baseline_set_at', baseline_set_at, 'baseline_set_by', baseline_set_by)), '[]'::jsonb)
    INTO v_prior_count, v_prior
    FROM milestones
   WHERE org_id = p_org AND project_id = p_project AND baseline_finish_at IS NOT NULL;
  IF v_prior_count = 0 THEN
    RETURN jsonb_build_object('count', 0, 'previous_rows', 0, 'history_id', NULL);
  END IF;
  INSERT INTO milestone_baseline_history (org_id, project_id, taken_by, reason, row_count, rows)
  VALUES (p_org, p_project, v_uid, 'clear', v_prior_count, v_prior)
  RETURNING id INTO v_history;

  UPDATE milestones
     SET baseline_start_at = NULL, baseline_finish_at = NULL, baseline_set_at = NULL, baseline_set_by = NULL
   WHERE org_id = p_org AND project_id = p_project AND baseline_finish_at IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
  VALUES ('SCHEDULE_BASELINE_CLEARED', 'project', p_project::text, p_org, v_uid, NULLIF(auth.jwt() ->> 'email', ''),
          jsonb_build_object('count', v_count, 'history_id', v_history));

  RETURN jsonb_build_object('count', v_count, 'previous_rows', v_prior_count, 'history_id', v_history);
END;
$$;

REVOKE ALL ON FUNCTION set_project_baseline(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_project_baseline(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION clear_project_baseline(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_project_baseline(uuid, uuid) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (one result set) ────────────────────────────
SELECT 'milestone_baseline_history exists with RLS enabled' AS check,
       EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = 'milestone_baseline_history' AND c.relrowsecurity) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'history: members read, nobody writes through PostgREST (no INSERT/UPDATE/DELETE policy)',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'milestone_baseline_history'
                  AND policyname = 'milestone_baseline_history_member_read' AND cmd = 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'milestone_baseline_history'
                  AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')),
       NULL
UNION ALL
SELECT 'trg_milestones_baseline_write_guard is a BEFORE UPDATE row trigger on milestones',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'milestones' AND t.tgname = 'trg_milestones_baseline_write_guard' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT 'the guard refuses a direct write unless the RPC flag is set',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'milestones_baseline_write_guard'
                  AND p.prosrc LIKE '%current_setting(''app.baseline_rpc'', true)%'),
       NULL
UNION ALL
SELECT 'set_project_baseline: one UPDATE, sets the RPC flag, writes history + audit, enforces can_edit_project_schedule',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'set_project_baseline'
                  AND p.prosrc LIKE '%set_config(''app.baseline_rpc'', ''1'', true)%'
                  AND p.prosrc LIKE '%INSERT INTO milestone_baseline_history%'
                  AND p.prosrc LIKE '%''SCHEDULE_BASELINED''%'
                  AND p.prosrc LIKE '%can_edit_project_schedule(p_org, p_project)%'
                  AND p.prosrc LIKE '%auth.role() IS DISTINCT FROM ''service_role''%'),
       NULL
UNION ALL
SELECT 'clear_project_baseline: audited, history first, same predicate',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'clear_project_baseline'
                  AND p.prosrc LIKE '%''SCHEDULE_BASELINE_CLEARED''%'
                  AND p.prosrc LIKE '%INSERT INTO milestone_baseline_history%'
                  AND p.prosrc LIKE '%can_edit_project_schedule(p_org, p_project)%'),
       NULL
UNION ALL
SELECT 'search_path pinned on the three functions',
       (SELECT bool_and(p.proconfig::text LIKE '%search_path=public%')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('set_project_baseline', 'clear_project_baseline', 'milestones_baseline_write_guard')),
       NULL
UNION ALL
SELECT 'anon can NOT execute the baseline RPCs',
       NOT has_function_privilege('anon', 'public.set_project_baseline(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.clear_project_baseline(uuid,uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'authenticated CAN execute the baseline RPCs',
       has_function_privilege('authenticated', 'public.set_project_baseline(uuid,uuid)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.clear_project_baseline(uuid,uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT check, NULL::boolean, n FROM prj_roundg_baseline_inventory;
