-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 — DEC-17 (the two admin gates that were a
-- curtain over an open table), DEL-3 / DEC-9 (team ownership must not dangle),
-- DEC-21 (reviewer independence per library).
--
--   1. audit_logs: a RESTRICTIVE SELECT overlay. Members keep the document-,
--      project- and ticket-level history every surface shows them; the
--      org-level authority trail (capability policy changes, membership and
--      role changes, exports, org configuration) is readable only by the roles
--      the /admin/audit page itself claims — Admin, Manager, Supervisor,
--      DocCtrl, Auditor — by role COLLECTION. (A Viewer could previously pull
--      CAPABILITY_POLICY_CHANGED payloads straight from PostgREST.)
--   2. asset tables (assets, asset_types, asset_photos, asset_files,
--      plot_plans): RESTRICTIVE write overlays for the roles the assets page
--      claims — Admin, DocCtrl, Manager, Supervisor. Reads unchanged.
--   3. libraries.owner_team_id → teams(id) ON DELETE SET NULL, dangling
--      pointers nulled first (each one audited), so a deleted team can never
--      leave phantom team ownership.
--   4. enforce_document_publish_guard (body from 20261040) gains the DEC-21
--      independence clause inside the completion check.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Helper: does the caller hold ANY of the given roles in the org (collection-aware)?
CREATE OR REPLACE FUNCTION caller_holds_any_role(p_org uuid, p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active'
      AND (role = ANY(p_roles) OR roles && p_roles)
  );
$$;

-- ── 1. audit_logs: the org-level authority trail is admin-class only ────────
DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;
CREATE POLICY audit_logs_admin_trail ON audit_logs
  AS RESTRICTIVE FOR SELECT
  USING (
    caller_holds_any_role(org_id, ARRAY['Admin','Manager','Supervisor','DocCtrl','Auditor']::text[])
    OR NOT (
      COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
      OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
      OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
      OR action LIKE 'DATA_EXPORT%' OR action LIKE 'RESTORE_%' OR action LIKE 'PURGE_%'
    )
  );

-- ── 2. asset registry writes: the roles the page claims ─────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets','asset_types','asset_photos','asset_files','plot_plans'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write_roles_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (caller_holds_any_role(org_id, ARRAY[''Admin'',''DocCtrl'',''Manager'',''Supervisor'']::text[]))', t || '_write_roles_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write_roles_update', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE USING (caller_holds_any_role(org_id, ARRAY[''Admin'',''DocCtrl'',''Manager'',''Supervisor'']::text[])) WITH CHECK (caller_holds_any_role(org_id, ARRAY[''Admin'',''DocCtrl'',''Manager'',''Supervisor'']::text[]))', t || '_write_roles_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write_roles_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (caller_holds_any_role(org_id, ARRAY[''Admin'',''DocCtrl'',''Manager'',''Supervisor'']::text[]))', t || '_write_roles_delete', t);
  END LOOP;
END $$;

-- ── 3. team ownership cannot dangle ─────────────────────────────────────────
-- Null (and audit) any owner_team_id that points at a team that no longer
-- exists, then add the FK with ON DELETE SET NULL.
INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
SELECT 'OWNER_TEAM_CLEARED', l.id::text, 'library', l.org_id, NULL,
       jsonb_build_object('reason', 'dangling_team_pointer_repaired', 'teamId', l.owner_team_id)
FROM libraries l
WHERE l.owner_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = l.owner_team_id);
UPDATE libraries l SET owner_team_id = NULL
WHERE l.owner_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = l.owner_team_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'libraries_owner_team_id_fkey') THEN
    ALTER TABLE libraries
      ADD CONSTRAINT libraries_owner_team_id_fkey
      FOREIGN KEY (owner_team_id) REFERENCES teams(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 4. reviewer independence in the publish guard (body from 20261040) ──────
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor        uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_advancing    boolean;
  v_independent  integer;
  v_on_roster    boolean;
  v_require_ind  boolean;
  v_can_publish  boolean;
  v_has_hold     boolean;
  v_primary_reqs integer;
  v_signed       integer;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded');
  IF NOT v_advancing THEN
    RETURN NEW;
  END IF;

  -- Review gate (applies to ALL authenticated publishers, including Admin/DocCtrl):
  -- if the version being made current has a reviewer roster, every required sign-
  -- off must be in — and a sign-off only counts when it carries the reviewer's
  -- OWN e-signature for this draft (RG-1: a row born 'signed' is not an approval).
  IF NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    -- The version match tolerates a NULL on the SIGNATURE side only: legacy
    -- signatures predate the column being stamped, and the only ways to MINT
    -- a signed row now (rail 1 + rail 2) both require a strict match — so
    -- the tolerant branch is reachable only for pre-existing history.
    SELECT count(*) FILTER (WHERE s.slot = 'primary'),
           count(*) FILTER (WHERE s.status = 'signed'
                              AND s.signature_id IS NOT NULL
                              AND EXISTS (
                                SELECT 1 FROM e_signatures e
                                WHERE e.id = s.signature_id
                                  AND e.signer_user_id = s.reviewer_user_id
                                  AND e.org_id = s.org_id
                                  AND (e.document_version_id = s.document_version_id
                                       OR e.document_version_id IS NULL)
                              ))
      INTO v_primary_reqs, v_signed
      FROM document_review_signoffs s
     WHERE s.document_version_id = NEW.current_version_id;
    IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN
      RAISE EXCEPTION
        'This revision still has outstanding review sign-offs; complete the review before publishing.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- DEC-21: reviewer independence. When the publisher is themselves on the
    -- roster, at least one signed PRIMARY must be someone else. A per-library
    -- policy, ON by default wherever a roster is configured; a library opts
    -- out with review_control.requireIndependentReviewer = false.
    IF COALESCE(v_primary_reqs, 0) > 0 THEN
      SELECT EXISTS (SELECT 1 FROM document_review_signoffs s
                      WHERE s.document_version_id = NEW.current_version_id
                        AND s.reviewer_user_id = v_actor)
        INTO v_on_roster;
      IF v_on_roster THEN
        SELECT COALESCE((l.review_control->>'requireIndependentReviewer')::boolean, true)
          INTO v_require_ind FROM libraries l WHERE l.id = NEW.library_id;
        IF COALESCE(v_require_ind, true) THEN
          SELECT count(*) INTO v_independent
            FROM document_review_signoffs s
           WHERE s.document_version_id = NEW.current_version_id
             AND s.slot = 'primary' AND s.status = 'signed' AND s.signature_id IS NOT NULL
             AND s.reviewer_user_id <> v_actor;
          IF COALESCE(v_independent, 0) = 0 THEN
            RAISE EXCEPTION
              'Reviewer independence: you are on this revision''s review roster, so at least one other primary reviewer must sign before you can publish it.'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.
  -- v_actor IS auth.uid() here (service-role returned above), so the shared
  -- additive helper applies.
  IF is_org_controller(NEW.org_id) THEN
    RETURN NEW;
  END IF;

  -- Per-library publish authority OR the document's effective owner may publish.
  v_can_publish := user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)
                OR user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor);

  IF NOT v_can_publish THEN
    RAISE EXCEPTION
      'You do not have authority to publish revisions in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM document_holds h
     WHERE h.document_id = NEW.id AND h.released_at IS NULL
  ) INTO v_has_hold;
  IF v_has_hold THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before publishing a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;


COMMIT;

-- ── Verification (read-only) — expect true × 6 ──────────────────────────────
SELECT 'audit_logs admin-trail overlay installed (restrictive SELECT)' AS check,
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_logs'
                AND policyname = 'audit_logs_admin_trail' AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT') AS ok
UNION ALL
SELECT 'asset registry write overlays installed (3 per table, existing tables only)',
       (SELECT COUNT(*) = 3 * (SELECT COUNT(*) FROM (VALUES ('assets'),('asset_types'),('asset_photos'),('asset_files'),('plot_plans')) v(t)
                                 WHERE to_regclass('public.' || v.t) IS NOT NULL)
          FROM pg_policies WHERE policyname LIKE '%\_write\_roles\_%' AND permissive = 'RESTRICTIVE')
UNION ALL
SELECT 'libraries.owner_team_id references teams ON DELETE SET NULL',
       EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conname = 'libraries_owner_team_id_fkey' AND c.confdeltype = 'n')
UNION ALL
SELECT 'no dangling team pointers remain',
       NOT EXISTS (SELECT 1 FROM libraries l WHERE l.owner_team_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = l.owner_team_id))
UNION ALL
SELECT 'publish guard carries the independence clause and keeps DEC-2 + RG-1',
       (SELECT prosrc LIKE '%Reviewer independence%'
          AND prosrc LIKE '%requireIndependentReviewer%'
          AND prosrc LIKE '%is_org_controller(NEW.org_id)%'
          AND prosrc LIKE '%e.signer_user_id = s.reviewer_user_id%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard')
UNION ALL
SELECT 'search_path pinned on the guard and the role helper',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('enforce_document_publish_guard', 'caller_holds_any_role')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');

-- ── Inventory (read-only, aggregate) ────────────────────────────────────────
SELECT 'audit rows now admin-class only (org-level authority trail)' AS inventory, COUNT(*)::text AS n
FROM audit_logs
WHERE COALESCE(resource_type, '') IN ('org', 'member', 'team', 'capability_policy', 'org_configuration', 'export_destination')
   OR action LIKE 'CAPABILITY_%' OR action LIKE 'MEMBER_%' OR action LIKE 'ROLE_%'
   OR action LIKE 'EXPORT_%' OR action LIKE 'SECURITY_%' OR action LIKE 'TEAM_%'
UNION ALL
SELECT 'pending drafts where the only signed primary is the document''s owner (DEC-21 will bind)', COUNT(*)::text
FROM documents d
WHERE d.pending_version_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM document_review_signoffs s WHERE s.document_version_id = d.pending_version_id AND s.slot = 'primary')
  AND NOT EXISTS (SELECT 1 FROM document_review_signoffs s WHERE s.document_version_id = d.pending_version_id
                   AND s.slot = 'primary' AND s.status = 'signed' AND s.reviewer_user_id IS DISTINCT FROM d.owner_user_id);
