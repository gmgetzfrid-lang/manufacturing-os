-- 20261103_prj_roundG_project_closeout_rails.sql
--
-- projects Round G — J8 PROJECT-MODEL, migration 2 of 2: closing a project
-- means something, reopening it is a controller's audited act, and deleting
-- one can no longer silently destroy its cost and quality record.
--
--   1. PM-1 dw2 — the closed-project freeze. enforce_project_record_guard is
--      a BEFORE INSERT / UPDATE / DELETE trigger on the project's regulated
--      record: cost_entries, change_orders, cost_documents, cost_accounts,
--      project_checklists, checklist_items (through its checklist),
--      turnover_items, punch_items, milestones. For a signed-in caller a
--      write is refused while the row's project is completed / cancelled /
--      archived. The service role (auth.uid() IS NULL — the cron, the intake
--      door) keeps its pass, as every guard in this house does; the intake
--      door's own closed-project refusal is projects-and-cost PC-1 / J1.
--   2. PM-1 dw3 — reopen_project(project, reason): SECURITY DEFINER,
--      CONTROLLER-only (a project owner cannot reopen their own closed
--      project), reason required; sets status 'active', CLEARS
--      completed_at / cancelled_at / cancelled_reason, writes the feed row
--      and the PROJECT_REOPENED audit row (the previous status and the
--      cleared values in its details) — one transaction.
--      enforce_project_lifecycle_guard (BEFORE UPDATE on projects) refuses
--      any other way out of a closed status: only the reopen RPC sets
--      app.project_reopen = 'project:<id>' for the one project it reopens.
--      It also keeps projects.legal_hold a controller's switch.
--   3. PM-6 / QUAL-3 / SEC-9 (decision part) — deleting a project:
--      · projects.legal_hold BOOLEAN NOT NULL DEFAULT false (QUAL-3 dw4, the
--        minimal form: the project-level hold reaches the quality record);
--      · enforce_project_delete_guard (BEFORE DELETE on projects) refuses a
--        held project always, and a project carrying ANY cost or quality
--        row unless the audited purge set app.record_purge = 'project:<id>'
--        (the GUC contract shared with projects-and-cost PC-7 / J3's money
--        delete guards — the same name, exactly). An org's own deletion
--        (the org row already gone) passes: the org's rail decides;
--      · the same trigger function as 1 refuses a DIRECT delete of a
--        regulated row whose project is under legal hold (the 20260826
--        shape, applied to everyone), and honours the purge GUC and an FK
--        cascade from its project's own delete;
--      · delete_project_record(project, reason): SECURITY DEFINER; owner or
--        controller; refuses a held project; a project carrying cost /
--        quality rows is deleted only by a CONTROLLER with a REASON (the
--        default is Archive); counts every table, snapshots the cost and
--        quality rows, records the cost documents' storage keys for the
--        orphan sweep (PM-6 dw5 — the collector is admin-and-org BKP-2 /
--        intelligence ILIFE-1; this only records the keys), revokes the
--        project's contractor intake links (PM-2's inline limb — PC-1 / J1
--        owns the shared helper), writes PROJECT_DELETED with all of it, and
--        only then deletes — children in an order that fires no ON DELETE
--        SET NULL update on a guarded row, then the schedule, then the
--        project. One transaction: a refusal strips nothing.
--      · project_regulated_record_count(project) — the one count both the
--        guard and the RPC use; EXECUTE revoked from every client role.
--
-- DEC-30 inventories (aggregate counts only, captured BEFORE the
-- transaction) come back with the probes:
--   * closed projects (the freeze's reach), and regulated rows on them;
--   * closed projects with ACTIVE project-tied checkouts (PM-4 — the sweep
--     now releases these 24h after closure, lib/projects.ts);
--   * closed projects with un-revoked intake links (PM-1 — the app now
--     revokes on close; the statement at the foot revokes the existing ones
--     once reviewed);
--   * projects carrying cost / quality rows (PM-6 — the delete guard's
--     blast radius: each of these can now only be archived, or deleted by
--     a controller with a reason).
--
-- HOW TO APPLY: after 20261102. Paste the whole file into the Supabase SQL
-- editor and run it once (a re-run is safe: every trigger / function is
-- dropped or replaced first and the temp table is dropped before it is
-- rebuilt). The final SELECT is the only result set shown — probe rows must
-- read ok = true; inventory rows carry ok NULL and a count in n.

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j8_closeout_inventory;
CREATE TEMP TABLE prj_g_j8_closeout_inventory AS
SELECT 'inventory (before): closed projects (completed / cancelled / archived) — the freeze''s reach' AS inventory,
       COUNT(*)::text AS n
  FROM projects WHERE status IN ('completed', 'cancelled', 'archived')
UNION ALL
SELECT 'inventory (before): cost / quality / schedule rows on closed projects (read-only after apply)',
       ((SELECT COUNT(*) FROM cost_entries x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM change_orders x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM cost_documents x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM cost_accounts x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM project_checklists x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM checklist_items i JOIN project_checklists x ON x.id = i.checklist_id JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM turnover_items x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM punch_items x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived'))
      + (SELECT COUNT(*) FROM milestones x JOIN projects p ON p.id = x.project_id WHERE p.status IN ('completed', 'cancelled', 'archived')))::text
UNION ALL
SELECT 'inventory (before): active project-tied checkouts on closed projects (PM-4)', COUNT(*)::text
  FROM checkout_sessions s JOIN projects p ON p.id = s.project_id
 WHERE s.status = 'active' AND p.status IN ('completed', 'cancelled', 'archived')
UNION ALL
SELECT 'inventory (before): closed projects with un-revoked contractor intake links (PM-1)', COUNT(DISTINCT p.id)::text
  FROM projects p JOIN project_intake_links l ON l.project_id = p.id
 WHERE p.status IN ('completed', 'cancelled', 'archived') AND l.revoked_at IS NULL
UNION ALL
SELECT 'inventory (before): projects carrying cost / quality rows — archive-only, or a controller''s reasoned delete (PM-6)', COUNT(*)::text
  FROM projects p
 WHERE EXISTS (SELECT 1 FROM cost_accounts x WHERE x.project_id = p.id)
    OR EXISTS (SELECT 1 FROM cost_entries x WHERE x.project_id = p.id)
    OR EXISTS (SELECT 1 FROM cost_documents x WHERE x.project_id = p.id)
    OR EXISTS (SELECT 1 FROM change_orders x WHERE x.project_id = p.id)
    OR EXISTS (SELECT 1 FROM project_checklists x WHERE x.project_id = p.id)
    OR EXISTS (SELECT 1 FROM turnover_items x WHERE x.project_id = p.id)
    OR EXISTS (SELECT 1 FROM punch_items x WHERE x.project_id = p.id);

BEGIN;

-- ── 3a. the project-level legal hold (QUAL-3 dw4, minimal form) ─────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN projects.legal_hold IS
  'QUAL-3: while true the project and every cost / quality row under it refuse deletion — for everyone (20261103). Set and cleared by Admin / Document Control only.';

-- ── the one count of a project's regulated (cost + quality) record ──────────
CREATE OR REPLACE FUNCTION project_regulated_record_count(p_project uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (SELECT COUNT(*) FROM cost_accounts WHERE project_id = p_project)
       + (SELECT COUNT(*) FROM cost_entries WHERE project_id = p_project)
       + (SELECT COUNT(*) FROM cost_documents WHERE project_id = p_project)
       + (SELECT COUNT(*) FROM change_orders WHERE project_id = p_project)
       + (SELECT COUNT(*) FROM project_checklists WHERE project_id = p_project)
       + (SELECT COUNT(*) FROM checklist_items i JOIN project_checklists c ON c.id = i.checklist_id WHERE c.project_id = p_project)
       + (SELECT COUNT(*) FROM turnover_items WHERE project_id = p_project)
       + (SELECT COUNT(*) FROM punch_items WHERE project_id = p_project);
$$;
REVOKE ALL ON FUNCTION project_regulated_record_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION project_regulated_record_count(uuid) FROM anon;
REVOKE ALL ON FUNCTION project_regulated_record_count(uuid) FROM authenticated;

-- ── 1 + 3c. the regulated record: frozen when closed, kept when held ────────
CREATE OR REPLACE FUNCTION enforce_project_record_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old     jsonb;
  v_new     jsonb;
  v_old_pid uuid;
  v_new_pid uuid;
  v_pid     uuid;
  v_status  text;
  v_hold    boolean;
  v_purge   text := COALESCE(current_setting('app.record_purge', true), '');
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  -- The project a row belongs to; a checklist item through its checklist.
  IF TG_TABLE_NAME = 'checklist_items' THEN
    IF v_old IS NOT NULL THEN
      SELECT project_id INTO v_old_pid FROM project_checklists WHERE id = NULLIF(v_old->>'checklist_id', '')::uuid;
    END IF;
    IF v_new IS NOT NULL THEN
      SELECT project_id INTO v_new_pid FROM project_checklists WHERE id = NULLIF(v_new->>'checklist_id', '')::uuid;
    END IF;
  ELSE
    v_old_pid := NULLIF(v_old->>'project_id', '')::uuid;
    v_new_pid := NULLIF(v_new->>'project_id', '')::uuid;
  END IF;

  -- Every project the write touches (a move names two).
  FOREACH v_pid IN ARRAY ARRAY[v_old_pid, v_new_pid] LOOP
    CONTINUE WHEN v_pid IS NULL;
    -- The audited purge of THIS project (delete_project_record) passes.
    CONTINUE WHEN v_purge = 'project:' || v_pid::text;
    SELECT status, legal_hold INTO v_status, v_hold FROM projects WHERE id = v_pid;
    -- An FK cascade from the project's own delete: its rail already decided.
    CONTINUE WHEN NOT FOUND;
    IF TG_OP = 'DELETE' AND COALESCE(v_hold, false) THEN
      RAISE EXCEPTION 'This record belongs to a project under a legal hold and cannot be deleted. Release the hold first. (QUAL-3, 20261103)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_status IN ('completed', 'cancelled', 'archived') AND auth.uid() IS NOT NULL THEN
      RAISE EXCEPTION 'This project is % — its cost, quality and schedule records are read-only. An Admin / Document Control can reopen it. (PM-1, 20261103)', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_project_record_guard() IS
  'PM-1 / QUAL-3 (20261103): a signed-in caller cannot write a regulated row of a completed / cancelled / archived project; nobody deletes one under a project legal hold. The purge GUC (app.record_purge = project:<id>) and an FK cascade from the project''s own delete pass.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_entries', 'change_orders', 'cost_documents', 'cost_accounts',
                           'project_checklists', 'checklist_items', 'turnover_items', 'punch_items', 'milestones'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_project_record_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_project_record_guard()',
                   'trg_' || t || '_project_record_guard', t);
  END LOOP;
END $$;

-- ── 2 + 3a. the project row: out of a closed status only by reopen; the hold is a controller's
CREATE OR REPLACE FUNCTION enforce_project_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- The service role (restores, maintenance) keeps its pass.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.legal_hold IS DISTINCT FROM OLD.legal_hold AND NOT is_org_controller(OLD.org_id) THEN
    RAISE EXCEPTION 'Only Admin / Document Control can place or release a legal hold on a project. (QUAL-3, 20261103)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('completed', 'cancelled', 'archived')
     AND NEW.status NOT IN ('completed', 'cancelled', 'archived')
     AND COALESCE(current_setting('app.project_reopen', true), '') <> 'project:' || OLD.id::text THEN
    RAISE EXCEPTION 'A closed project is reopened only through Reopen — Admin / Document Control, with a reason. (PM-1, 20261103)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_lifecycle_guard ON projects;
CREATE TRIGGER trg_projects_lifecycle_guard
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION enforce_project_lifecycle_guard();

-- ── 3b. deleting the project row ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_project_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n bigint;
BEGIN
  -- 20260826 shape: a held record is deleted by nobody, cascades included.
  IF OLD.legal_hold THEN
    RAISE EXCEPTION 'This project is under a legal hold and cannot be deleted. Release the hold first. (QUAL-3, 20261103)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The audited purge of THIS project.
  IF COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.id::text THEN
    RETURN OLD;
  END IF;
  -- The org's own deletion takes its projects with it; the org's rail decides.
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RETURN OLD;
  END IF;
  v_n := project_regulated_record_count(OLD.id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'This project carries % cost / quality record(s) and cannot be deleted directly — archive it, or (Admin / Document Control) delete it with a reason through delete_project_record. (PM-6, 20261103)', v_n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_delete_guard ON projects;
CREATE TRIGGER trg_projects_delete_guard
  BEFORE DELETE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION enforce_project_delete_guard();

-- ── 3d. the counting, auditing, one-transaction delete ──────────────────────
CREATE OR REPLACE FUNCTION delete_project_record(p_project uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_proj       projects%ROWTYPE;
  v_controller boolean;
  v_reason     text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_regulated  bigint;
  v_counts     jsonb;
  v_snapshot   jsonb;
  v_keys       jsonb;
  v_links      integer := 0;
  v_email      text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sign in to delete a project.';
  END IF;
  SELECT * INTO v_proj FROM projects WHERE id = p_project FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found.';
  END IF;
  v_controller := is_org_controller(v_proj.org_id);
  IF NOT (v_controller OR user_owns_project(p_project)) THEN
    RAISE EXCEPTION 'Only the project owner or an Admin / Document Control can delete a project.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_proj.legal_hold THEN
    RAISE EXCEPTION 'This project is under a legal hold and cannot be deleted. Release the hold first.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_regulated := project_regulated_record_count(p_project);
  IF v_regulated > 0 AND NOT v_controller THEN
    RAISE EXCEPTION 'This project carries % cost / quality record(s). It cannot be deleted — archive it instead (only Admin / Document Control may delete it, with a reason).', v_regulated
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_regulated > 0 AND v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to delete a project that carries cost / quality records.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_counts := jsonb_build_object(
    'costAccounts',   (SELECT COUNT(*) FROM cost_accounts WHERE project_id = p_project),
    'costEntries',    (SELECT COUNT(*) FROM cost_entries WHERE project_id = p_project),
    'costDocuments',  (SELECT COUNT(*) FROM cost_documents WHERE project_id = p_project),
    'changeOrders',   (SELECT COUNT(*) FROM change_orders WHERE project_id = p_project),
    'parties',        (SELECT COUNT(*) FROM project_parties WHERE project_id = p_project),
    'checklists',     (SELECT COUNT(*) FROM project_checklists WHERE project_id = p_project),
    'checklistItems', (SELECT COUNT(*) FROM checklist_items i JOIN project_checklists c ON c.id = i.checklist_id WHERE c.project_id = p_project),
    'turnoverItems',  (SELECT COUNT(*) FROM turnover_items WHERE project_id = p_project),
    'punchItems',     (SELECT COUNT(*) FROM punch_items WHERE project_id = p_project),
    'documentLinks',  (SELECT COUNT(*) FROM project_documents WHERE project_id = p_project),
    'milestones',     (SELECT COUNT(*) FROM milestones WHERE project_id = p_project),
    'members',        (SELECT COUNT(*) FROM project_members WHERE project_id = p_project),
    'activity',       (SELECT COUNT(*) FROM project_activity WHERE project_id = p_project));

  -- What was destroyed, recoverable from the audit row.
  v_snapshot := jsonb_build_object(
    'project',        to_jsonb(v_proj),
    'changeOrders',   COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM change_orders x WHERE x.project_id = p_project), '[]'::jsonb),
    'checklists',     COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM project_checklists x WHERE x.project_id = p_project), '[]'::jsonb),
    'checklistItems', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM checklist_items i JOIN project_checklists c ON c.id = i.checklist_id WHERE c.project_id = p_project), '[]'::jsonb),
    'turnoverItems',  COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM turnover_items x WHERE x.project_id = p_project), '[]'::jsonb),
    'punchItems',     COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM punch_items x WHERE x.project_id = p_project), '[]'::jsonb),
    'costAccounts',   COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM cost_accounts x WHERE x.project_id = p_project), '[]'::jsonb),
    'costEntries',    COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM cost_entries x WHERE x.project_id = p_project), '[]'::jsonb),
    'costDocuments',  COALESCE((SELECT jsonb_agg(to_jsonb(x) - 'parsed') FROM cost_documents x WHERE x.project_id = p_project), '[]'::jsonb),
    'parties',        COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM project_parties x WHERE x.project_id = p_project), '[]'::jsonb));

  -- PM-6 dw5: the storage keys the deleted cost documents leave behind, for
  -- the orphan sweep (recorded here; collected elsewhere).
  v_keys := COALESCE((SELECT jsonb_agg(DISTINCT x.file_url) FROM cost_documents x
                       WHERE x.project_id = p_project AND x.file_url IS NOT NULL), '[]'::jsonb);

  -- PM-2 (inline limb): the contractor door closes with the project.
  UPDATE project_intake_links SET revoked_at = NOW()
   WHERE project_id = p_project AND revoked_at IS NULL;
  GET DIAGNOSTICS v_links = ROW_COUNT;

  SELECT email INTO v_email FROM org_members WHERE org_id = v_proj.org_id AND uid = v_actor LIMIT 1;
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  VALUES ('PROJECT_DELETED', p_project::text, 'project', v_proj.org_id, v_actor, v_email,
          jsonb_build_object('name', v_proj.name, 'reason', v_reason, 'counts', v_counts,
                             'regulatedRecords', v_regulated, 'revokedIntakeLinks', v_links,
                             'orphanedStorageKeys', v_keys, 'snapshot', v_snapshot,
                             'path', 'delete_project_record'));

  -- The purge: children first, in an order that fires no ON DELETE SET NULL
  -- update on a guarded row, then the schedule, then the project (its roster,
  -- feed and register cascade; checkouts, markups, notes and transmittals are
  -- kept, unlinked).
  PERFORM set_config('app.record_purge', 'project:' || p_project::text, true);
  DELETE FROM checklist_items i USING project_checklists c WHERE c.id = i.checklist_id AND c.project_id = p_project;
  DELETE FROM project_checklists WHERE project_id = p_project;
  DELETE FROM turnover_items WHERE project_id = p_project;
  DELETE FROM punch_items WHERE project_id = p_project;
  DELETE FROM cost_entries WHERE project_id = p_project;
  DELETE FROM change_orders WHERE project_id = p_project;
  DELETE FROM cost_documents WHERE project_id = p_project;
  DELETE FROM cost_accounts WHERE project_id = p_project;
  DELETE FROM project_parties WHERE project_id = p_project;
  DELETE FROM milestones WHERE project_id = p_project;
  DELETE FROM projects WHERE id = p_project;
  PERFORM set_config('app.record_purge', '', true);

  RETURN jsonb_build_object('projectId', p_project, 'counts', v_counts, 'regulatedRecords', v_regulated,
                            'revokedIntakeLinks', v_links);
END;
$$;

REVOKE ALL ON FUNCTION delete_project_record(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_project_record(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION delete_project_record(uuid, text) TO authenticated;

-- ── 2. reopening: a controller's audited act ────────────────────────────────
CREATE OR REPLACE FUNCTION reopen_project(p_project uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_proj   projects%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_email  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sign in to reopen a project.';
  END IF;
  SELECT * INTO v_proj FROM projects WHERE id = p_project FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found.';
  END IF;
  IF NOT is_org_controller(v_proj.org_id) THEN
    RAISE EXCEPTION 'Only Admin / Document Control can reopen a closed project.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_proj.status NOT IN ('completed', 'cancelled', 'archived') THEN
    RAISE EXCEPTION 'This project is % — it is not closed.', v_proj.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reopen a closed project.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.project_reopen', 'project:' || p_project::text, true);
  UPDATE projects
     SET status = 'active', completed_at = NULL, cancelled_at = NULL, cancelled_reason = NULL,
         updated_at = NOW(), updated_by = v_actor
   WHERE id = p_project;
  PERFORM set_config('app.project_reopen', '', true);

  SELECT email INTO v_email FROM org_members WHERE org_id = v_proj.org_id AND uid = v_actor LIMIT 1;
  INSERT INTO project_activity (project_id, org_id, user_id, user_name, type, body, metadata)
  VALUES (p_project, v_proj.org_id, v_actor, v_email, 'status_changed', 'Project reopened: ' || v_reason,
          jsonb_build_object('fromStatus', v_proj.status, 'toStatus', 'active', 'reason', v_reason));
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  VALUES ('PROJECT_REOPENED', p_project::text, 'project', v_proj.org_id, v_actor, v_email,
          jsonb_build_object('fromStatus', v_proj.status, 'reason', v_reason,
                             'clearedCompletedAt', v_proj.completed_at, 'clearedCancelledAt', v_proj.cancelled_at,
                             'clearedCancelledReason', v_proj.cancelled_reason));

  RETURN jsonb_build_object('projectId', p_project, 'fromStatus', v_proj.status, 'status', 'active');
END;
$$;

REVOKE ALL ON FUNCTION reopen_project(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reopen_project(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION reopen_project(uuid, text) TO authenticated;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'QUAL-3: projects.legal_hold exists, NOT NULL, default false' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'legal_hold'
                  AND is_nullable = 'NO' AND column_default = 'false') AS ok, NULL::text AS n
UNION ALL SELECT 'PM-1: the record guard is on all nine regulated tables (BEFORE INSERT / UPDATE / DELETE)',
       (SELECT COUNT(*) = 9 FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
         WHERE NOT t.tgisinternal AND f.proname = 'enforce_project_record_guard'
           AND t.tgname = 'trg_' || t.tgrelid::regclass::text || '_project_record_guard'), NULL
UNION ALL SELECT 'PM-1: the record guard refuses a signed-in write on a closed project and honours the purge GUC',
       (SELECT prosrc LIKE '%(''completed'', ''cancelled'', ''archived'')%' AND prosrc LIKE '%auth.uid() IS NOT NULL%'
               AND prosrc LIKE '%app.record_purge%' AND prosrc LIKE '%legal_hold%'
          FROM pg_proc WHERE proname = 'enforce_project_record_guard' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT 'PM-1: a closed project leaves its closed status only through reopen_project',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_lifecycle_guard' AND tgrelid = 'public.projects'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%app.project_reopen%' FROM pg_proc WHERE proname = 'enforce_project_lifecycle_guard' AND pronamespace = 'public'::regnamespace)
       AND (SELECT prosrc LIKE '%app.project_reopen%' AND prosrc LIKE '%is_org_controller(v_proj.org_id)%'
                   AND prosrc LIKE '%completed_at = NULL, cancelled_at = NULL, cancelled_reason = NULL%'
                   AND prosrc LIKE '%PROJECT_REOPENED%'
              FROM pg_proc WHERE proname = 'reopen_project' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT 'PM-6: a project carrying records refuses a direct delete — the purge GUC is the one pass',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_delete_guard' AND tgrelid = 'public.projects'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%app.record_purge%' AND prosrc LIKE '%project_regulated_record_count(OLD.id)%' AND prosrc LIKE '%OLD.legal_hold%'
              FROM pg_proc WHERE proname = 'enforce_project_delete_guard' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT 'PM-6: delete_project_record audits counts, snapshot and storage keys BEFORE it deletes',
       (SELECT prosrc LIKE '%PROJECT_DELETED%' AND prosrc LIKE '%''counts''%' AND prosrc LIKE '%''snapshot''%'
               AND prosrc LIKE '%''orphanedStorageKeys''%' AND prosrc LIKE '%UPDATE project_intake_links SET revoked_at%'
               AND strpos(prosrc, 'INSERT INTO audit_logs') < strpos(prosrc, 'DELETE FROM projects')
          FROM pg_proc WHERE proname = 'delete_project_record' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT 'the two RPCs are callable by a signed-in member, not by anon — the record count is callable by neither',
       has_function_privilege('authenticated', 'public.delete_project_record(uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.delete_project_record(uuid, text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.reopen_project(uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.reopen_project(uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.project_regulated_record_count(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.project_regulated_record_count(uuid)', 'EXECUTE'), NULL
UNION ALL SELECT 'every function this file defines is SECURITY DEFINER with search_path pinned',
       (SELECT COUNT(*) = 6 FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname IN ('project_regulated_record_count', 'enforce_project_record_guard', 'enforce_project_lifecycle_guard',
                           'enforce_project_delete_guard', 'delete_project_record', 'reopen_project')
           AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_j8_closeout_inventory;

-- ── PM-1 follow-up — paste on its own AFTER reviewing the inventory row
-- "closed projects with un-revoked contractor intake links". The app now
-- revokes a project's links when it closes; this revokes the ones left open
-- by closures made before that, and records each revocation:
--
-- WITH revoked AS (
--   UPDATE project_intake_links l SET revoked_at = NOW()
--     FROM projects p
--    WHERE p.id = l.project_id AND l.revoked_at IS NULL
--      AND p.status IN ('completed', 'cancelled', 'archived')
--   RETURNING l.id, l.org_id, l.project_id
-- )
-- INSERT INTO audit_logs (action, resource_id, resource_type, org_id, details)
-- SELECT 'INTAKE_LINK_REVOKED', id::text, 'project_intake_link', org_id,
--        jsonb_build_object('reason', 'project closed (20261103 follow-up)', 'projectId', project_id)
--   FROM revoked;
