-- 20261102_prj_roundG_project_rails.sql
--
-- projects Round G — J8 PROJECT-MODEL, migration 1 of 2: who may READ a
-- project's controls record, who may WRITE its feed and its document
-- register, and how ownership moves.
--
--   1. SEC-2 (CRITICAL): private projects are private for money and quality
--      data. The member-read policies of the five controls tables
--      (change_orders, project_checklists, checklist_items, turnover_items,
--      punch_items — 20261013 `%I_member_read`) and the four cost tables
--      (project_parties, cost_accounts, cost_documents, cost_entries —
--      20260906 `%I_select`) checked ORG membership only. Each is re-created
--      on project_visible_to_me(project_id) (20260913:40 — the one
--      visibility rule; controllers stay unscoped, DEC-43). checklist_items
--      has no project_id: it reads through its checklist. Write policies are
--      untouched.
--   2. SEC-9: projects_update_owner / projects_delete_owner (20260906:60-68)
--      admitted the owner by owner_user_id alone — an OFFBOARDED owner could
--      still delete the project. Both now also require an ACTIVE membership
--      in the project's org (the user_owns_project shape, 20261013:57). The
--      WITH CHECK still reads the NEW row's owner_user_id, so a plain owner
--      cannot hand the project away with a raw UPDATE — the RPC in 5 is the
--      path (SEC-15).
--   3. PM-7 / PM-9 / PM-11 — project_activity:
--      · project_activity_insert (20260906:117-121) checked only that the
--        caller is an active member of the ROW's org_id. It now requires
--        user_id = auth.uid(), org_id = project_org(project_id), and
--        project_visible_to_me(project_id); a 'comment' needs
--        is_org_controller or can_manage_project (20261047: owner /
--        Admin / Manager / roster owner-or-collaborator — an OBSERVER may
--        read the feed but not post to it, PM-11 dw1); a 'doc_added' /
--        'doc_removed' row needs the register's own authority (controller or
--        active owner — section 4), so nobody can plant a detach record that
--        pulls a document's history into a project's timeline (SAF-17).
--        (The service role bypasses RLS; no branch is needed for it.)
--      · trg_project_activity_stamp (BEFORE INSERT, SECURITY DEFINER) stamps
--        user_id, user_name and created_at from the SESSION for a signed-in
--        caller — the author of a feed row is who wrote it, whatever the
--        client sent (PM-7 dw3). Service-role rows name their own actor.
--      · trg_project_activity_touch_project (AFTER INSERT, SECURITY DEFINER)
--        advances projects.last_activity_at for EVERY author (PM-9: the
--        client UPDATE lib/projects.writeActivity used to make was silently
--        filtered out by RLS for every non-owner; it is gone). One-time
--        backfill below: last_activity_at = the newest activity row.
--      · No UPDATE policy on project_activity (a feed row is never edited).
--   4. PM-8 = SEC-17 = drafting-flow PROJ-3 — project_documents: the one
--      FOR ALL policy (20260609:192-197, any active org member, USING = WITH
--      CHECK) is DROPPED, not supplemented (cluster 3 / DRLS-1). SELECT is
--      project_visible_to_me(project_id); INSERT / UPDATE / DELETE need
--      is_org_controller(org_id) OR is_project_owner(project_id) — the
--      finding's contract and the register card's `canManage` (owner or
--      Admin/DocCtrl), so the UI and the database agree; every written row
--      must carry its project's org (org_id = project_org(project_id)).
--      checkouts_resync_project_documents (20260609:151) is re-created
--      SECURITY DEFINER with search_path pinned, so a COLLABORATOR's checkout
--      under the project still links its document (it runs as the invoker
--      today and would now be refused), and it links only when the session's
--      org is the project's org.
--   5. SEC-15: transfer_project_ownership(project, new_owner, name) —
--      SECURITY DEFINER; the caller must be the project's ACTIVE owner or an
--      org controller; the recipient must be an ACTIVE member of the
--      project's org (a readable refusal otherwise); moves owner_user_id,
--      makes the recipient the roster 'owner', demotes the previous owner to
--      'collaborator', writes the feed row and the
--      PROJECT_OWNERSHIP_TRANSFERRED audit row — one transaction. EXECUTE is
--      revoked from PUBLIC and anon, granted to authenticated.
--
-- WIDENING: section 5 lets a plain project owner do something the database
-- refused before (transfer ownership). Every other section narrows. DEC-30
-- inventories (aggregate counts only, captured BEFORE the transaction) come
-- back with the probes:
--   * SEC-2 blast radius: private projects carrying cost / quality rows, and
--     those rows — readable org-wide until this applies;
--   * SEC-9: projects whose owner is not an active member of their org;
--   * PM-8: project_documents rows whose org is not their project's org;
--     hand-attached ('manual') register rows (SEC-17 — informational: there
--     is no record of who attached them);
--   * PM-7 dw4: project_activity rows whose user_id is not an active member
--     of the project's org — surfaced for review, NEVER rewritten;
--   * PM-11: roster rows with role 'owner' whose user is not the project's
--     owner;
--   * PM-9: projects whose last_activity_at trails their newest feed row
--     (what the backfill advances).
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (a re-run is safe: every object is dropped / replaced first and the
-- temp table is dropped before it is rebuilt). The final SELECT is the only
-- result set shown — probe rows must read ok = true; inventory rows carry
-- ok NULL and a count in n.

-- ── DEC-30 inventory, captured BEFORE the transaction ───────────────────
DROP TABLE IF EXISTS pg_temp.prj_g_j8_rails_inventory;
CREATE TEMP TABLE prj_g_j8_rails_inventory AS
SELECT 'inventory (before): private projects carrying cost / quality rows (SEC-2 blast radius)' AS inventory,
       COUNT(*)::text AS n
  FROM projects p
 WHERE p.visibility = 'private'
   AND (EXISTS (SELECT 1 FROM change_orders x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM project_checklists x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM turnover_items x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM punch_items x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM project_parties x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM cost_accounts x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM cost_documents x WHERE x.project_id = p.id)
     OR EXISTS (SELECT 1 FROM cost_entries x WHERE x.project_id = p.id))
UNION ALL
SELECT 'inventory (before): cost / quality rows on private projects, readable org-wide today (SEC-2)',
       ((SELECT COUNT(*) FROM change_orders x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM project_checklists x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM checklist_items i JOIN project_checklists x ON x.id = i.checklist_id JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM turnover_items x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM punch_items x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM project_parties x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM cost_accounts x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM cost_documents x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private')
      + (SELECT COUNT(*) FROM cost_entries x JOIN projects p ON p.id = x.project_id WHERE p.visibility = 'private'))::text
UNION ALL
SELECT 'inventory (before): projects whose owner is not an active member of their org (SEC-9)', COUNT(*)::text
  FROM projects p
 WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p.org_id AND m.uid = p.owner_user_id AND m.status = 'active')
UNION ALL
SELECT 'inventory (before): project_documents rows whose org is not their project''s org (PM-8)', COUNT(*)::text
  FROM project_documents d JOIN projects p ON p.id = d.project_id
 WHERE d.org_id IS DISTINCT FROM p.org_id
UNION ALL
SELECT 'inventory (before): hand-attached (manual) project_documents rows — attacher unrecorded (SEC-17, informational)', COUNT(*)::text
  FROM project_documents WHERE source = 'manual'
UNION ALL
SELECT 'inventory (before): project_activity rows whose author is not an active member of the project''s org (PM-7 dw4 — review, never rewritten)', COUNT(*)::text
  FROM project_activity a JOIN projects p ON p.id = a.project_id
 WHERE a.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p.org_id AND m.uid = a.user_id AND m.status = 'active')
UNION ALL
SELECT 'inventory (before): roster rows with role owner whose user is not the project''s owner (PM-11)', COUNT(*)::text
  FROM project_members pm JOIN projects p ON p.id = pm.project_id
 WHERE pm.role = 'owner' AND pm.user_id IS DISTINCT FROM p.owner_user_id
UNION ALL
SELECT 'inventory (before): projects whose last_activity_at trails their newest feed row (PM-9 backfill scope)', COUNT(*)::text
  FROM projects p
 WHERE EXISTS (SELECT 1 FROM project_activity a WHERE a.project_id = p.id
                AND (p.last_activity_at IS NULL OR a.created_at > p.last_activity_at));

BEGIN;

-- ── 1. SEC-2: the controls and cost tables read through project visibility ──
DROP POLICY IF EXISTS change_orders_member_read ON change_orders;
CREATE POLICY change_orders_member_read ON change_orders FOR SELECT
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS project_checklists_member_read ON project_checklists;
CREATE POLICY project_checklists_member_read ON project_checklists FOR SELECT
  USING (project_visible_to_me(project_id));

-- checklist_items carries no project_id: it is visible when its checklist's
-- project is.
DROP POLICY IF EXISTS checklist_items_member_read ON checklist_items;
CREATE POLICY checklist_items_member_read ON checklist_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM project_checklists c
                  WHERE c.id = checklist_items.checklist_id AND project_visible_to_me(c.project_id)));

DROP POLICY IF EXISTS turnover_items_member_read ON turnover_items;
CREATE POLICY turnover_items_member_read ON turnover_items FOR SELECT
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS punch_items_member_read ON punch_items;
CREATE POLICY punch_items_member_read ON punch_items FOR SELECT
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS project_parties_select ON project_parties;
CREATE POLICY project_parties_select ON project_parties FOR SELECT
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS cost_accounts_select ON cost_accounts;
CREATE POLICY cost_accounts_select ON cost_accounts FOR SELECT
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS cost_documents_select ON cost_documents;
CREATE POLICY cost_documents_select ON cost_documents FOR SELECT
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS cost_entries_select ON cost_entries;
CREATE POLICY cost_entries_select ON cost_entries FOR SELECT
  USING (project_visible_to_me(project_id));

-- ── 2. SEC-9: an owner acts on the project only while an ACTIVE member ──────
-- Each predicate is 20260906's line kept verbatim plus ONE added AND line;
-- AND binds tighter than OR, so it reads: controller OR (owner AND active).
DROP POLICY IF EXISTS projects_update_owner ON projects;
CREATE POLICY projects_update_owner ON projects FOR UPDATE USING (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
  AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = projects.org_id AND m.uid = auth.uid() AND m.status = 'active')
) WITH CHECK (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
  AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = projects.org_id AND m.uid = auth.uid() AND m.status = 'active')
);
DROP POLICY IF EXISTS projects_delete_owner ON projects;
CREATE POLICY projects_delete_owner ON projects FOR DELETE USING (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
  AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = projects.org_id AND m.uid = auth.uid() AND m.status = 'active')
);

-- ── 3. PM-7 / PM-9 / PM-11: the project feed ────────────────────────────────
DROP POLICY IF EXISTS project_activity_insert ON project_activity;
CREATE POLICY project_activity_insert ON project_activity FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND org_id = project_org(project_id)
  AND project_visible_to_me(project_id)
  AND (type <> 'comment' OR is_org_controller(org_id) OR can_manage_project(project_id))
  AND (type NOT IN ('doc_added', 'doc_removed') OR is_org_controller(org_id) OR is_project_owner(project_id))
);

-- The author of a feed row is the session that wrote it.
CREATE OR REPLACE FUNCTION stamp_project_activity_author()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text;
BEGIN
  -- The service role (cron, the intake door) names its own actor.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT email INTO v_email FROM org_members WHERE uid = v_uid AND org_id = NEW.org_id LIMIT 1;
  NEW.user_id := v_uid;
  NEW.user_name := COALESCE(NULLIF(v_email, ''),
                            NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''));
  NEW.created_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_activity_stamp ON project_activity;
CREATE TRIGGER trg_project_activity_stamp
  BEFORE INSERT ON project_activity
  FOR EACH ROW
  EXECUTE FUNCTION stamp_project_activity_author();

-- Every author's activity moves the project up the list.
CREATE OR REPLACE FUNCTION touch_project_last_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE projects
     SET last_activity_at = COALESCE(NEW.created_at, NOW())
   WHERE id = NEW.project_id
     AND (last_activity_at IS NULL OR last_activity_at < COALESCE(NEW.created_at, NOW()));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_activity_touch_project ON project_activity;
CREATE TRIGGER trg_project_activity_touch_project
  AFTER INSERT ON project_activity
  FOR EACH ROW
  EXECUTE FUNCTION touch_project_last_activity();

-- PM-9 backfill: every project's sort key catches up with its newest row.
UPDATE projects p
   SET last_activity_at = a.newest
  FROM (SELECT project_id, MAX(created_at) AS newest FROM project_activity GROUP BY project_id) a
 WHERE a.project_id = p.id
   AND (p.last_activity_at IS NULL OR p.last_activity_at < a.newest);

-- ── 4. PM-8 / SEC-17: the document register ─────────────────────────────────
DROP POLICY IF EXISTS "project_documents_member_all" ON project_documents;

DROP POLICY IF EXISTS project_documents_select ON project_documents;
CREATE POLICY project_documents_select ON project_documents
  FOR SELECT TO authenticated
  USING (project_visible_to_me(project_id));

DROP POLICY IF EXISTS project_documents_insert ON project_documents;
CREATE POLICY project_documents_insert ON project_documents
  FOR INSERT TO authenticated
  WITH CHECK ((is_org_controller(org_id) OR is_project_owner(project_id))
              AND org_id = project_org(project_id));

DROP POLICY IF EXISTS project_documents_update ON project_documents;
CREATE POLICY project_documents_update ON project_documents
  FOR UPDATE TO authenticated
  USING (is_org_controller(org_id) OR is_project_owner(project_id))
  WITH CHECK ((is_org_controller(org_id) OR is_project_owner(project_id))
              AND org_id = project_org(project_id));

DROP POLICY IF EXISTS project_documents_delete ON project_documents;
CREATE POLICY project_documents_delete ON project_documents
  FOR DELETE TO authenticated
  USING (is_org_controller(org_id) OR is_project_owner(project_id));

-- The checkout trigger keeps linking a collaborator's checkout (definer), and
-- links only a session whose org is its project's org.
CREATE OR REPLACE FUNCTION checkouts_resync_project_documents()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.document_id IS NULL OR NEW.org_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF project_org(NEW.project_id) IS DISTINCT FROM NEW.org_id THEN
    RETURN NEW;
  END IF;
  INSERT INTO project_documents (org_id, project_id, document_id, first_seen_at, last_seen_at, source)
  VALUES (NEW.org_id, NEW.project_id, NEW.document_id, NOW(), NOW(), 'checkout')
  ON CONFLICT (project_id, document_id) DO UPDATE
    SET last_seen_at = NOW();
  RETURN NEW;
END$$;

-- ── 5. SEC-15: ownership moves through one audited RPC ──────────────────────
CREATE OR REPLACE FUNCTION transfer_project_ownership(p_project uuid, p_new_owner uuid, p_new_owner_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_proj         projects%ROWTYPE;
  v_target_email text;
  v_actor_email  text;
  v_name         text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sign in to transfer project ownership.';
  END IF;
  SELECT * INTO v_proj FROM projects WHERE id = p_project FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found.';
  END IF;
  IF NOT (is_org_controller(v_proj.org_id) OR user_owns_project(p_project)) THEN
    RAISE EXCEPTION 'Only the project owner or an Admin / Document Control can transfer ownership.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_new_owner IS NULL THEN
    RAISE EXCEPTION 'Choose the member who will own the project.';
  END IF;
  IF p_new_owner = v_proj.owner_user_id THEN
    RETURN jsonb_build_object('projectId', p_project, 'unchanged', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = v_proj.org_id AND uid = p_new_owner AND status = 'active') THEN
    RAISE EXCEPTION 'The new owner must be an active member of this workspace.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT email INTO v_target_email FROM org_members WHERE org_id = v_proj.org_id AND uid = p_new_owner LIMIT 1;
  SELECT email INTO v_actor_email FROM org_members WHERE org_id = v_proj.org_id AND uid = v_actor LIMIT 1;
  v_name := COALESCE(NULLIF(btrim(p_new_owner_name), ''), v_target_email, p_new_owner::text);

  UPDATE projects
     SET owner_user_id = p_new_owner, owner_user_name = v_name,
         updated_at = NOW(), updated_by = v_actor
   WHERE id = p_project;

  INSERT INTO project_members (project_id, user_id, user_name, user_email, role)
  VALUES (p_project, p_new_owner, v_name, v_target_email, 'owner')
  ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner';

  UPDATE project_members SET role = 'collaborator'
   WHERE project_id = p_project AND user_id = v_proj.owner_user_id AND role = 'owner';

  INSERT INTO project_activity (project_id, org_id, user_id, user_name, type, body, metadata)
  VALUES (p_project, v_proj.org_id, v_actor, v_actor_email, 'ownership_transferred',
          'Ownership transferred to ' || v_name,
          jsonb_build_object('from', v_proj.owner_user_id, 'to', p_new_owner));

  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  VALUES ('PROJECT_OWNERSHIP_TRANSFERRED', p_project::text, 'project', v_proj.org_id, v_actor, v_actor_email,
          jsonb_build_object('from', v_proj.owner_user_id, 'to', p_new_owner, 'path', 'transfer_project_ownership'));

  RETURN jsonb_build_object('projectId', p_project, 'from', v_proj.owner_user_id, 'to', p_new_owner);
END;
$$;

REVOKE ALL ON FUNCTION transfer_project_ownership(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION transfer_project_ownership(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION transfer_project_ownership(uuid, uuid, text) TO authenticated;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'SEC-2: all nine controls / cost read policies go through project_visible_to_me' AS check,
       (SELECT COUNT(*) = 9 FROM pg_policies
         WHERE schemaname = 'public' AND cmd = 'SELECT'
           AND (tablename::text, policyname::text) IN (('change_orders', 'change_orders_member_read'),
                                          ('project_checklists', 'project_checklists_member_read'),
                                          ('checklist_items', 'checklist_items_member_read'),
                                          ('turnover_items', 'turnover_items_member_read'),
                                          ('punch_items', 'punch_items_member_read'),
                                          ('project_parties', 'project_parties_select'),
                                          ('cost_accounts', 'cost_accounts_select'),
                                          ('cost_documents', 'cost_documents_select'),
                                          ('cost_entries', 'cost_entries_select'))
           AND qual LIKE '%project_visible_to_me(%'
           AND qual NOT LIKE '%org_members%') AS ok, NULL::text AS n
UNION ALL SELECT 'SEC-2: no SELECT or ALL policy on those nine tables still grants a bare org-membership read',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND cmd IN ('SELECT', 'ALL')
                      AND tablename IN ('change_orders', 'project_checklists', 'checklist_items', 'turnover_items', 'punch_items',
                                        'project_parties', 'cost_accounts', 'cost_documents', 'cost_entries')
                      AND qual LIKE '%org_members%'
                      AND qual NOT LIKE '%project_visible_to_me(%'
                      AND permissive = 'PERMISSIVE'), NULL
UNION ALL SELECT 'SEC-9: projects UPDATE and DELETE owner branches require an active org membership',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'projects'
           AND policyname IN ('projects_update_owner', 'projects_delete_owner')
           AND qual LIKE '%org_members%' AND qual LIKE '%active%'), NULL
UNION ALL SELECT 'SEC-9: the UPDATE WITH CHECK reads the new row''s owner (a raw hand-off by a plain owner stays refused)',
       (SELECT with_check LIKE '%owner_user_id%' AND with_check LIKE '%org_members%'
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects' AND policyname = 'projects_update_owner'), NULL
UNION ALL SELECT 'PM-7: project_activity_insert binds the author, the project''s org and its visibility — comments need a manager',
       (SELECT with_check LIKE '%auth.uid()%' AND with_check LIKE '%project_org(%'
               AND with_check LIKE '%project_visible_to_me(%' AND with_check LIKE '%can_manage_project(%'
               AND with_check LIKE '%is_project_owner(%'
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'project_activity' AND policyname = 'project_activity_insert'), NULL
UNION ALL SELECT 'PM-7: project_activity still has no UPDATE policy',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'project_activity' AND cmd IN ('UPDATE', 'ALL')), NULL
UNION ALL SELECT 'PM-7 / PM-9: the stamp (BEFORE INSERT) and touch (AFTER INSERT) triggers are installed',
       (SELECT COUNT(*) = 2 FROM pg_trigger
         WHERE tgrelid = 'public.project_activity'::regclass AND NOT tgisinternal
           AND tgname IN ('trg_project_activity_stamp', 'trg_project_activity_touch_project')), NULL
UNION ALL SELECT 'PM-9: no project''s last_activity_at trails its newest feed row',
       NOT EXISTS (SELECT 1 FROM projects p
                    WHERE EXISTS (SELECT 1 FROM project_activity a WHERE a.project_id = p.id
                                   AND (p.last_activity_at IS NULL OR a.created_at > p.last_activity_at))), NULL
UNION ALL SELECT 'PM-8: project_documents has no FOR ALL policy (project_documents_member_all dropped)',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'project_documents' AND cmd = 'ALL'), NULL
UNION ALL SELECT 'PM-8: project_documents has exactly its four per-verb policies',
       (SELECT COUNT(*) = 4 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'project_documents'
           AND policyname IN ('project_documents_select', 'project_documents_insert', 'project_documents_update', 'project_documents_delete')), NULL
UNION ALL SELECT 'PM-8: register writes need the owner or a controller, in the project''s own org',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'project_documents'
           AND policyname IN ('project_documents_insert', 'project_documents_update')
           AND with_check LIKE '%is_project_owner(%' AND with_check LIKE '%is_org_controller(%' AND with_check LIKE '%project_org(%'), NULL
UNION ALL SELECT 'SEC-2 / PM-8 / SEC-15: every function this file defines is SECURITY DEFINER with search_path pinned',
       (SELECT COUNT(*) = 4 FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname IN ('stamp_project_activity_author', 'touch_project_last_activity',
                           'checkouts_resync_project_documents', 'transfer_project_ownership')
           AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'), NULL
UNION ALL SELECT 'PM-8: the checkout resync links only a session whose org is its project''s org',
       (SELECT prosrc LIKE '%project_org(NEW.project_id) IS DISTINCT FROM NEW.org_id%'
          FROM pg_proc WHERE proname = 'checkouts_resync_project_documents' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT 'SEC-15: transfer_project_ownership is callable by a signed-in member, not by anon',
       has_function_privilege('authenticated', 'public.transfer_project_ownership(uuid, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.transfer_project_ownership(uuid, uuid, text)', 'EXECUTE'), NULL
UNION ALL SELECT 'SEC-15: the transfer refuses a recipient who is not an active member',
       (SELECT prosrc LIKE '%must be an active member of this workspace%' AND prosrc LIKE '%user_owns_project(p_project)%'
          FROM pg_proc WHERE proname = 'transfer_project_ownership' AND pronamespace = 'public'::regnamespace), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_j8_rails_inventory;
